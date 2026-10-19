// The Token usage sheet's Last 7 days daily bars (tokens.js dailyBars, from `recent.hours` of GET /api/convos/:id/usage) in a
// real browser: boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) on a spare port and stubs the usage route with fixed
// per-hour data, the page's clock set to Asia/Kolkata so UTC hours regroup into local days. Seven bars render, today last,
// labelled with local weekday names, the chat's and its tasks' tokens stacked, heights relative to the busiest day; an
// all-zero week shows one empty message. TK_SHOTS=<dir> saves screenshots there. Skips when Playwright's Chromium can't launch.
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
import { findBrowser } from '../browser.mjs';
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'tokens-daily-password';
const CID = 'daily-chat';
const SHOTS = process.env.TK_SHOTS || null;
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() };
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-tokensdaily-'));
  const web = path.join(dataDir, 'web');
  fs.mkdirSync(web);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Web', cwd: web, mode: 'chat', agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true }]));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    // A cold boot takes ~8s on this one-core box at a load average over 10 (other sessions' suites): allow for worse.
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 90000);
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

// Stubbed usage: `until` is Monday 2026-10-19 12:00 UTC (17:30 in Kolkata), so the seven local days run Tue 13 … Mon 19.
const H = 3600e3, D = 86400e3;
const UNTIL = Date.UTC(2026, 9, 19, 12);
const sum = (input, output, cached, turns) => ({ input, output, cached, turns, first: turns ? UNTIL - 6 * D : null, last: turns ? UNTIL : null, models: turns ? [{ agent: 'claude', model: 'opus', input, output, cached, turns }] : [] });
const usage = (hours, { turns = 3 } = {}) => ({
  main: true, chat: sum(5000000, 500000, 40000000, 9), tasks: sum(1000000, 100000, 9000000, 4), weeks: [],
  recent: { since: UNTIL - 7 * D, until: UNTIL, chat: sum(1500000, 100000, 1000000, turns), tasks: sum(150000, 50000, 0, turns ? 1 : 0), hours },
});
const HOURS = [
  { t: UNTIL - 7 * D + 2 * H, chat: 999000, tasks: 0 }, // Mon 12 14:00 UTC: inside the rolling window but before the first local day: left out
  { t: Date.UTC(2026, 9, 13, 6), chat: 100000, tasks: 0 }, // Tue 13 11:30 IST
  { t: Date.UTC(2026, 9, 17, 8), chat: 300000, tasks: 200000 }, // Sat 17
  { t: Date.UTC(2026, 9, 18, 20), chat: 500000, tasks: 0 }, // Sun 18 20:00 UTC = Mon 19 01:30 IST
  { t: Date.UTC(2026, 9, 19, 10), chat: 1200000, tasks: 0 }, // Mon 19
];

async function openSheet(data) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: 'Asia/Kolkata' });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000); // page loads and sheet renders slow down under the same load
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/convos/*/usage', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }));
  await page.goto(`${base}/#${CID}`);
  await page.waitForFunction(() => typeof window.Tokens === 'object');
  await page.evaluate(() => window.Tokens.open());
  await page.locator('#tkBody .tk-range').waitFor();
  await page.locator('.tk-range button', { hasText: 'Last 7 days' }).click();
  return { ctx, page, errors };
}
const bars = (page) => page.locator('#tkBody').evaluate((b) => ({
  labels: [...b.querySelectorAll('.tk-dl')].map((x) => x.textContent),
  aria: [...b.querySelectorAll('.tk-day')].map((x) => x.getAttribute('aria-label')),
  heights: [...b.querySelectorAll('.tk-dbar')].map((x) => x.style.height),
  stacked: [...b.querySelectorAll('.tk-dbar')].map((x) => x.querySelector('.tk-dtasks').getBoundingClientRect().height > 0),
  legend: b.querySelector('.tk-legend')?.textContent || '',
  before: b.querySelector('.tk-days')?.nextElementSibling?.className || '',
  empty: [...b.querySelectorAll('.tk-days-empty')].map((x) => x.textContent),
  notes: [...b.querySelectorAll('.tk-empty')].map((x) => x.textContent),
}));

test('Last 7 days draws seven local-day bars, today last, chat and tasks stacked, scaled to the busiest day', { skip, timeout: 180000 }, async () => {
  const { ctx, page, errors } = await openSheet(usage(HOURS));
  await page.locator('#tkBody .tk-chart').waitFor();
  const v = await bars(page);
  assert.deepEqual(v.labels, ['Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon']);
  assert.deepEqual(v.aria, ['Tue: 100k tokens (chat 100k, tasks 0)', 'Wed: 0 tokens', 'Thu: 0 tokens', 'Fri: 0 tokens',
    'Sat: 500k tokens (chat 300k, tasks 200k)', 'Sun: 0 tokens', 'Mon: 1.7M tokens (chat 1.7M, tasks 0)']);
  assert.deepEqual(v.heights, ['6%', '0%', '0%', '0%', '29%', '0%', '100%']);
  assert.deepEqual(v.stacked, [false, false, false, false, true, false, false]);
  assert.equal(v.legend, 'This chatIts tasks');
  assert.equal(v.before, 'tk-tiles'); // the bars sit above the totals
  assert.deepEqual(v.empty, []);
  const box = await page.locator('#tkBody .tk-chart').boundingBox();
  assert.ok(box.height >= 80 && box.height <= 140, `chart height ${box.height}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'tokens-daily.png') });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('an all-zero week shows one empty message instead of bars', { skip, timeout: 180000 }, async () => {
  const { ctx, page, errors } = await openSheet(usage([], { turns: 0 }));
  await page.locator('#tkBody .tk-days-empty').waitFor();
  const v = await bars(page);
  assert.deepEqual(v.labels, []);
  assert.deepEqual(v.empty, ['No tokens in the last seven days.']);
  assert.deepEqual(v.notes, ['No tokens in the last seven days.', 'No task runs recorded in the last 7 days.']); // one message for the chat, not two
  assert.equal(await page.locator('#tkBody .tk-tiles').count(), 0);
  // A chat with recent turns whose hours all fall before the seven local days still gets the message, above its totals.
  await page.route('**/api/convos/*/usage', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(usage([HOURS[0]])) }));
  await page.evaluate(() => window.Tokens.open());
  await page.waitForFunction(() => document.querySelector('#tkBody .tk-tiles'));
  const w = await bars(page);
  assert.deepEqual(w.empty, ['No tokens in the last seven days.']);
  assert.equal(w.before, 'tk-tiles');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'tokens-daily-empty.png') });
  assert.deepEqual(errors, []);
  await ctx.close();
});
