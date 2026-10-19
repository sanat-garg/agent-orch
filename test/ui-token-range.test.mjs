// The Token usage sheet's All time / Last 7 days picker (tokens.js, GET /api/convos/:id/usage `recent`) in a real browser:
// boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) on a spare port with a usage log holding a chat's turns and its
// project's task runs from today and from ten days ago, and a chat whose turns are all ten days old. The sheet opens on
// All time; Last 7 days switches the totals, model table and task totals together while the pill and the weekly-limit
// estimates stay; a chat with nothing recent shows an empty state; a failed load stays visible.
// TK_SHOTS=<dir> saves screenshots there. Skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'token-range-password';
const CID = 'range-busy', CID2 = 'range-old';
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-tokenrange-'));
  const web = path.join(dataDir, 'web'), other = path.join(dataDir, 'other');
  fs.mkdirSync(web); fs.mkdirSync(other);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const convo = (id, title, cwd) => ({ id, title, cwd, mode: 'chat', agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([convo(CID, 'Web', web), convo(CID2, 'Other', other)]));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const boot = () => {
    child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
      const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
    });
  };
  // First boot creates the DB; add a task, then write the usage log and boot again so it is read fresh.
  await boot();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,created_at) VALUES(?,'web','active',0)").run(web).lastInsertRowid);
  const taskId = Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,created_at) VALUES(?,'work','Build it','build','done',0)").run(pid).lastInsertRowid);
  db.close();
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  const now = Date.now(), H = 3600e3, D = 86400e3, resetsAt = Math.round((now + 2 * D) / 1000);
  const rec = (t, r) => JSON.stringify({ t, agent: 'claude', kind: 'tokens', ...r });
  fs.mkdirSync(path.join(dataDir, 'metrics'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'metrics', 'usage.jsonl'), [
    rec(now - 10 * D, { input: 4000000, output: 500000, cached: 30000000, source: 'chat', ref: CID, model: 'fable' }),
    rec(now - 10 * D, { input: 2000000, output: 200000, cached: 1000000, source: 'task', ref: taskId, model: 'fable' }),
    rec(now - 3 * H, { input: 400000, output: 60000, cached: 9000000, source: 'chat', ref: CID, model: 'opus' }),
    rec(now - 2 * H, { input: 900000, output: 100000, cached: 20000000, source: 'task', ref: taskId, model: 'opus' }),
    rec(now - 2 * H, { input: 3000000, output: 400000, cached: 60000000, source: 'chat', ref: 'someone-else', model: 'opus' }),
    rec(now - 10 * D, { input: 70000, output: 7000, cached: 0, source: 'chat', ref: CID2, model: 'opus' }),
    JSON.stringify({ t: now - H, agent: 'claude', kind: 'window', window: 'seven_day', pct: 40, resetsAt }),
  ].join('\n') + '\n');
  child.removeAllListeners('exit');
  await boot();
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(cid) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors, go: async () => { await page.goto(`${base}/#${cid}`); await page.waitForFunction(() => typeof window.Tokens === 'object'); } };
}
const sheet = (page) => page.locator('#tkBody').evaluate((b) => ({
  pressed: [...b.querySelectorAll('.tk-range button')].map((x) => `${x.textContent}:${x.getAttribute('aria-pressed')}`),
  span: b.querySelector('.tk-span')?.textContent || '',
  tiles: [...b.querySelectorAll('.tk-tiles')].map((t) => [...t.querySelectorAll('.tk-n')].map((n) => n.textContent)),
  models: [...b.querySelectorAll('.tk-models')].map((t) => [...t.querySelectorAll('tr td:first-child')].map((x) => x.textContent)),
  labels: [...b.querySelectorAll('.tk-label')].map((l) => l.textContent),
  weeks: b.querySelectorAll('.tk-week').length,
  empty: [...b.querySelectorAll('.tk-empty')].map((x) => x.textContent),
}));

