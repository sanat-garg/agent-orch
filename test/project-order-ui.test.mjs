// Sidebar project order against server.mjs (temporary HOME, data and port; scheduler off): three project chats A, B, C.
// - POST /api/orch/projects/reorder sets positions and derives priority from the place (90 → 10);
// - in a real browser, dragging C above A posts [C, A, B] (lifted card + drop line while dragging) and the list follows;
// - Alt+↑ on a focused row moves it up one place and posts that order; the header reads 'Priority order' with its hint.
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
const PASSWORD = 'project-order-password';
const SHOTS = process.env.CW_PORDER_SHOTS; // optional dir: save a screenshot mid-drag
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() }; // the MacBook worker's LaunchDaemon needs a shim (helpers/mac-chromium.mjs)
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, root, cookie, db;
const pid = {};

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-porder-ui-'));
  const home = path.join(root, 'home'), dataDir = path.join(root, 'data');
  for (const d of [home, dataDir]) fs.mkdirSync(d, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const convos = ['A', 'B', 'C'].map((n, i) => {
    const cwd = path.join(root, 'proj-' + n);
    fs.mkdirSync(cwd);
    return { id: 'c' + n, title: 'Project ' + n, cwd, mode: 'default', model: '', createdAt: 1, updatedAt: 1 + i };
  });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify(convos));
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
  db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  convos.forEach((c, i) => {
    const n = c.id.slice(1);
    pid[n] = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,position,priority,created_at) VALUES(?,?,'paused',?,?,50,0)").run(c.cwd, n, c.id, i + 1).lastInsertRowid);
  });
});
after(async () => {
  db?.close();
  await browser?.close();
  child?.kill('SIGKILL');
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const rows = () => db.prepare('SELECT id, position, priority FROM projects ORDER BY position').all().map((p) => ({ ...p }));
const post = async (ids) => {
  const r = await fetch(`${base}/api/orch/projects/reorder`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
  return { status: r.status, body: await r.json() };
};

test('the endpoint sets positions and derives priority from the order', async () => {
  const r = await post([pid.B, pid.C, pid.A]);
  assert.equal(r.status, 200);
  assert.deepEqual(rows(), [{ id: pid.B, position: 1, priority: 90 }, { id: pid.C, position: 2, priority: 50 }, { id: pid.A, position: 3, priority: 10 }]);
  assert.deepEqual(r.body.order.map((p) => [p.id, p.position, p.priority]), rows().map((p) => [p.id, p.position, p.priority]));
  assert.equal((await post([pid.A, pid.A])).status, 400);
  assert.equal((await post([pid.A, pid.B, pid.C])).status, 200); // back to A, B, C for the UI tests
  assert.deepEqual(rows().map((p) => p.priority), [90, 50, 10]);
});

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript(() => localStorage.setItem('cw.lastSeen', String(Date.now())));
  const page = await ctx.newPage();
  const errors = [], posts = [];
  page.on('pageerror', (e) => { if (!/renderMetrics/.test(e.stack)) errors.push(e.message); });
  page.on('request', (q) => { if (q.url().endsWith('/api/orch/projects/reorder')) posts.push(q.postDataJSON().ids); });
  await page.goto(base + '/');
  await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
  await page.locator('#convoList .convo.rankable').nth(2).waitFor();
  return { page, ctx, errors, posts };
}
const order = (page) => page.$$eval('#convoList .convo.rankable', (cs) => cs.map((c) => c.dataset.cid));
const until = async (fn, what) => {
  for (const t0 = Date.now(); Date.now() - t0 < 8000; await new Promise((r) => setTimeout(r, 50))) if (await fn()) return;
  assert.fail(`timed out waiting for ${what}`);
};

test('dragging project C above A posts the new order', { skip }, async () => {
  const { page, ctx, errors, posts } = await open();
  try {
    const label = page.locator('#convoList .rank-label');
    assert.match(await label.innerText(), /Priority order/i);
    assert.equal(await label.locator('.rank-hint').innerText(), 'Drag to set priority');
    assert.deepEqual(await order(page), ['cA', 'cB', 'cC']);
    const a = await page.locator('#convoList .convo[data-cid="cA"]').boundingBox();
    const c = await page.locator('#convoList .convo[data-cid="cC"]').boundingBox();
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'project-order-list.png'), clip: { x: 0, y: 0, width: 320, height: 400 } });
    await page.mouse.move(c.x + 30, c.y + c.height / 2);
    await page.mouse.down();
    await page.mouse.move(c.x + 30, c.y + c.height / 2 - 10, { steps: 3 });
    await page.mouse.move(a.x + 30, a.y + 4, { steps: 8 });
    assert.equal(await page.locator('#convoList .convo.lifted').getAttribute('data-cid'), 'cC');
    assert.equal(await page.locator('#convoList .drop-indicator').isVisible(), true);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'project-order-drag.png'), clip: { x: 0, y: 0, width: 320, height: 400 } });
    const line = await page.locator('#convoList .drop-indicator').boundingBox();
    assert.ok(Math.abs(line.y - a.y) < 4, `the drop line sits above A (${line.y} vs ${a.y})`);
    await page.mouse.up();
    await until(() => posts.length, 'the reorder POST');
    assert.deepEqual(posts, [[pid.C, pid.A, pid.B]]);
    assert.equal(await page.locator('#convoList .convo.lifted, #convoList .drop-indicator').count(), 0);
    await until(() => rows()[0].id === pid.C, 'the server order');
    assert.deepEqual(rows().map((p) => [p.id, p.priority]), [[pid.C, 90], [pid.A, 50], [pid.B, 10]]);
    await until(async () => (await order(page)).join() === 'cC,cA,cB', 'the list to follow');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('Alt+↑/↓ on a focused row reorders by keyboard', { skip }, async () => {
  await post([pid.A, pid.B, pid.C]);
  const { page, ctx, errors, posts } = await open();
  try {
    await until(async () => (await order(page)).join() === 'cA,cB,cC', 'the starting order');
    await page.locator('#convoList .convo[data-cid="cB"]').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await until(() => posts.length === 1, 'the Alt+↑ POST');
    assert.deepEqual(posts[0], [pid.B, pid.A, pid.C]);
    await until(async () => (await order(page)).join() === 'cB,cA,cC', 'B on top');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.cid), 'cB', 'focus stays on the moved row');
    await page.keyboard.press('Alt+ArrowDown');
    await page.keyboard.press('Alt+ArrowDown');
    await until(() => posts.length === 3, 'two Alt+↓ POSTs');
    assert.deepEqual(posts[2], [pid.A, pid.C, pid.B]);
    await page.keyboard.press('Alt+ArrowDown'); // already last: nothing to post
    await until(() => rows()[2].id === pid.B, 'the server order');
    assert.equal(posts.length, 3);
    assert.deepEqual(rows().map((p) => [p.id, p.priority]), [[pid.A, 90], [pid.C, 50], [pid.B, 10]]);
    assert.match(await page.locator('#rankLive').textContent(), /: priority 3 of 3$/);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
