// Sidebar order by last activity (#2230) against server.mjs (temporary HOME, data and port; scheduler off): three project
// chats A, B, C whose newest task is 3 days, 3 hours and 2 minutes old.
// - GET /api/convos carries project.lastActivityAt (epoch ms) and the list renders C, B, A with '2m', '3h', a weekday;
// - an event on A (POST /api/orch/task/:id/action) reaches the page as 'oactivity' and A jumps to the top, still
//   highlighted when it is the open chat;
// - the old priority drag is gone: no 'Drag to set priority', no rankable rows or drag handlers, no reorder endpoint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { findBrowser } from '../browser.mjs';
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'sidebar-activity-password';
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() }; // the MacBook worker's LaunchDaemon needs a shim (helpers/mac-chromium.mjs)
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, root, cookie, dataDir, home, port;
const pid = {}, NOW = Date.now(), AGO = { A: 3 * 864e5, B: 3 * 3600e3, C: 2 * 60e3 };

async function boot() {
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
}
async function stop() {
  const c = child;
  child = null;
  c.removeAllListeners('exit');
  await new Promise((r) => { c.once('exit', r); c.kill('SIGKILL'); });
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sideact-ui-'));
  home = path.join(root, 'home'); dataDir = path.join(root, 'data');
  for (const d of [home, dataDir]) fs.mkdirSync(d, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const convos = ['A', 'B', 'C'].map((n) => {
    const cwd = path.join(root, 'proj-' + n);
    fs.mkdirSync(cwd);
    return { id: 'c' + n, title: 'Project ' + n, cwd, mode: 'default', model: '', createdAt: 1, updatedAt: 1 };
  });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify(convos));
  port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  // First boot makes the DB; the projects and their tasks go in while it's down, so the second boot reads them fresh.
  await boot();
  await stop();
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  convos.forEach((c, i) => {
    const n = c.id.slice(1);
    // Positions are the reverse of the activity order, so a list by position would read A, B, C.
    pid[n] = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,position,priority,created_at) VALUES(?,?,'paused',?,?,50,0)").run(c.cwd, n, c.id, i + 1).lastInsertRowid);
    db.prepare("INSERT INTO tasks(project_id,title,prompt,status,source,created_at,finished_at) VALUES(?,?,?,'done','user',?,?)")
      .run(pid[n], 'old ' + n, 'old', (NOW - AGO[n]) / 1000 - 60, (NOW - AGO[n]) / 1000);
  });
  pid.taskA = Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,status,source,created_at) VALUES(?,'queued A','q','queued','user',?)")
    .run(pid.A, (NOW - 4 * 864e5) / 1000).lastInsertRowid);
  db.close();
  await boot();
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
});
after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const until = async (fn, what) => {
  for (const t0 = Date.now(); Date.now() - t0 < 8000; await new Promise((r) => setTimeout(r, 50))) if (await fn()) return;
  assert.fail(`timed out waiting for ${what}`);
};
const order = (page) => page.$$eval('#convoList .convo', (cs) => cs.map((c) => c.dataset.cid));

test('the project list payload carries lastActivityAt; the reorder endpoint is gone', async () => {
  const list = await (await fetch(`${base}/api/convos`, { headers: { cookie } })).json();
  const at = Object.fromEntries(list.map((c) => [c.id, c.project?.lastActivityAt]));
  for (const n of ['A', 'B', 'C']) assert.ok(Math.abs(at['c' + n] - (NOW - AGO[n])) < 2000, `${n}: ${at['c' + n]} vs ${NOW - AGO[n]}`);
  const r = await fetch(`${base}/api/orch/projects/reorder`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ids: [pid.A] }) });
  assert.equal(r.status, 404);
  await r.arrayBuffer();
});

test('newest first with a relative time; an event on the oldest moves it to the top, still highlighted; no drag', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript(() => localStorage.setItem('cw.lastSeen', String(Date.now())));
  const page = await ctx.newPage();
  const errors = [], posts = [];
  page.on('pageerror', (e) => { if (!/renderMetrics/.test(e.stack)) errors.push(e.message); });
  page.on('request', (q) => { if (q.method() === 'POST' && /reorder/.test(q.url())) posts.push(q.url()); });
  try {
    await page.goto(base + '/');
    await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
    await page.locator('#convoList .convo').nth(2).waitFor();
    assert.deepEqual(await order(page), ['cC', 'cB', 'cA']);
    const ago = await page.$$eval('#convoList .convo .ago', (as) => as.map((a) => a.textContent));
    const weekday = new Date(NOW - AGO.A).toLocaleDateString('en-US', { weekday: 'short' });
    assert.deepEqual(ago, ['2m', '3h', weekday]);

    // Open A (the oldest): it is highlighted at the bottom, then something happens in it and it jumps to the top.
    await page.locator('#convoList .convo[data-cid="cA"]').click();
    await until(async () => (await page.locator('#convoList .convo.active').getAttribute('data-cid')) === 'cA', 'A open');
    const r = await fetch(`${base}/api/orch/task/${pid.taskA}/action`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'urgency', value: 'urgent' }) });
    assert.equal(r.status, 200, await r.text());
    await until(async () => (await order(page)).join() === 'cA,cC,cB', 'A moved to the top');
    assert.equal(await page.locator('#convoList .convo.active').getAttribute('data-cid'), 'cA', 'the open project stays highlighted');
    assert.equal(await page.locator('#convoList .convo[data-cid="cA"] .ago').innerText(), 'now');

    // No priority drag: no hint, no rankable rows, nothing draggable, Alt+↑ posts nothing and changes nothing.
    assert.equal(await page.locator('text=Drag to set priority').count(), 0);
    assert.equal(await page.locator('#convoList .rankable, #convoList .rank-label, #convoList [draggable="true"], #rankLive').count(), 0);
    await page.locator('#convoList .convo[data-cid="cC"]').focus();
    await page.keyboard.press('Alt+ArrowUp');
    const box = await page.locator('#convoList .convo[data-cid="cB"] .ct').boundingBox();
    await page.mouse.move(box.x + 10, box.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x + 10, box.y - 80, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#convoList .lifted, #convoList .drop-indicator').count(), 0);
    assert.deepEqual(posts, []);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('the client code has no drag-to-priority left', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8'), css = fs.readFileSync(path.join(ROOT, 'public/app.css'), 'utf8');
  for (const s of ['Drag to set priority', 'dragPointerDown', 'liftCard', 'dropCard', 'nudgeProject', 'saveProjectOrder', '/api/orch/projects/reorder', 'rankLive'])
    assert.ok(!js.includes(s), `app.js still has ${s}`);
  for (const s of ['.rank-hint', '.drop-indicator', '.convo.lifted', '.convo.rankable']) assert.ok(!css.includes(s), `app.css still has ${s}`);
});
