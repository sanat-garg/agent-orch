// Download output on a command schedule's runs (public/schedules.js runs() → downloadRow): boots server.mjs
// (CW_NO_ORCHESTRATOR=1, a temp data dir with a throwaway project, never live schedules), opens Output in the Schedules
// sheet and saves each run through the browser's download, checking the report's exact UTF-8 bytes and its filename:
// a failed run with unicode output, a run with no output, a running run labelled as a snapshot, a failed runs load
// (its error shown, no download offered) and the button on a phone. Run now, schedule data and requests are unchanged.
// Skips when Playwright's Chromium can't launch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'schedule-download-ui-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, alpha;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const call = async (p, method = 'GET', body) => {
  const r = await fetch(base + p, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json();
  assert.ok(r.ok, `${method} ${p}: ${JSON.stringify(data)}`);
  return data;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clearSchedules = async () => { for (const s of (await call('/api/orch/schedules')).schedules) await call(`/api/orch/schedules/${s.id}`, 'DELETE'); };
// A command schedule (switched off so only Run now starts it), run once; resolves when its run satisfies ready.
async function ranSchedule(title, command, ready = (j) => j.status !== 'running') {
  const s = (await call(`/api/orch/projects/${alpha}/schedules`, 'POST', { title, command, cron: '0 3 * * *', tz: 'UTC', enabled: false })).schedule;
  await call(`/api/orch/schedules/${s.id}/run`, 'POST');
  for (let i = 0; i < 600; i++) {
    const j = (await call(`/api/orch/schedules/${s.id}/runs`)).runs[0];
    if (j && ready(j)) return { s, j };
    await sleep(50);
  }
  throw new Error(`${title} never got ready`);
}
const iso = (t) => new Date(t * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-scdl-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const dir = path.join(dataDir, 'p', 'alpha');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: 'c0', title: 'alpha', cwd: dir, mode: 'bypassPermissions', model: '', createdAt: 1, updatedAt: 2 }]));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 90000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  alpha = Number(db.prepare('INSERT INTO projects (path, name, convo_id, created_at) VALUES (?, ?, ?, ?)').run(dir, 'alpha', 'c0', Date.now() / 1000).lastInsertRowid);
  db.close();
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function openSheet(phone = false) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'UTC', acceptDownloads: true }
    : { viewport: { width: 1280, height: 860 }, timezoneId: 'UTC', acceptDownloads: true });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [], writes = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (r.method() !== 'GET') writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.goto(`${base}/`);
  await page.locator('#app:not([inert])').waitFor();
  if (phone) await page.locator('#openSidebar').click();
  await page.locator('#schedBtn').click();
  return { ctx, page, errors, writes, sheet: page.locator('#schedModal') };
}
// Opens a schedule's Output and saves its newest run → {name, bytes, button}.
async function download(page, sheet, title, label = 'Download output') {
  const row = sheet.locator('.sc-row', { hasText: title });
  await row.getByRole('button', { name: 'Output' }).click();
  const button = row.locator('.sc-run').first().getByRole('button', { name: /retained output/ });
  await button.waitFor();
  assert.equal((await button.textContent()).trim(), label);
  const [dl] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const bytes = fs.readFileSync(await dl.path());
  return { name: dl.suggestedFilename(), bytes, button, row };
}

