// The sidebar's server + usage cards fold to one line each at any window size (app.js msFold).
// Boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir): a tall window has no toggle; a short one folds the cards
// (rows hidden, the one-line summaries shown, the usage window NOT opened), remembers it across a reload, and unfolds.
// Skips when Playwright's Chromium can't launch.
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
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'stats-fold-password';
let browser, skip = false;
const macEnv = macChromiumEnv();
try { browser = await chromium.launch(macEnv.DYLD_INSERT_LIBRARIES
  ? { executablePath: macEnv.AGENT_ORCH_BROWSER_PATH, env: { ...process.env, DYLD_INSERT_LIBRARIES: macEnv.DYLD_INSERT_LIBRARIES } } : {}); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fold-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
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

const shown = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => getComputedStyle(e).display !== 'none'), sel);

test('the server and usage cards fold to one line each at any window size, remembered', { skip, timeout: 60000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/`);
  await page.locator('#app:not([inert]) #input').waitFor();
  assert.deepEqual(await shown(page, '#msFold'), [true], 'the toggle shows on a tall window too');

  const tall = (await page.locator('#miniStatsCard').boundingBox()).height;
  assert.equal(await page.getAttribute('#msFold', 'aria-expanded'), 'true');
  await page.click('#msFold');
  assert.equal(await page.isHidden('#usageModal'), true, 'the toggle does not open the usage window');
  assert.equal(await page.getAttribute('#msFold', 'aria-expanded'), 'false');
  assert.equal(await page.getAttribute('#msFold', 'aria-label'), 'Expand server and usage');
  assert.deepEqual(await shown(page, '#miniStatsCard .ms-row'), [false, false, false, false]);
  assert.deepEqual(await shown(page, '#miniSum, #usSum, #usNote'), [true, true, false]);
  assert.match(await page.textContent('#miniSum'), /^CPU .+ · RAM .+$/);
  assert.match(await page.textContent('#usSum'), /^5h .+ · Wk .+$/);
  const folded = (await page.locator('#miniStatsCard').boundingBox()).height;
  assert.ok(folded < tall - 100, `folded ${folded}px vs ${tall}px`);

  await page.reload();
  await page.locator('#app:not([inert]) #input').waitFor();
  assert.equal(await page.getAttribute('#msFold', 'aria-expanded'), 'false', 'remembered across a reload');
  await page.setViewportSize({ width: 1280, height: 760 });
  assert.deepEqual(await shown(page, '#miniStatsCard .ms-row'), [false, false, false, false], 'still folded on a short window');
  await page.click('#msFold');
  assert.deepEqual(await shown(page, '#miniSum, #usNote'), [false, true], 'unfolded again');
  await ctx.close();
  assert.deepEqual(errors, []);
});
