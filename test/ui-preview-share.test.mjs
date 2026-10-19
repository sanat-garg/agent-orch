// Copy link / Share on live preview cards and the inspector bar (public/previews.js): the same boot as ui-previews.test.mjs
// (server.mjs with CW_NO_ORCHESTRATOR=1, a temp data dir, one project with an address). navigator.clipboard and
// navigator.share are stubbed per context (an init script), so the checks are deterministic without OS permissions:
// Copy link writes the preview URL and toasts "Link copied" (card and inspector), a failed copy toasts the error, Share is
// absent without navigator.share and calls it with the project name and URL when present (a cancel stays silent), and the
// icons are 44pt on a phone. Skips when Playwright's Chromium can't launch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'preview-share-password';
const URL = 'https://demo-site.greygoose.baby';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pvshare-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const proj = path.join(dataDir, 'p', 'demo'), other = path.join(dataDir, 'p', 'notes');
  fs.mkdirSync(proj, { recursive: true }); fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([
    { id: 'c0', title: 'Demo', cwd: proj, mode: 'bypassPermissions', model: '', createdAt: 1, updatedAt: 2, repo: { full: 'me/demo', url: 'https://github.com/me/demo' } },
    { id: 'c1', title: 'Notes', cwd: other, mode: 'bypassPermissions', model: '', createdAt: 1, updatedAt: 1 },
  ]));
  fs.writeFileSync(path.join(dataDir, 'previews.json'), JSON.stringify({ domains: ['greygoose.baby'],
    entries: { [proj]: { slug: 'demo-site', domain: 'greygoose.baby', port: 4990 } } }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// A stub clipboard that records writes (window.__copied) or rejects (window.__copyFail), and optionally a navigator.share
// stub that records its argument (window.__shared) or rejects with window.__shareError's name.
const STUBS = `
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => {
    if (window.__copyFail) return Promise.reject(new Error('denied'));
    window.__copied = t; return Promise.resolve();
  } } });
  document.execCommand = () => false;
  if (window.__withShare) Object.defineProperty(navigator, 'share', { configurable: true, value: (data) => {
    window.__shared = data;
    if (window.__shareError) { const e = new Error(window.__shareError); e.name = window.__shareError; return Promise.reject(e); }
    return Promise.resolve();
  } });`;
async function open({ mobile = false, share = false } = {}) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript(`window.__withShare = ${share}; ${STUBS}`);
  await ctx.route(`${URL}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>demo</p>' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/`);
  await page.locator('#app:not([inert])').waitFor();
  if (mobile) await page.locator('#openSidebar').click();
  await page.locator('#previewsBtn').click();
  await page.locator('#pvBody .pv-row[data-cid="c0"]').waitFor();
  return { ctx, page, errors };
}
const clearToasts = (page) => page.locator('.toast').evaluateAll((ts) => ts.forEach((t) => t.remove()));

test('Copy link writes the preview URL to the clipboard and toasts; a failed copy toasts the error; no Share without navigator.share', { skip }, async () => {
  const { ctx, page, errors } = await open();
  try {
    const demo = page.locator('.pv-row[data-cid="c0"]');
    const copy = demo.locator('.pv-ico.copy');
    assert.equal(await copy.getAttribute('aria-label'), 'Copy link');
    assert.equal(await copy.getAttribute('title'), 'Copy link');
    assert.equal(await demo.locator('.pv-ico.share').count(), 0, 'no Share button without navigator.share');
    // A project without an address has neither button.
    assert.equal(await page.locator('.pv-item[data-cid="c1"] .pv-ico').count(), 0);
    await copy.click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Link copied'));
    assert.equal(await page.evaluate(() => window.__copied), URL);
    await clearToasts(page);
    // The icon sits in the row's head but doesn't unfold it; the chevron does, and the five text actions are untouched.
    assert.equal(await demo.locator('.pv-chev').getAttribute('aria-expanded'), 'false');
    await demo.locator('.pv-chev').click();
    assert.deepEqual(await demo.locator('.pv-act').allTextContents(), ['Open', 'Inspect', 'Restart', 'Logs', 'Edit']);
    // The inspector bar: Copy link next to Open in new tab.
    await demo.locator('.pv-act', { hasText: 'Inspect' }).click();
    const insp = page.locator('#pvInspect');
    await insp.waitFor();
    const bar = insp.locator('.pvi-bar');
    assert.equal(await bar.locator('.pvi-copy + .pvi-tab').count(), 1, 'Copy link sits next to Open in new tab');
    await page.evaluate(() => { window.__copied = null; });
    await bar.locator('.pvi-copy', { hasText: 'Copy link' }).click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Link copied'));
    assert.equal(await page.evaluate(() => window.__copied), URL);
    await clearToasts(page);
    await page.keyboard.press('Escape');
    assert.equal(await insp.count(), 0);
    // The clipboard refuses (and the execCommand fallback fails): an error toast, nothing copied.
    await page.evaluate(() => { window.__copyFail = true; window.__copied = null; });
    await copy.click();
    await page.waitForFunction(() => document.querySelector('.toast.toast-error')?.textContent.includes("Couldn't copy the link"));
    assert.equal(await page.evaluate(() => window.__copied), null);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('Share (phone with navigator.share) calls it with the project name and URL; a cancel is silent, another error toasts', { skip }, async () => {
  const { ctx, page, errors } = await open({ mobile: true, share: true });
  try {
    const demo = page.locator('.pv-row[data-cid="c0"]');
    const share = demo.locator('.pv-ico.share');
    assert.equal(await share.getAttribute('aria-label'), 'Share');
    await share.click();
    await page.waitForFunction(() => window.__shared);
    const name = await demo.locator('.pv-name').textContent(); // the card's project name (title, else the folder)
    assert.deepEqual(await page.evaluate(() => window.__shared), { title: name, url: URL });
    assert.equal(await page.locator('.toast').count(), 0, 'a successful share needs no toast');
    // The owner dismisses the share sheet: nothing said.
    await page.evaluate(() => { window.__shareError = 'AbortError'; window.__shared = null; });
    await share.click();
    await page.waitForFunction(() => window.__shared);
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.toast').count(), 0, 'AbortError is silent');
    // Any other failure is reported.
    await page.evaluate(() => { window.__shareError = 'NotAllowedError'; window.__shared = null; });
    await share.click();
    await page.waitForFunction(() => document.querySelector('.toast.toast-error'));
    // 44pt targets on the phone, and nothing sticks out sideways.
    const small = await page.evaluate(() => [...document.querySelectorAll('#pvBody .pv-ico')].filter((n) => n.getBoundingClientRect().height < 44 || n.getBoundingClientRect().width < 44).length);
    assert.equal(small, 0);
    const overflow = await page.evaluate(() => [...document.querySelectorAll('#pvBody *')].filter((n) => n.getBoundingClientRect().right > innerWidth + 1).map((n) => n.className));
    assert.deepEqual(overflow, []);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