test('the sheet opens on All time; Last 7 days switches totals, models and task totals together', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, go } = await open(CID);
  await go();
  await page.locator('#tokLink').waitFor();
  const pill = await page.locator('#tokLink').innerText();
  await page.locator('#tokLink').click();
  await page.locator('#tokModal .tk-week').first().waitFor();
  const all = await sheet(page);
  assert.deepEqual(all.pressed, ['All time:true', 'Last 7 days:false']);
  assert.equal(all.span, '');
  // Chat: 4.4M in, 560k out, 39M cache reads over both models; its tasks 2.9M in, 300k out, 21M cache reads.
  assert.deepEqual(all.tiles, [['44M', '4.4M', '560k', '39M'], ['24M', '2.9M', '300k', '21M']]);
  assert.equal(all.models.length, 2);
  assert.ok(all.labels.includes('By model'));
  assert.ok(all.labels.includes("This project's tasks · 2 runs"));
  assert.equal(all.weeks, 1);
  assert.match(await page.locator('#tkSub').innerText(), /^This chat · 2 replies since/);

  await page.locator('.tk-range button', { hasText: 'Last 7 days' }).click();
  const week = await sheet(page);
  assert.deepEqual(week.pressed, ['All time:false', 'Last 7 days:true']);
  assert.match(week.span, /^Rolling 7 days: .+ – now$/);
  // Only the turns from today: one opus reply and one opus task run, so no model tables; the unrelated chat is left out.
  assert.deepEqual(week.tiles, [['9.5M', '400k', '60k', '9.0M'], ['21M', '900k', '100k', '20M']]);
  assert.deepEqual(week.models, []);
  assert.ok(week.labels.includes("This project's tasks · 1 run in the last 7 days"));
  assert.equal(week.weeks, 1); // the weekly-limit estimates stay
  assert.ok(week.labels.includes('Against your weekly limits'));
  assert.equal(await page.locator('#tkSub').innerText(), 'This chat · 1 reply in the last 7 days');
  assert.equal(await page.locator('#tokLink').innerText(), pill); // the pill stays lifetime
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'tokens-range-week.png') });

  await page.locator('.tk-range button', { hasText: 'All time' }).click();
  assert.deepEqual((await sheet(page)).tiles, all.tiles);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a chat with no recent turns shows an empty state for the last 7 days', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, go } = await open(CID2);
  await go();
  await page.locator('#tokLink').waitFor();
  await page.locator('#tokLink').click();
  await page.locator('#tokModal .tk-range').waitFor();
  assert.deepEqual((await sheet(page)).tiles, [['77k', '70k', '7.0k', '0']]);
  await page.locator('.tk-range button', { hasText: 'Last 7 days' }).click();
  const week = await sheet(page);
  assert.deepEqual(week.tiles, []);
  assert.deepEqual(week.empty, ['No tokens recorded for this chat in the last 7 days.']);
  assert.equal(await page.locator('#tkSub').innerText(), 'This chat · last 7 days');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'tokens-range-empty.png') });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a failed load stays visible, before and after usage has loaded', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, go } = await open(CID);
  const fail = (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'usage log unreadable' }) });
  await page.route('**/api/convos/*/usage', fail);
  await go();
  await page.evaluate(() => window.Tokens.open());
  await page.locator('#tkBody .tk-err').waitFor();
  assert.equal(await page.locator('#tkBody').innerText(), "Couldn't load token usage: usage log unreadable");
  await page.keyboard.press('Escape');

  // Once loaded, a failed refresh keeps the numbers and says it couldn't refresh.
  await page.unroute('**/api/convos/*/usage', fail);
  await page.evaluate(() => window.Tokens.open());
  await page.locator('#tkBody .tk-tiles').first().waitFor();
  await page.keyboard.press('Escape');
  await page.route('**/api/convos/*/usage', fail);
  await page.evaluate(() => window.Tokens.open());
  await page.locator('#tkBody .tk-err').waitFor();
  assert.equal(await page.locator('#tkBody .tk-err').innerText(), "Couldn't refresh token usage: usage log unreadable");
  assert.equal(await page.locator('#tkBody .tk-tiles').count(), 2);
  assert.deepEqual(errors, []);
  await ctx.close();
});
