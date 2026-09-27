// Review breaks in the UI: '+ Review break' on task cards, the flagged checkpoint card and its review panel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedPath } from './helpers/isolated-path.mjs';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'review-ui-password';
const CID = 'chat-review';
const SHOTS = process.env.CW_REVIEW_SHOTS; // optional dir: save screenshots of the states it checks
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, home, cookie, db;
const ids = {};

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-reviewui-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-reviewui-home-'));
  const project = path.join(dataDir, 'no-such-project');
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Review breaks', cwd: project, mode: 'orchestrator',
    createdAt: 1, updatedAt: 1, fullAccess: true, fallbacks: [] }]));
  fs.mkdirSync(path.join(home, 'bin'));
  const port = await freePort();
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH: isolatedPath(path.join(home, 'bin')),
    PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,created_at) VALUES(?,?,'active',?,0)").run(project, 'Review', CID).lastInsertRowid);
  let pos = 0;
  const task = (title, { kind = 'work', status = 'queued', dep = null, result = null } = {}) => {
    const id = Number(db.prepare('INSERT INTO tasks(project_id,kind,title,prompt,status,depends_on,result,position,started_at,finished_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,0)')
      .run(pid, kind, title, title, status, dep, result, ++pos, status === 'queued' ? null : Date.now() / 1000 - 60, status === 'done' ? Date.now() / 1000 - 30 : null).lastInsertRowid);
    if (dep) db.prepare('INSERT INTO task_deps(task_id, depends_on) VALUES(?,?)').run(id, dep);
    return id;
  };
  ids.model = task('New data model', { status: 'done', result: 'AGENT-ORCH-STATUS: done — tasks table has a kind column' });
  ids.cp = task('Review the data model', { kind: 'review', status: 'awaiting_review', dep: ids.model, result: JSON.stringify({ task: ids.model, title: 'New data model',
    summary: 'tasks table has a kind column', commit: 'abc1234def', files: [{ status: 'M', path: 'orchestrator.mjs' }, { status: 'A', path: 'test/model.test.mjs' }], shots: [] }) });
  ids.redesign = task('Redesign the settings page', { status: 'running' });
  ids.migrate = task('Migrate old rows', { dep: ids.cp });
  ids.polish = task('Polish the settings copy', { dep: ids.redesign });
});

after(async () => {
  db?.close();
  await browser?.close();
  child?.kill('SIGKILL');
  for (const d of [dataDir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test('task cards offer + Review break; a waiting checkpoint shows its review panel and approves', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  await page.goto(`${base}/#${CID}`);
  await page.locator('#obQueue').click();
  const card = (id) => page.locator(`#qBody .tcard[data-task="${id}"]`);
  await card(ids.cp).waitFor();
  // The waiting checkpoint: flag glyph, its own section, the reviewed task's summary and files, the two actions.
  assert.match(await page.locator('#qBody').innerText(), /Waiting for your review/);
  assert.equal(await card(ids.cp).locator('.tc-glyph.review.awaiting').count(), 1);
  assert.equal(await card(ids.cp).locator('.tc-rb').count(), 0);
  const panel = page.locator('#qBody .q-review .rv-panel');
  assert.match(await panel.innerText(), /tasks table has a kind column/);
  assert.match(await panel.innerText(), /2 files changed/);
  assert.equal(await panel.getByRole('button', { name: 'Approve & continue' }).count(), 1);
  assert.equal(await panel.getByRole('button', { name: 'Request changes' }).count(), 1);
  // Running and queued work tasks offer a review break.
  for (const id of [ids.redesign, ids.migrate, ids.polish]) assert.equal(await card(id).getByRole('button', { name: '+ Review break' }).isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'review-queue-mobile.png') });
  // Adding one after the running task: a flagged 'Wait for your review' card; the task that needed it now waits for it.
  await card(ids.redesign).locator('.tc-rb').click();
  assert.equal(await page.locator('#drawer').isVisible().catch(() => false), false);
  const added = await (async () => { for (let i = 0; i < 600; i++) { const r = db.prepare("SELECT id FROM tasks WHERE kind='review' AND status='queued'").get(); if (r) return r.id; await new Promise((r) => setTimeout(r, 50)); } })();
  assert.ok(added);
  assert.deepEqual(db.prepare('SELECT depends_on FROM all_deps WHERE task_id=?').all(ids.polish).map((r) => r.depends_on), [added]);
  await card(added).waitFor();
  assert.match(await card(added).innerText(), /Wait for your review/);
  assert.equal(await card(added).locator('.tc-glyph.review').count(), 1);
  assert.equal(await card(ids.redesign).locator('.tc-rb').count(), 0);
  if (SHOTS) {
    await page.locator('#qBody').evaluate((e) => { e.scrollTop = e.scrollHeight; });
    await page.screenshot({ path: path.join(SHOTS, 'review-added-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(SHOTS, 'review-added-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
  }
  // Request changes opens a note form; Approve & continue releases the queue.
  await panel.getByRole('button', { name: 'Request changes' }).click();
  assert.equal(await panel.locator('textarea').isVisible(), true);
  await panel.getByRole('button', { name: 'Approve & continue' }).click();
  for (let i = 0; i < 600 && db.prepare('SELECT status FROM tasks WHERE id=?').get(ids.cp).status !== 'done'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(ids.cp).status, 'done');
  await ctx.close();
});
