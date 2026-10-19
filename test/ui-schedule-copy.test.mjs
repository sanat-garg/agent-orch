// Copying a schedule (public/schedules.js Copy → startEdit(null, null, src)): boots server.mjs (CW_NO_ORCHESTRATOR=1, a temp
// data dir with two throwaway projects, never live schedules) and drives the Schedules sheet: a command schedule copied
// into the other project as a paused draft (its time zone kept through preview and save, the original and its runs
// untouched), an agent schedule's prompt, done_when, agent and model carried over, and a failed save keeping the draft.
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
const PASSWORD = 'schedule-copy-ui-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, alpha, beta;

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
const schedules = async () => (await call('/api/orch/schedules')).schedules;
const addSchedule = async (projectId, body) => (await call(`/api/orch/projects/${projectId}/schedules`, 'POST', body)).schedule;
const clearSchedules = async () => { for (const s of await schedules()) await call(`/api/orch/schedules/${s.id}`, 'DELETE'); };
// The fields a copy must leave alone on its source.
const pick = (s) => ({ title: s.title, project_id: s.project_id, command: s.command, prompt: s.prompt, done_when: s.done_when, cron: s.cron, tz: s.tz,
  enabled: s.enabled, agent: s.agent, model: s.model, runs: s.runs, last_job: s.last_job?.id ?? null });

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sccopy-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const dirs = ['alpha', 'beta'].map((n) => { const d = path.join(dataDir, 'p', n); fs.mkdirSync(d, { recursive: true }); return d; });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify(dirs.map((cwd, i) => (
    { id: `c${i}`, title: path.basename(cwd), cwd, mode: 'bypassPermissions', model: '', createdAt: 1 + i, updatedAt: 2 + i }))));
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
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  const ins = db.prepare('INSERT INTO projects (path, name, convo_id, created_at) VALUES (?, ?, ?, ?)');
  alpha = Number(ins.run(dirs[0], 'alpha', 'c0', Date.now() / 1000).lastInsertRowid);
  beta = Number(ins.run(dirs[1], 'beta', 'c1', Date.now() / 1000).lastInsertRowid);
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

// The browser is in UTC, so a schedule in another zone shows whether the editor kept it.
async function openSheet() {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, timezoneId: 'UTC' });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [], previews = [], runNow = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/api/orch/cron-preview') previews.push(u.searchParams.get('tz'));
    if (/\/run$/.test(u.pathname)) runNow.push(u.pathname);
  });
  await page.goto(`${base}/`);
  await page.locator('#app:not([inert])').waitFor();
  await page.locator('#schedBtn').click();
  return { ctx, page, errors, previews, runNow, sheet: page.locator('#schedModal') };
}

