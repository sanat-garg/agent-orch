// The Browser tab end to end, with the server's real Chromium (browser-live.mjs) and a real app page: the tab loads, a
// non-blank frame arrives within 15 s, the URL bar shows the home page (google.com; a local page when Google can't be
// reached, via AGENT_ORCH_BROWSER_HOME_URL), the page is laid out for the canvas's area (resizing the window to 390×844
// makes it a phone: its width, touch and a mobile user agent), the canvas fills the stage without letterboxing, and a
// click lands on the right page coordinates. Saves desktop and phone screenshots into .agent-orch/shots/. Skips only
// when this machine has no Chromium or Chrome at all.
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
import { findBrowser } from '../browser.mjs';
import { waitFor } from './helpers/wait.mjs';
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, '.agent-orch', 'shots');
const PASSWORD = 'browser-live-e2e-password';
const macEnv = macChromiumEnv(); // Chromium on the MacBook worker's LaunchDaemon needs a shim (helpers/mac-chromium.mjs)
const skip = !findBrowser() && 'no Chromium or Chrome on this machine';
let browser, child, base, tmp, browserHome, cookie, page, pageUrl, homeUrl, out = '';
const reports = []; // what the test page saw: {kind: 'size'|'click', ...}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const google = async () => { try { return (await fetch('https://www.google.com/', { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; } };

