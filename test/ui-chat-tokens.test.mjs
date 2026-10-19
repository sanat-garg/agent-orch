// The top bar's token pill and sheet (tokens.js, GET /api/convos/:id/usage) in a real browser: boots server.mjs
// (CW_NO_ORCHESTRATOR=1, temp data dir) on a spare port with a usage log holding this chat's turns, its project's task
// runs and a weekly reading. The pill shows the chat's tokens and its share of a full week; the sheet shows tiles, each
// weekly window, the models and the project's tasks; a chat with no tokens shows no pill; on a phone the pill lives in
// the title menu. TK_SHOTS=<dir> saves screenshots there. Skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'chat-tokens-password';
const CID = 'chat-tokens', CID2 = 'chat-quiet';
const SHOTS = process.env.TK_SHOTS || null;
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() };
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, taskId;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-chattokens-'));
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
  taskId = Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,created_at) VALUES(?,'work','Build it','build','done',0)").run(pid).lastInsertRowid);
  db.close();
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  const now = Date.now(), H = 3600e3, resetsAt = Math.round((now + 2 * 86400e3) / 1000);
  const rec = (t, r) => JSON.stringify({ t, ...r });
  fs.mkdirSync(path.join(dataDir, 'metrics'), { recursive: true });
  fs.rmSync(path.join(dataDir, 'metrics', 'token-totals.json'), { force: true });
  fs.writeFileSync(path.join(dataDir, 'metrics', 'usage.jsonl'), [
    rec(now - 3 * H, { agent: 'claude', kind: 'tokens', input: 400000, output: 60000, cached: 9000000, source: 'chat', ref: CID, model: 'opus' }),
    rec(now - 2 * H, { agent: 'claude', kind: 'tokens', input: 100000, output: 20000, cached: 3000000, source: 'chat', ref: CID, model: 'fable' }),
    rec(now - 2 * H, { agent: 'claude', kind: 'tokens', input: 900000, output: 100000, cached: 20000000, source: 'task', ref: taskId, model: 'opus' }),
    rec(now - 2 * H, { agent: 'claude', kind: 'tokens', input: 3000000, output: 400000, cached: 60000000, source: 'chat', ref: 'someone-else', model: 'opus' }),
    rec(now - H, { agent: 'claude', kind: 'window', window: 'seven_day', pct: 40, resetsAt }),
    rec(now - H, { agent: 'claude', kind: 'window', window: 'Fable', pct: 5, resetsAt }),
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

async function open(cid = CID, { viewport = { width: 1280, height: 800 }, dark = false } = {}) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${cid}`);
  await page.waitForFunction(() => typeof window.Tokens === 'object');
  return { ctx, page, errors };
}
const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `tokens-${name}.png`) });

test('the API sums the chat, its project\'s tasks and each weekly window', { skip, timeout: 30000 }, async () => {
  const d = await (await fetch(`${base}/api/convos/${CID}/usage`, { headers: { cookie } })).json();
  assert.equal(d.main, true);
  assert.deepEqual([d.chat.input, d.chat.output, d.chat.cached, d.chat.turns], [500000, 80000, 12000000, 2]);
  assert.equal(d.tasks.input, 900000);
  const week = d.weeks.find((w) => w.window === 'seven_day');
  // Weighted (input + cached/10 + 5 × output) up to the reading: chat 1.6M + 0.5M, task 3.4M, other 11M = 16.5M at 40%:
  // a week is 41.25M and the chat's 2.1M is 5.1% of it.
  assert.equal(week.size, 41250000);
  assert.equal(week.life, 5.1);
  assert.ok(d.weeks.some((w) => w.window === 'Fable'));
});

test('the pill shows the chat\'s tokens and share of a week; the sheet breaks it down', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  await page.locator('#tokLink').waitFor();
  assert.equal(await page.locator('#tokText').innerText(), '13M tokens');
  assert.equal(await page.locator('#tokPct').innerText(), '5.1% of a week');
  await shot(page, 'pill');
  await page.locator('#tokLink').click();
  await page.locator('#tokModal .tk-week').first().waitFor();
  const view = await page.locator('#tkBody').evaluate((b) => ({
    tiles: [...b.querySelector('.tk-tiles').querySelectorAll('.tk-n')].map((n) => n.textContent),
    weeks: [...b.querySelectorAll('.tk-week b')].filter((x) => !x.closest('.tk-fact')).map((x) => x.textContent),
    models: b.querySelectorAll('.tk-models').length,
    tasks: [...b.querySelectorAll('.tk-label')].some((l) => /project's tasks/.test(l.textContent)),
  }));
  assert.deepEqual(view.tiles, ['13M', '500k', '80k', '12M']);
  assert.deepEqual(view.weeks, ['Claude · all models', 'Claude · Fable']);
  assert.equal(view.models, 1);
  assert.equal(view.tasks, true);
  assert.match(await page.locator('#tkSub').innerText(), /^This chat · 2 replies since/);
  if (SHOTS) await page.waitForTimeout(400);
  await shot(page, 'sheet');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#tokModal').isHidden(), true);
  assert.deepEqual(errors, []);
  await ctx.close();
  if (SHOTS) {
    const d = await open(CID, { dark: true });
    await d.page.locator('#tokLink').click();
    await d.page.locator('#tokModal .tk-week').first().waitFor();
    await shot(d.page, 'sheet-dark');
    await d.ctx.close();
  }
});

test('a chat with no tokens shows no pill; on a phone the pill lives in the title menu', { skip, timeout: 60000 }, async () => {
  let { ctx, page, errors } = await open(CID2);
  await page.waitForTimeout(800);
  assert.equal(await page.locator('#tokLink').isHidden(), true);
  assert.deepEqual(errors, []);
  await ctx.close();
  ({ ctx, page, errors } = await open(CID, { viewport: { width: 390, height: 844 } }));
  await page.waitForFunction(() => !document.getElementById('tokLink').hidden);
  await page.locator('#viewBtn').click();
  await page.locator('#viewMenuTok').click();
  await page.locator('#tokModal .tk-week').first().waitFor();
  if (SHOTS) await page.waitForTimeout(500); // the sheet slides up
  await shot(page, 'phone');
  assert.deepEqual(errors, []);
  await ctx.close();
});
