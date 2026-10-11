// Rewinding and deleting a prompt (server.mjs rewindChat / deletePrompt, POST /api/convos/:id/messages/:ts/rewind,
// DELETE /api/convos/:id/messages/:ts; public/app.js promptMeta). A chat turn's commit is a 'commit' event in its log;
// rewinding with code undoes those after the prompt as one new commit, keeping commits the chat didn't make (a task's
// merge), and cuts the log there. Chat-only keeps the commit events so a later rewind still undoes them. Delete drops a
// prompt and its reply and tells the session to disregard it. Edit rewinds and resends the new text. Each prompt shows
// when it was sent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'rewind-password';
let child, base, dataDir, proj, origin, cookie, browser, skip = false;
const sha = {};
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const jsonl = (evs) => evs.map((e) => JSON.stringify(e) + '\n').join('');
const readLog = (id) => fs.readFileSync(path.join(dataDir, 'logs', `${id}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: proj, encoding: 'utf8' }).trim();
const commit = (file, text, msg) => { fs.writeFileSync(path.join(proj, file), text); git('add', '-A'); git('commit', '-qm', msg); return git('rev-parse', 'HEAD'); };
const read = (file) => (fs.existsSync(path.join(proj, file)) ? fs.readFileSync(path.join(proj, file), 'utf8') : null);

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rewind-'));
  proj = fs.mkdtempSync(path.join(os.homedir(), '.cw-rewind-proj-')); // chat folders must be inside the home directory
  origin = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rewind-origin-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', proj]);
  fs.writeFileSync(path.join(proj, '.gitignore'), '.agent-orch/shots/\n');
  commit('a.txt', 'v0\n', 'Project created');
  sha.p1 = commit('a.txt', 'v1\n', 'Chat: make it v1');
  sha.p2 = commit('b.txt', 'bee\n', 'Chat: add b');
  sha.task = commit('c.txt', 'from a task\n', 'Merge task #7'); // not the chat's: a rewind keeps it
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: 'c1', title: 'proj', renamed: true, cwd: proj, mode: 'bypassPermissions',
    fullAccess: true, model: '', createdAt: 1000, updatedAt: 4000, sessionId: 'sess-1', repo: { full: null, url: origin } }]));
  fs.mkdirSync(path.join(dataDir, 'logs'));
  const t0 = Date.now() - 3600e3;
  sha.ts = [t0, t0 + 60e3, t0 + 120e3];
  fs.writeFileSync(path.join(dataDir, 'logs', 'c1.jsonl'), jsonl([
    { t: 'user', text: 'make it v1', ts: sha.ts[0] }, { t: 'text', text: 'Done: v1.', ts: sha.ts[0] + 10 }, { t: 'commit', sha: sha.p1, ts: sha.ts[0] + 20 },
    { t: 'user', text: 'add b', ts: sha.ts[1] }, { t: 'text', text: 'Added b.', ts: sha.ts[1] + 10 }, { t: 'commit', sha: sha.p2, ts: sha.ts[1] + 20 },
    { t: 'user', text: 'what did you do?', ts: sha.ts[2] }, { t: 'text', text: 'I added b.', ts: sha.ts[2] + 10 },
  ]));
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
  for (const d of [dataDir, proj, origin]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const call = async (p, method = 'GET', body) => {
  const r = await fetch(base + p, { method, headers: { cookie, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const convo = async () => (await call('/api/convos')).body.find((c) => c.id === 'c1');

test('each prompt shows when it was sent; rewinding chat-only from the page refills the composer', { skip }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.goto(base + '/#c1');
  await pg.locator('#app:not([inert])').waitFor();
  await pg.locator('.msg-meta').nth(2).waitFor();
  assert.equal(await pg.locator('.msg-meta').count(), 3);
  const time = pg.locator('.msg-meta .mm-time').first();
  assert.match(await time.textContent(), /\d:\d\d/);
  assert.equal(await time.getAttribute('datetime'), new Date(sha.ts[0]).toISOString());
  // Actions show on hover; Rewind opens a menu with both choices.
  await pg.locator('.msg.user').nth(2).hover();
  await pg.locator('.msg-meta').nth(2).locator('.mm-rewind').click();
  const menu = pg.locator('.rewind-menu');
  assert.deepEqual(await menu.locator('.rw-l').allTextContents(), ['Rewind code and chat', 'Rewind chat only', 'Cancel']);
  await menu.getByText('Rewind chat only').click();
  await pg.waitForFunction(() => document.querySelectorAll('.msg.user').length === 2);
  assert.equal(await pg.locator('#input').inputValue(), 'what did you do?');
  assert.equal(read('b.txt'), 'bee\n', 'chat-only leaves the files');
  assert.deepEqual(errors, []);
  await ctx.close();
  const c = await convo();
  assert.equal(c.sessionId, null, 'the session is dropped');
  assert.match(c.rewindRecap.recap, /add b/);
});

test('delete drops a prompt and its reply but keeps its commit record, and the session is told', async () => {
  // Re-add a third prompt after the rewind above (or on its own when the browser test is skipped).
  const log = readLog('c1').filter((e) => e.ts < sha.ts[2]);
  fs.writeFileSync(path.join(dataDir, 'logs', 'c1.jsonl'), jsonl(log));
  let r = await call(`/api/convos/c1/messages/${sha.ts[1]}`, 'DELETE');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = readLog('c1');
  assert.deepEqual(after.filter((e) => e.t === 'user').map((e) => e.text), ['make it v1']);
  assert.ok(!after.some((e) => e.text === 'Added b.'), 'its reply goes too');
  assert.ok(after.some((e) => e.t === 'commit' && e.sha === sha.p2), 'its commit stays rewindable');
  assert.equal(read('b.txt'), 'bee\n', 'files are untouched');
  r = await call('/api/convos/c1/messages/12345', 'DELETE');
  assert.equal(r.status, 404);
});

test('rewinding with code undoes only the chat\'s commits after the prompt, as one pushed commit', async () => {
  const r = await call(`/api/convos/c1/messages/${sha.ts[0]}/rewind`, 'POST', { code: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.text, 'make it v1');
  assert.equal(r.body.reverted, 2);
  assert.equal(read('a.txt'), 'v0\n');
  assert.equal(read('b.txt'), null);
  assert.equal(read('c.txt'), 'from a task\n', "the task's merge stays");
  assert.match(git('log', '-1', '--format=%s'), /^Rewind chat to before: make it v1/);
  assert.equal(git('status', '--porcelain'), '');
  assert.deepEqual(readLog('c1'), [], 'the log is cut at the prompt, commit records included');
  const c = await convo();
  assert.equal(c.rewindRecap.reverted, 2);
  for (let i = 0; i < 50 && execFileSync('git', ['rev-parse', 'main'], { cwd: origin, encoding: 'utf8' }).trim() !== git('rev-parse', 'HEAD'); i++) await new Promise((res) => setTimeout(res, 200));
  assert.equal(execFileSync('git', ['rev-parse', 'main'], { cwd: origin, encoding: 'utf8' }).trim(), git('rev-parse', 'HEAD'), 'the rewind is pushed');
});

test('editing a prompt rewinds to before it, code included, and sends the edited text with its attachments', { skip }, async () => {
  const p3 = commit('d.txt', 'dee\n', 'Chat: add d');
  const t = Date.now() - 600e3, att = { id: 'u'.repeat(32), name: 'spec.md', size: 3, type: 'text/markdown' };
  fs.writeFileSync(path.join(dataDir, 'logs', 'c1.jsonl'), jsonl([
    { t: 'user', text: 'add d', ts: t, attachments: [att] }, { t: 'text', text: 'Added d.', ts: t + 10 }, { t: 'commit', sha: p3, ts: t + 20 },
  ]));
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const pg = await ctx.newPage();
  const errors = [], sent = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  // The resend is caught here so no real agent turn starts.
  await pg.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => { const msg = JSON.parse(m); if (msg.t === 'send') sent.push(msg); else server.send(m); });
    server.onMessage((m) => ws.send(m));
  });
  await pg.goto(base + '/#c1');
  await pg.locator('#app:not([inert])').waitFor();
  await pg.locator('.msg.user').first().hover();
  await pg.locator('.msg-meta .mm-edit').click();
  const box = pg.locator('.msg.user.editing .msg-edit');
  assert.equal(await box.inputValue(), 'add d');
  assert.equal(await pg.locator('.msg.user.editing .msg-atts .att-file').count(), 1, 'its attachments stay shown');
  // Esc puts the bubble back untouched.
  await box.press('Escape');
  assert.equal(await pg.locator('.msg.user.editing').count(), 0);
  assert.equal(await pg.locator('.msg.user').first().evaluate((b) => b.firstChild.textContent), 'add d');
  await pg.locator('.msg.user').first().hover();
  await pg.locator('.msg-meta .mm-edit').click();
  assert.equal(await pg.locator('.msg-edit-undo input').isChecked(), true, 'undoing the code is the default');
  await box.fill('add e instead');
  await box.press('Enter');
  await pg.waitForFunction(() => document.querySelectorAll('.msg.user').length === 0);
  for (let i = 0; i < 50 && !sent.length; i++) await new Promise((res) => setTimeout(res, 100));
  assert.deepEqual(sent, [{ t: 'send', cid: 'c1', text: 'add e instead', attachments: [att.id] }]);
  assert.equal(read('d.txt'), null, "the old prompt's code change is undone");
  assert.deepEqual(readLog('c1'), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});