before(async () => {
  if (skip) return;
  // Playwright's own Chromium when it is installed, else the one the server uses.
  const launchEnv = { ...process.env, ...macEnv };
  browser = await chromium.launch({ env: launchEnv }).catch(() => chromium.launch({ env: launchEnv, executablePath: findBrowser({ env: launchEnv }) }));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-live-e2e-'));
  browserHome = path.join(tmp, 'home');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  // The test page: a coloured grid (never a blank frame) that reports its layout size, touch, user agent and clicks.
  page = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/report') { reports.push(Object.fromEntries(u.searchParams)); res.end('ok'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Live e2e</title>
      <body style="margin:0;height:100vh;background:repeating-linear-gradient(45deg,#1e6fd9 0 40px,#f2c230 40px 80px)">
      <h1 style="margin:0;padding:12px;font:bold 28px sans-serif;background:#fff">Live e2e</h1>
      <script>
        const r = (q) => fetch('/report?' + new URLSearchParams(q));
        const size = () => r({ kind: 'size', w: innerWidth, h: innerHeight, dpr: devicePixelRatio, touch: navigator.maxTouchPoints, mobile: /Mobile/.test(navigator.userAgent) });
        addEventListener('load', size);
        addEventListener('resize', size);
        addEventListener('click', (e) => r({ kind: 'click', x: e.clientX, y: e.clientY }));
      </script>`);
  });
  await new Promise((r) => page.listen(0, '127.0.0.1', r));
  pageUrl = `http://127.0.0.1:${page.address().port}/`;
  // google.com is the home page; a machine that can't reach it opens the test page instead.
  const env = { ...process.env, ...macEnv };
  delete env.AGENT_ORCH_BROWSER_HOME_URL;
  if (!(await google())) env.AGENT_ORCH_BROWSER_HOME_URL = pageUrl;
  homeUrl = env.AGENT_ORCH_BROWSER_HOME_URL || 'https://www.google.com/';
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1', AGENT_ORCH_BROWSER_HOME: browserHome, AGENT_ORCH_BROWSER_HEADLESS: '1' } });
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
  const errors = [], sizes = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('websocket', (ws) => ws.on('framesent', (f) => { const s = String(f.payload); if (s.includes('"bv_size"') || s.includes('"bv_open"')) sizes.push(JSON.parse(s)); }));
  await p.goto(`${base}/`);
  return { ctx, p, errors, sizes };
}
// The canvas's frame when it shows a non-blank page (more than one colour), else null.
const frame = (p) => p.evaluate(() => {
  const c = document.getElementById('bxCanvas');
  if (!c.width || !c.height || getComputedStyle(document.getElementById('bxWait')).display !== 'none') return null;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, seen = new Set();
  for (let i = 0; i < d.length && seen.size < 3; i += 4 * 97) seen.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
  return seen.size > 1 ? { w: BV.frame.w, h: BV.frame.h, px: [c.width, c.height] } : null;
});
const inControl = (p) => p.evaluate(() => document.getElementById('bxStatus').textContent.includes('You are in control'));
const area = (p) => p.evaluate(() => bvArea(BVM.tab));
const lastSize = () => reports.filter((r) => r.kind === 'size').at(-1);
// Clicks the canvas where the page's CSS point (x, y) is shown; resolves to what the page saw.
async function clickAt(p, x, y, tap = false) {
  const box = await p.locator('#bxCanvas').boundingBox(), f = await p.evaluate(() => BV.frame);
  const n = reports.length;
  const cx = box.x + (x / f.w) * box.width, cy = box.y + (y / f.h) * box.height;
  if (tap) await p.touchscreen.tap(cx, cy); else await p.mouse.click(cx, cy);
  await waitFor(() => reports.slice(n).some((r) => r.kind === 'click'), { timeout: 15000, message: `the click reaches the page:\n${out.slice(-2000)}` });
  const c = reports.slice(n).find((r) => r.kind === 'click');
  return { x: Number(c.x), y: Number(c.y) };
}
// The canvas fills the area the page was laid out for: no letterboxing.
async function fills(p) {
  const box = await p.locator('#bxCanvas').boundingBox(), a = await area(p);
  assert.ok(Math.abs(box.width - 2 - a.width) <= 2 && Math.abs(box.height - 2 - a.height) <= 2, `the canvas fills the stage: ${JSON.stringify({ box, a })}`);
}

test('the Browser tab streams the home page, lays it out for the screen and maps clicks', { skip, timeout: 240000 }, async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { ctx, p, errors, sizes } = await app({ viewport: { width: 1280, height: 800 } });
  try {
    const t0 = Date.now();
    await p.locator('.seg [data-view="browser"]').click();
    await waitFor(() => frame(p), { timeout: 15000, message: `a non-blank frame within 15 s:\n${out.slice(-3000)}` });
    const ms = Date.now() - t0;
    assert.ok(await inControl(p), 'the owner drives their own view');
    await waitFor(() => p.evaluate((h) => document.getElementById('bxUrl').value === h, homeUrl), { timeout: 30000, message: 'the URL bar shows the home page' });
    if (!process.env.AGENT_ORCH_BROWSER_HOME_URL && homeUrl.includes('google.com')) assert.match(await p.locator('#bxUrl').inputValue(), /google\.com/);
    const open = sizes.find((m) => m.t === 'bv_open');
    assert.ok(open.size?.width >= 120 && open.size.height >= 120 && open.size.dpr >= 1, `the viewer sends its canvas area with bv_open: ${JSON.stringify(open)}`);
    await p.waitForTimeout(1500); // the home page renders
    await p.screenshot({ path: path.join(SHOTS, 'browser-tab-desktop.png') });
    console.log(`# first frame after ${ms} ms; desktop shot saved`);

    // The test page: laid out for the canvas's area on a desktop.
    await p.locator('#bxUrl').fill(pageUrl);
    await p.locator('#bxUrl').press('Enter');
    await waitFor(() => lastSize(), { timeout: 30000, message: 'the test page loads' });
    const a = await area(p);
    await waitFor(() => Number(lastSize().w) === a.width && Number(lastSize().h) === a.height, { timeout: 15000, message: `the page is laid out for ${JSON.stringify(a)}: ${JSON.stringify(lastSize())}` });
    assert.equal(lastSize().mobile, 'false');
    await waitFor(async () => (await frame(p))?.w === a.width, { timeout: 15000, message: 'frames at the new size' });
    await fills(p);
    const c1 = await clickAt(p, 300, 200);
    assert.ok(Math.abs(c1.x - 300) <= 3 && Math.abs(c1.y - 200) <= 3, `a desktop click lands at (300, 200): ${JSON.stringify(c1)}`);

    // Resized to a phone: the page gets the phone's width, touch and a mobile user agent.
    await p.setViewportSize({ width: 390, height: 844 });
    await waitFor(() => sizes.some((m) => m.t === 'bv_size' && m.size.width < 400), { timeout: 5000, message: 'the resize is sent' });
    const pa = await area(p);
    assert.ok(pa.width < 768);
    await waitFor(() => Number(lastSize()?.w) === pa.width && lastSize().mobile === 'true' && Number(lastSize().touch) > 0, { timeout: 30000, message: `the phone metrics apply: ${JSON.stringify(lastSize())}` });
    await waitFor(async () => (await frame(p))?.w === pa.width, { timeout: 15000, message: 'phone-sized frames' });
    await fills(p);
    const py = Math.round(pa.height * 0.7); // inside the stage (a banner above it, e.g. Claude not signed in, shortens it)
    const c2 = await clickAt(p, 120, py);
    assert.ok(Math.abs(c2.x - 120) <= 3 && Math.abs(c2.y - py) <= 3, `a phone click lands at (120, ${py}): ${JSON.stringify(c2)}`);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('iPhone: the page fills the Browser tab and the toolbar and prompt fit 390 px', { skip, timeout: 180000 }, async () => {
  const { ctx, p, errors } = await app({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  try {
    await p.locator('.seg [data-view="browser"]').tap();
    await waitFor(() => inControl(p), { timeout: 60000, message: 'in control' });
    await p.locator('#bxUrl').fill(homeUrl);
    await p.locator('#bxUrl').press('Enter');
    await waitFor(() => p.evaluate((h) => document.getElementById('bxUrl').value.startsWith(h.replace(/\/$/, '')), homeUrl), { timeout: 30000, message: 'the home page' });
    await waitFor(async () => (await frame(p))?.w === (await area(p)).width, { timeout: 30000, message: 'a phone-sized frame' });
    await p.waitForTimeout(2000); // it renders its phone layout
    await fills(p);
    const px = (await frame(p)).px;
    assert.ok(px[0] >= (await area(p)).width * 1.9, `frames are sharp on a 3× screen (2× cap): ${px}`);
    // Nothing overflows the phone's width.
    const wide = await p.evaluate(() => [...document.querySelectorAll('#bxBar > *, #bxPrompt, #bxPrompt *')]
      .filter((e) => e.offsetParent && e.getBoundingClientRect().right > innerWidth + 0.5).map((e) => e.id || e.className));
    assert.deepEqual(wide, []);
    assert.equal(await p.evaluate(() => document.getElementById('browserView').scrollWidth <= innerWidth), true);
    await p.screenshot({ path: path.join(SHOTS, 'browser-tab-phone.png') });
    // A tap on the test page lands where it was shown.
    await p.locator('#bxUrl').fill(pageUrl);
    await p.locator('#bxUrl').press('Enter');
    await waitFor(() => p.evaluate((u) => document.getElementById('bxUrl').value === u, pageUrl), { timeout: 30000, message: 'the test page' });
    await p.waitForTimeout(1500);
    // The page fills its (2×) frame: the stripes reach the bottom right, not just a 1× render in the top-left quarter.
    const corner = await p.evaluate(() => { const c = document.getElementById('bxCanvas'); return [...c.getContext('2d').getImageData(Math.round(c.width * 0.95), Math.round(c.height * 0.95), 1, 1).data]; });
    assert.ok(Math.min(...corner.slice(0, 3)) < 200, `the page reaches the frame's corner: ${corner}`);
    const ty = Math.round((await area(p)).height * 0.7);
    const c = await clickAt(p, 60, ty, true);
    assert.ok(Math.abs(c.x - 60) <= 3 && Math.abs(c.y - ty) <= 3, `a tap lands at (60, ${ty}): ${JSON.stringify(c)}`);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
