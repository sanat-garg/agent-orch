// Live preview inspector (public/previews.js openInspector): boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir, no
// previews.json, so no preview starts and Caddy is never touched) with two projects. GET /api/previews is mocked with one
// address pointing at a localhost fixture page, so nothing leaves 127.0.0.1. Checks the iframe loads only after Inspect,
// keeps the chosen CSS viewport width (390/768/1280) while scaled to fit, keeps the fallback note and Open in new tab, unloads
// on close, and that a project without an address gets no Inspect. Desktop and a 390px phone. Skips without Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'preview-inspector-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, fixture, fixtureUrl;
const hits = [];

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  // The "preview": a page that prints its own CSS viewport width.
  fixture = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><meta name="viewport" content="width=device-width"><body><p id="w"></p>'
      + '<script>const w = () => { document.getElementById("w").textContent = String(innerWidth); }; w(); addEventListener("resize", w);</script>');
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pvi-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const proj = path.join(dataDir, 'p', 'demo'), other = path.join(dataDir, 'p', 'notes');
  fs.mkdirSync(proj, { recursive: true }); fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([
    { id: 'c0', title: 'Demo', cwd: proj, mode: 'bypassPermissions', model: '', createdAt: 1, updatedAt: 2 },
    { id: 'c1', title: 'Notes', cwd: other, mode: 'bypassPermissions', model: '', createdAt: 1, updatedAt: 1 },
  ]));
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
  fixture?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(mobile) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Mocked preview data: only Demo has an address, and it is the localhost fixture.
  await page.route('**/api/previews', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    domains: [{ domain: 'greygoose.baby', previews: 1 }],
    previews: [{ cid: 'c0', title: 'Demo', slug: 'demo-site', domain: 'greygoose.baby', url: fixtureUrl, status: 'running' }],
  }) }));
  await page.goto(`${base}/`);
  await page.locator('#app:not([inert])').waitFor();
  if (mobile) await page.locator('#openSidebar').click();
  await page.locator('#previewsBtn').click();
  await page.locator('#pvBody .pv-row[data-cid="c0"]').waitFor();
  return { ctx, page, errors };
}

const frameWidth = (page) => page.frameLocator('#pvInspect iframe').locator('#w').textContent();

test('Inspect: loads only on click, keeps each CSS width while scaled to fit, unloads on close (desktop and 390px phone)', { skip }, async () => {
  for (const mobile of [false, true]) {
    const { ctx, page, errors } = await open(mobile);
    try {
      hits.length = 0;
      const demo = page.locator('.pv-row[data-cid="c0"]');
      assert.deepEqual(await demo.locator('.pv-act').allTextContents(), ['Open', 'Inspect', 'Restart', 'Logs', 'Edit']);
      assert.equal(await page.locator('#pvInspect').count(), 0);
      assert.equal(await page.locator('iframe').count(), 0, 'no iframe before Inspect');
      assert.deepEqual(hits, [], 'nothing loaded before Inspect');
      await demo.locator('.pv-act', { hasText: 'Inspect' }).click();
      const insp = page.locator('#pvInspect');
      await insp.waitFor();
      assert.equal(await insp.locator('iframe').getAttribute('src'), fixtureUrl, 'only the configured address');
      assert.match(await insp.locator('.m-sub').textContent(), /not full device emulation/i);
      // The fallback stays visible whatever the load event says.
      const note = insp.locator('.pvi-note');
      assert.equal(await note.isVisible(), true);
      assert.match(await note.textContent(), /refuse/);
      const tab = insp.locator('a', { hasText: 'Open in new tab' });
      assert.equal(await tab.getAttribute('href'), fixtureUrl);
      assert.equal(await tab.getAttribute('target'), '_blank');
      assert.deepEqual(await insp.locator('.pvi-widths button').allTextContents(), ['Phone 390', 'Tablet 768', 'Desktop 1280']);
      for (const w of [390, 768, 1280, 390]) {
        const btn = insp.locator(`.pvi-widths button[data-w="${w}"]`);
        await btn.click();
        assert.equal(await btn.getAttribute('aria-pressed'), 'true');
        assert.equal(await insp.locator('.pvi-widths button[aria-pressed="true"]').count(), 1);
        await assert.doesNotReject(page.frameLocator('#pvInspect iframe').locator('#w', { hasText: String(w) }).waitFor({ timeout: 5000 }));
        assert.equal(await frameWidth(page), String(w), `CSS viewport is ${w}px`);
        // Scaled to fit: the frame's box never spills out of the stage, and is shrunk only when it has to be.
        const { stage, box } = await page.evaluate(() => {
          const r = (s) => document.querySelector(s).getBoundingClientRect();
          return { stage: r('#pvInspect .pvi-stage'), box: r('#pvInspect iframe') };
        });
        assert.ok(box.width <= stage.width + 1 && box.left >= stage.left - 1 && box.right <= stage.right + 1, `fits at ${w}: ${JSON.stringify({ stage, box })}`);
        assert.ok(box.bottom <= stage.bottom + 1, `fits vertically at ${w}`);
        if (w <= stage.width) assert.ok(Math.abs(box.width - w) <= 1, `${w}px shown 1:1`);
        else assert.ok(Math.abs(box.width - stage.width) <= 1, `${w}px scaled to the stage`);
        assert.match(await insp.locator('.pvi-size').textContent(), new RegExp(`^${w} × \\d+ CSS px`));
      }
      assert.ok(hits.length >= 1, 'the fixture was requested after Inspect');
      // Escape closes the inspector first (not the sheet); the iframe is gone.
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#pvInspect').count(), 0);
      assert.equal(await page.locator('iframe').count(), 0, 'iframe unloaded');
      assert.equal(await page.locator('#previewsModal').isVisible(), true);
      // Reopen, then the close button.
      await demo.locator('.pv-act', { hasText: 'Inspect' }).click();
      await insp.waitFor();
      await insp.locator('button[aria-label="Close"]').click();
      assert.equal(await page.locator('iframe').count(), 0);
      if (!mobile) assert.equal(await demo.locator('.pv-act.inspect').evaluate((n) => n === document.activeElement), true, 'focus back on Inspect');
      if (mobile) {
        const small = await page.evaluate(() => [...document.querySelectorAll('#pvBody .pv-act')].filter((n) => n.getBoundingClientRect().height < 44).map((n) => n.textContent));
        assert.deepEqual(small, [], `44pt targets: ${small}`);
      }
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  }
});

test('a project without an address gets no Inspect action', { skip }, async () => {
  const { ctx, page, errors } = await open(false);
  try {
    const notes = page.locator('.pv-item[data-cid="c1"]');
    await notes.waitFor();
    assert.equal(await notes.locator('.pv-act').count(), 0);
    assert.equal(await page.locator('#pvBody button', { hasText: 'Inspect' }).count(), 1, 'only the project with an address');
    assert.equal(await page.locator('iframe').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