test('a command schedule copies into another project as a paused draft in its own time zone', { skip }, async () => {
  await clearSchedules();
  const src = await addSchedule(alpha, { title: 'Tokyo backup', command: 'echo backed up', cron: '30 2 * * *', tz: 'Asia/Tokyo' });
  await call(`/api/orch/schedules/${src.id}/run`, 'POST'); // a run the copy must not inherit
  let before;
  for (let i = 0; i < 100 && !(before = (await schedules())[0]).last_job; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(before.last_job, 'the source has a run');
  const { ctx, page, errors, previews, runNow, sheet } = await openSheet();
  try {
    const row = sheet.locator('.sc-row', { hasText: 'Tokyo backup' });
    await row.getByRole('button', { name: 'Copy' }).click();
    const form = sheet.locator('.sc-form');
    await form.locator('.sc-etitle', { hasText: 'Copy schedule' }).waitFor();
    await form.locator('.sc-copynote', { hasText: 'Saving creates a new paused schedule' }).waitFor();
    assert.equal(await form.getByPlaceholder('e.g. Nightly scrape').inputValue(), 'Tokyo backup (copy)');
    assert.equal(await form.getByPlaceholder('e.g. npm run scrape').inputValue(), 'echo backed up');
    await form.locator('.sc-preview', { hasText: 'Every day at 02:30 (Asia/Tokyo)' }).waitFor();
    assert.equal((await schedules()).length, 1, 'nothing is created before Save');

    const project = form.locator('label.sc-field', { hasText: 'Copy to project' }).locator('select');
    assert.equal(await project.isDisabled(), false);
    assert.equal(await project.inputValue(), String(alpha));
    await project.selectOption(String(beta));
    await form.getByPlaceholder('e.g. Nightly scrape').fill('Tokyo backup for beta');
    await form.getByRole('button', { name: 'Save paused copy' }).click();

    const copyRow = sheet.locator('.sc-row.off', { hasText: 'Tokyo backup for beta' });
    await copyRow.getByText('Not run yet').waitFor();
    assert.equal(await copyRow.getByRole('switch').isChecked(), false);
    const all = await schedules(), copy = all.find((s) => s.id !== src.id);
    assert.equal(all.length, 2);
    assert.deepEqual(pick(copy), { title: 'Tokyo backup for beta', project_id: beta, command: 'echo backed up', prompt: '', done_when: null,
      cron: '30 2 * * *', tz: 'Asia/Tokyo', enabled: false, agent: null, model: null, runs: 0, last_job: null });
    assert.equal(copy.next_run_at, null);
    assert.deepEqual(pick(all.find((s) => s.id === src.id)), pick(before), 'the original is untouched');
    assert.ok(previews.length > 0 && previews.every((tz) => tz === 'Asia/Tokyo'), `previews used ${previews}`);
    assert.deepEqual(runNow, [], 'Run now is never called');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("an agent schedule's copy keeps its prompt, done_when, agent and model", { skip }, async () => {
  await clearSchedules();
  const src = await addSchedule(alpha, { title: 'Weekday triage', prompt: 'List new issues and label them.', done_when: 'npm test',
    cron: '15 7 * * 1-5', tz: 'America/New_York', agent: 'codex', model: 'gpt-5' });
  assert.deepEqual([src.agent, src.model], ['codex', 'gpt-5']);
  const { ctx, page, errors, previews, runNow, sheet } = await openSheet();
  try {
    await sheet.locator('.sc-row', { hasText: 'Weekday triage' }).getByRole('button', { name: 'Copy' }).click();
    const form = sheet.locator('.sc-form');
    assert.equal(await form.getByRole('tab', { name: 'Ask an agent' }).getAttribute('aria-selected'), 'true');
    assert.equal(await form.getByPlaceholder(/What the task should do/).inputValue(), 'List new issues and label them.');
    assert.equal(await form.getByPlaceholder('Optional, e.g. npm test').inputValue(), 'npm test');
    await form.locator('.sc-runson', { hasText: 'Runs on codex · gpt-5' }).waitFor();
    await form.locator('.sc-preview', { hasText: '(America/New_York)' }).waitFor();
    await form.getByRole('button', { name: 'Save paused copy' }).click();
    await sheet.locator('.sc-row.off', { hasText: 'Weekday triage (copy)' }).waitFor();
    const copy = (await schedules()).find((s) => s.id !== src.id);
    assert.deepEqual(pick(copy), { title: 'Weekday triage (copy)', project_id: alpha, command: null, prompt: 'List new issues and label them.',
      done_when: 'npm test', cron: '15 7 * * 1-5', tz: 'America/New_York', enabled: false, agent: 'codex', model: 'gpt-5', runs: 0, last_job: null });
    assert.equal((await schedules()).find((s) => s.id === src.id).enabled, true, 'the original stays on');
    assert.ok(previews.every((tz) => tz === 'America/New_York'), `previews used ${previews}`);
    assert.deepEqual(runNow, []);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('a failed save keeps the draft and its error; required fields are checked first', { skip }, async () => {
  await clearSchedules();
  await addSchedule(alpha, { title: 'Hourly sync', command: 'echo synced', cron: '0 * * * *', tz: 'Europe/Berlin' });
  const { ctx, page, errors, sheet } = await openSheet();
  try {
    await sheet.locator('.sc-row', { hasText: 'Hourly sync' }).getByRole('button', { name: 'Copy' }).click();
    const form = sheet.locator('.sc-form');
    const title = form.getByPlaceholder('e.g. Nightly scrape'), command = form.getByPlaceholder('e.g. npm run scrape');
    await title.fill('');
    await form.getByRole('button', { name: 'Save paused copy' }).click();
    await form.locator('.sc-err', { hasText: 'Give it a title' }).waitFor();
    await title.fill('Hourly sync, beta');
    await command.fill('');
    await form.getByRole('button', { name: 'Save paused copy' }).click();
    await form.locator('.sc-err', { hasText: 'Say what command to run' }).waitFor();
    await command.fill('echo synced beta');
    await form.locator('label.sc-field', { hasText: 'Copy to project' }).locator('select').selectOption(String(beta));

    const posts = [];
    await page.route('**/api/orch/projects/*/schedules', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts.push(route.request().postDataJSON());
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The database is busy, try again' }) });
    });
    await form.getByRole('button', { name: 'Save paused copy' }).click();
    await form.locator('.sc-err', { hasText: 'The database is busy, try again' }).waitFor();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].enabled, false);
    assert.equal(posts[0].tz, 'Europe/Berlin');
    assert.equal(await title.inputValue(), 'Hourly sync, beta');
    assert.equal(await command.inputValue(), 'echo synced beta');
    assert.equal(await form.locator('label.sc-field', { hasText: 'Copy to project' }).locator('select').inputValue(), String(beta));
    assert.equal(await form.getByRole('button', { name: 'Save paused copy' }).isEnabled(), true);
    assert.equal((await schedules()).length, 1, 'nothing was created');

    await page.unroute('**/api/orch/projects/*/schedules');
    await form.getByRole('button', { name: 'Save paused copy' }).click();
    await sheet.locator('.sc-row.off', { hasText: 'Hourly sync, beta' }).waitFor();
    const copy = (await schedules()).find((s) => s.title === 'Hourly sync, beta');
    assert.deepEqual([copy.project_id, copy.command, copy.tz, copy.enabled], [beta, 'echo synced beta', 'Europe/Berlin', false]);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
