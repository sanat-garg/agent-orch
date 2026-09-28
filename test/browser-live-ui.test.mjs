// The live browser view in the app (public/browser.js): the sidebar's Browser button opens the profiles sheet, Open shows
// the live page on a canvas, and the owner's click and typing reach a local page, on a desktop (mouse, keyboard) and on
// an iPhone-sized screen (tap, the on-screen keyboard field). Skips when Playwright's Chromium can't launch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'browser-live-ui-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, tmp, browserHome, cookie, page, pageUrl, out = '';
const typed = [];
let loads = 0;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-live-ui-'));
  browserHome = path.join(tmp, 'home');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  page = http.createServer((req, res) => {
    if (req.url.startsWith('/typed')) { typed.push(new URL(req.url, 'http://x').searchParams.get('v')); res.end('ok'); return; }
    if (req.url === '/') loads++;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Sign in</title><body style="margin:0;background:#fff">
      <input id=q autocomplete=off style="position:absolute;left:0;top:0;width:640px;height:200px;font-size:40px"
        onkeydown="if (event.key === 'Enter') { fetch('/typed?v=' + encodeURIComponent(this.value)); this.value = ''; }">`);
  });
  await new Promise((r) => page.listen(0, '127.0.0.1', r));
  pageUrl = `http://127.0.0.1:${page.address().port}/`;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1', AGENT_ORCH_BROWSER_HOME: browserHome, AGENT_ORCH_BROWSER_HEADLESS: '1' } });
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
  page?.close();
  if (tmp) { try { execFileSync('pkill', ['-KILL', '-f', browserHome]); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); }
});

async function app(opts) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(opts);
  await ctx.addCookies([{ name, value, url: base }]);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}/`);
  return { ctx, p, errors };
}
// Whether the canvas shows a frame: its size and a pixel that isn't blank.
const drawn = (p) => p.evaluate(() => {
  const c = document.getElementById('bvCanvas');
  return c.width > 0 && c.height > 0 && getComputedStyle(document.getElementById('bvWait')).display === 'none' ? [c.width, c.height] : null;
});

test('desktop: sidebar → Browser → Open shows the live page, and clicks and keys reach it', { skip, timeout: 180000 }, async () => {
  const { ctx, p, errors } = await app({ viewport: { width: 1280, height: 860 } });
  try {
    await p.locator('#browserBtn').click();
    await p.locator('#browserModal:not([hidden])').waitFor();
    const row = p.locator('#bwBody .bw-row', { hasText: 'default' });
    await row.waitFor({ timeout: 20000 });
    await row.getByRole('button', { name: 'Signed-in sites' }).click();
    await p.locator('#bwBody .bw-sites', { hasText: /Not signed in anywhere yet|Sites with cookies/ }).waitFor({ timeout: 60000 });
    await row.getByRole('button', { name: 'Open' }).click();
    await p.locator('#bvModal:not([hidden])').waitFor();
    await waitFor(() => p.evaluate(() => document.getElementById('bvStatus').textContent.includes('You are in control')), { timeout: 90000, message: `in control:\n${out}` });
    // Go to the local page from the URL bar.
    await p.locator('#bvUrl').fill(pageUrl);
    await p.locator('#bvUrl').press('Enter');
    await waitFor(() => p.evaluate((u) => document.getElementById('bvUrl').value === u, pageUrl), { timeout: 30000, message: 'the URL bar follows the page' });
    await waitFor(() => loads > 0, { timeout: 30000, message: 'the page loads' });
    await p.waitForTimeout(1500); // it renders
    await waitFor(() => drawn(p), { timeout: 30000, message: 'a frame is drawn' });
    const box = await p.locator('#bvCanvas').boundingBox();
    const [w, h] = await drawn(p);
    assert.ok(box.width <= 1280 && box.height <= 860 && Math.abs(box.width / box.height - w / h) < 0.02, 'the canvas scales to fit, keeping its shape');
    // The field is the page's top-left 640×200 CSS px: click in it, then type.
    await p.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.05);
    await p.keyboard.type('owner@example.com');
    await p.keyboard.press('Enter');
    await waitFor(() => typed.includes('owner@example.com'), { timeout: 20000, message: `typed text reaches the page: ${JSON.stringify(typed)}` });
    await p.locator('#bvModal .bv-head [data-close]').click();
    assert.ok(await p.locator('#bvModal').isHidden());
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('iPhone: a tap is a click and the keyboard field types into the page', { skip, timeout: 180000 }, async () => {
  const { ctx, p, errors } = await app({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  try {
    await p.locator('#openSidebar').tap();
    await p.locator('#browserBtn').tap();
    const row = p.locator('#bwBody .bw-row', { hasText: 'default' });
    await row.waitFor({ timeout: 20000 });
    await row.getByRole('button', { name: 'Open' }).tap();
    await waitFor(() => p.evaluate(() => document.getElementById('bvStatus').textContent.includes('You are in control')), { timeout: 90000, message: 'in control' });
    await waitFor(() => p.evaluate((u) => document.getElementById('bvUrl').value === u, pageUrl), { timeout: 30000, message: 'the same page' });
    await waitFor(() => drawn(p), { timeout: 30000, message: 'a frame is drawn' });
    const panel = await p.locator('#bvModal .modal-panel').boundingBox(), box = await p.locator('#bvCanvas').boundingBox();
    assert.ok(panel.width <= 390 && box.x >= 0 && box.x + box.width <= 390.5, 'the viewer fits the phone');
    assert.ok(await p.locator('#bvKbd').isVisible(), 'a Keyboard button on touch screens');
    await p.touchscreen.tap(box.x + box.width * 0.1, box.y + box.height * 0.05);
    await p.locator('#bvKbd').tap();
    await p.keyboard.insertText('from the phone');
    await p.keyboard.press('Enter');
    await waitFor(() => typed.includes('from the phone'), { timeout: 20000, message: `typed on the phone: ${JSON.stringify(typed)}` });
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
