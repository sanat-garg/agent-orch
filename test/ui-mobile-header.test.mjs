// Phone header (#450, HIG navigation bar): boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) and opens a chat at
// 390×844 and 430×932 with touch. The header is one 44px row with at most 3 visible controls (sidebar, the title's view
// switcher, one action), nothing overflows sideways, the title's menu switches views and holds the repo link, and at
// 1280px the segmented control is back with a plain-text title. Skips when Chromium can't launch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'mobile-header-password';
let browser, skip = false;
try { browser = await chromium.launch({ env: { ...process.env, ...macChromiumEnv() } }); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-hdrui-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  // A GitHub origin (never contacted) so the repo link shows without `gh repo create`; an empty gh config keeps gh unlinked.
  const cwd = path.join(dataDir, 'p', 'a-project-with-a-really-long-folder-name-that-must-truncate');
  fs.mkdirSync(cwd, { recursive: true });
  execFileSync('git', ['init', '-q', cwd]);
  execFileSync('git', ['-C', cwd, 'remote', 'add', 'origin', 'https://github.com/example/header-test.git']);
  fs.mkdirSync(path.join(dataDir, 'gh'));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: 'c0', title: 'Chat 0', cwd, mode: 'chat',
    agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true }]));
  const port = await freePort();
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1',
    GH_CONFIG_DIR: path.join(dataDir, 'gh') }, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function open(viewport, touch = true) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport, isMobile: touch, hasTouch: touch, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  // A macOS head's Server details charts can't read load averages (renderMetrics): not the header's concern.
  page.on('pageerror', (e) => { if (!/renderMetrics/.test(e.stack)) errors.push(e.message); });
  await page.goto(`${base}/#c0`);
  await page.locator('#app:not([inert]) #input').waitFor();
  await page.waitForFunction(() => !document.getElementById('repoLink').hidden);
  return { ctx, page, errors };
}

// The header's on-screen interactive controls, its box and how far anything sticks out sideways.
const header = (page) => page.evaluate(() => {
  const bar = document.querySelector('header.topbar');
  const shown = (n) => { const r = n.getBoundingClientRect(); const cs = getComputedStyle(n); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !n.closest('[hidden]'); };
  const controls = [...bar.querySelectorAll('button, a[href], a[id], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])')]
    .filter((n) => shown(n) && !n.closest('#viewMenu'))
    .map((n) => { const r = n.getBoundingClientRect(); return { id: n.id || n.className, left: r.left, right: r.right, w: r.width, h: r.height, disabled: !!n.disabled }; });
  const r = bar.getBoundingClientRect();
  return { controls, height: r.height, barOverflow: bar.scrollWidth - bar.clientWidth, docOverflow: document.documentElement.scrollWidth - innerWidth,
    width: innerWidth, title: document.getElementById('title').getBoundingClientRect(), view: document.getElementById('app').dataset.view };
});

for (const viewport of [{ width: 390, height: 844 }, { width: 430, height: 932 }]) {
  test(`${viewport.width}px: one 44px row, at most 3 controls, no horizontal overflow`, { skip, timeout: 60000 }, async () => {
    const { ctx, page, errors } = await open(viewport);
    const h = await header(page);
    assert.ok(h.controls.length <= 3, `at most 3 header controls: ${JSON.stringify(h.controls.map((c) => c.id))}`);
    assert.deepEqual(h.controls.map((c) => c.id), ['openSidebar', 'viewBtn', 'topAction'], 'sidebar, title menu, one action');
    assert.equal(h.height, 44, 'a 44pt bar (no safe-area inset here)');
    for (const c of h.controls) {
      assert.ok(c.h >= 44 && (c.id === 'viewBtn' || c.w >= 44), `${c.id} is a 44pt target: ${c.w}×${c.h}`);
      assert.ok(c.left >= 0 && c.right <= h.width, `${c.id} is on screen: ${c.left}–${c.right}`);
      assert.equal(c.disabled, false, `${c.id} is enabled`);
    }
    assert.ok(h.barOverflow <= 0 && h.docOverflow <= 0, `no horizontal overflow: bar ${h.barOverflow}, page ${h.docOverflow}`);
    assert.ok(h.title.right <= h.width && Math.abs((h.title.left + h.title.right) / 2 - h.width / 2) < 60, `the title is centred and truncated: ${JSON.stringify(h.title)}`);
    for (const sel of ['.topbar .seg', '#cwdLabel', '#repoLink']) assert.equal(await page.locator(sel).isVisible(), false, `${sel} is not in the phone header`);
    await ctx.close();
    assert.deepEqual(errors, []);
  });
}

test('390px: the title opens the view switcher, which switches views and holds the repo link', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  const menu = page.locator('#viewMenu');
  await page.locator('#viewBtn').tap();
  await menu.waitFor();
  assert.equal(await page.locator('#viewBtn').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(await menu.locator('[role="menuitemradio"]').allTextContents(), ['Chat', 'Files', 'Terminal', 'Browser']);
  assert.equal(await menu.locator('[aria-checked="true"]').textContent(), 'Chat');
  assert.equal(await page.locator('#viewMenuRepo').textContent(), 'header-test', 'the overflow has the repo link');
  const box = await menu.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, `the menu fits the screen: ${JSON.stringify(box)}`);
  for (const b of await menu.locator('button:visible').all()) assert.ok((await b.boundingBox()).height >= 44, '44pt rows');

  await menu.locator('[data-view="files"]').tap();
  await menu.waitFor({ state: 'hidden' });
  let h = await header(page);
  assert.equal(h.view, 'files');
  assert.equal(await page.locator('#filesView').isVisible(), true);
  assert.equal(await page.locator('#viewBtn').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(h.controls.map((c) => c.id), ['openSidebar', 'viewBtn'], 'no chat action in Files');
  assert.ok(h.docOverflow <= 0, `no horizontal overflow in Files: ${h.docOverflow}`);

  // A tap outside and Escape both close it without switching.
  await page.locator('#viewBtn').tap();
  await menu.waitFor();
  assert.equal(await menu.locator('[aria-checked="true"]').textContent(), 'Files');
  await page.mouse.click(200, 700);
  await menu.waitFor({ state: 'hidden' });
  await page.locator('#viewBtn').tap();
  await menu.waitFor();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  assert.equal((await header(page)).view, 'files');

  await page.locator('#viewBtn').tap();
  await menu.locator('[data-view="chat"]').tap();
  h = await header(page);
  assert.equal(h.view, 'chat');
  assert.equal(await page.locator('#chatView').isVisible(), true);
  assert.deepEqual(h.controls.map((c) => c.id), ['openSidebar', 'viewBtn', 'topAction']);

  // The one action starts a new project, like the sidebar's button.
  await page.locator('#topAction').tap();
  await page.waitForFunction(() => document.getElementById('title').textContent === 'New chat');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('1280px: the desktop header keeps the segmented control and a plain-text title', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 1280, height: 800 }, false);
  assert.equal(await page.locator('.topbar .seg').isVisible(), true);
  assert.equal(await page.locator('#repoLink').isVisible(), true);
  assert.equal(await page.locator('#viewBtn').isDisabled(), true, 'the title is not a control');
  assert.equal(await page.locator('#viewBtn .chev').isVisible(), false);
  assert.equal(await page.locator('#topAction').isVisible(), false);
  assert.equal((await header(page)).height, 56);
  await ctx.close();
  assert.deepEqual(errors, []);
});