test('a run downloads as an identified UTF-8 report with its exact retained output', { skip }, async () => {
  await clearSchedules();
  const output = 'héllo ✓ — 日本\n  indented\ttab\nno trailing newline';
  const { s, j } = await ranSchedule('Nightly scrape: “prod”/eu', `printf '%s' '${output}'; exit 3`);
  assert.equal(j.output, output);
  const { ctx, page, errors, writes, sheet } = await openSheet();
  try {
    const { name, bytes, row } = await download(page, sheet, 'Nightly scrape');
    assert.equal(name, `schedule-${s.id}-nightly-scrape-prod-eu-run-${j.id}.txt`);
    assert.match(name, /^[a-z0-9.-]+$/);
    const expected = ['agent-orch schedule output', `Schedule: Nightly scrape: “prod”/eu (#${s.id})`, `Run: #${j.id} (Run now)`,
      `Started: ${iso(j.started_at)}`, `Finished: ${iso(j.finished_at)}`, 'Status: failed', 'Exit code: 3',
      'Output: the retained output follows, exactly as kept on the server', '', '----- output -----', output].join('\n');
    assert.deepEqual(bytes, Buffer.from(expected, 'utf8'));
    await row.getByText('Saves the retained output as a text file.').waitFor();
    assert.deepEqual(writes, [], 'downloading sends nothing to the server');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('a run with no output still downloads an identified report', { skip }, async () => {
  await clearSchedules();
  const { s, j } = await ranSchedule('Quiet job', 'true');
  assert.equal(j.output, '');
  const { ctx, page, errors, sheet } = await openSheet();
  try {
    const { name, bytes } = await download(page, sheet, 'Quiet job');
    assert.equal(name, `schedule-${s.id}-quiet-job-run-${j.id}.txt`);
    assert.equal(bytes.toString('utf8'), ['agent-orch schedule output', `Schedule: Quiet job (#${s.id})`, `Run: #${j.id} (Run now)`,
      `Started: ${iso(j.started_at)}`, `Finished: ${iso(j.finished_at)}`, 'Status: finished', 'Exit code: 0', 'Output: none retained', '', ''].join('\n'));
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("a running run's download is labelled a snapshot", { skip }, async () => {
  await clearSchedules();
  const { s, j } = await ranSchedule('Long crawl', 'echo "page 1 done"; sleep 60', (x) => x.status === 'running' && x.output.includes('page 1 done'));
  const { ctx, page, errors, sheet } = await openSheet();
  try {
    const { name, bytes, row } = await download(page, sheet, 'Long crawl', 'Download snapshot');
    assert.equal(name, `schedule-${s.id}-long-crawl-run-${j.id}-snapshot.txt`);
    const text = bytes.toString('utf8');
    assert.ok(text.startsWith(`agent-orch schedule output (snapshot)\nSchedule: Long crawl (#${s.id})\nRun: #${j.id} (Run now)\nStarted: ${iso(j.started_at)}\n`
      + 'Status: running, still going when this snapshot was taken; output after that is not included\n'), text);
    assert.ok(!text.includes('Finished:') && !text.includes('Exit code:'), text);
    assert.ok(text.endsWith('----- output -----\npage 1 done\n'), text);
    await row.getByText('Still running: saves the output so far as a snapshot.').waitFor();
    assert.equal(await row.locator('.sc-run').first().getByRole('button', { name: /Download a snapshot of the retained output/ }).count(), 1);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await call(`/api/orch/schedules/${s.id}`, 'DELETE'); }
});

test('a failed runs load shows its error and offers no download', { skip }, async () => {
  await clearSchedules();
  await ranSchedule('Flaky job', 'echo hi');
  const { ctx, page, errors, sheet } = await openSheet();
  try {
    await page.route('**/api/orch/schedules/*/runs', (route) => route.fulfill({ status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: 'Could not read the run log' }) }));
    const row = sheet.locator('.sc-row', { hasText: 'Flaky job' });
    await row.getByRole('button', { name: 'Output' }).click();
    await row.locator('.sc-out', { hasText: 'Could not read the run log' }).waitFor();
    assert.equal(await row.getByRole('button', { name: /Download/ }).count(), 0);
    assert.equal(await row.locator('.sc-run').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('on a phone the button is a full touch target inside the sheet and still downloads', { skip }, async () => {
  await clearSchedules();
  const { s, j } = await ranSchedule('Phone job', 'echo from the phone');
  const { ctx, page, errors, sheet } = await openSheet(true);
  try {
    const { name, bytes, button } = await download(page, sheet, 'Phone job');
    assert.equal(name, `schedule-${s.id}-phone-job-run-${j.id}.txt`);
    assert.ok(bytes.toString('utf8').endsWith('----- output -----\nfrom the phone\n'));
    const box = await button.boundingBox();
    assert.ok(box.height >= 44, `height ${box.height}`);
    assert.ok(box.x >= 0 && box.x + box.width <= 390, `fits the screen: ${JSON.stringify(box)}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
