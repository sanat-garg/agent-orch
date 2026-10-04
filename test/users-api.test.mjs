// Multi-user (users.mjs + server.mjs): a login from before users existed stays signed in as the admin; a user sees and
// opens only their own chats, gets 403 for the admin's tools, and is refused a chat turn once over their cap; the admin
// manages accounts and caps; deleting a user signs them out and hands their chats over. The browser hides the admin's
// controls for a user and shows "Your usage".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_PW = 'admin-password-1', SAM_PW = 'sam-password-1', LEGACY = 'a'.repeat(64);
let child, base, dataDir, mine, theirs, browser, skipUi = false;
try { browser = await chromium.launch(); } catch (e) { skipUi = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const hash = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') }; };

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-users-api-'));
  mine = fs.mkdtempSync(path.join(os.homedir(), '.cw-users-admin-'));
  theirs = fs.mkdtempSync(path.join(os.homedir(), '.cw-users-sam-'));
  fs.writeFileSync(path.join(theirs, 'notes.txt'), 'hello');
  // The admin (as migrated from the old single password: alias 'claude') and sam, capped at 10% of the Fable week; and a
  // session from before users existed (no user: the admin's).
  fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify([
    { id: 'admin', name: 'admin', role: 'admin', aliases: ['claude'], ...hash(ADMIN_PW), caps: {} },
    { id: 'sam1', name: 'sam', role: 'user', ...hash(SAM_PW), caps: { 'claude/Fable': 10 } }]));
  fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify({ [LEGACY]: { exp: Date.now() + 864e5, remember: true } }));
  const chat = (id, cwd, extra) => ({ id, title: path.basename(cwd), cwd, mode: 'bypassPermissions', fullAccess: true, model: '', createdAt: 1000, updatedAt: 2000, ...extra });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([chat('a1', mine), chat('s1', theirs, { owner: 'sam1', model: 'claude-fable-5-1' })]));
  // This week: the account is at 40% of the Fable week; sam made 300 of its 1200 weighted tokens → about 10%.
  const resetsAt = Math.round(Date.now() / 1000) + 2 * 86400, t = Date.now() - 3600e3;
  fs.mkdirSync(path.join(dataDir, 'metrics'));
  fs.writeFileSync(path.join(dataDir, 'metrics', 'usage.jsonl'), [
    { t, agent: 'claude', kind: 'window', window: 'seven_day', pct: 50, resetsAt },
    { t, agent: 'claude', kind: 'window', window: 'Fable', pct: 40, resetsAt },
    { t, agent: 'claude', kind: 'tokens', input: 0, cached: 0, output: 300, source: 'chat', ref: 's1', user: 'sam1', model: 'claude-fable-5-1' },
    { t, agent: 'claude', kind: 'tokens', input: 0, cached: 0, output: 900, source: 'chat', ref: 'a1', model: 'claude-fable-5-1' },
  ].map((r) => JSON.stringify(r) + '\n').join(''));
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
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  for (const d of [dataDir, mine, theirs]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const login = async (username, password) => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  await r.arrayBuffer();
  return r.status === 200 ? r.headers.get('set-cookie').split(';')[0] : r.status;
};
const call = async (cookie, p, method = 'GET', body) => {
  const r = await fetch(base + p, { method, headers: { cookie, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json };
};
// A websocket client: collects messages; next(pred) waits for one.
function socket(cookie) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie } });
  const got = [], waiters = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw); got.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const next = (pred, ms = 5000) => {
    const hit = got.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => { const w = { pred, resolve }; waiters.push(w); setTimeout(() => reject(new Error('no such message')), ms); });
  };
  return { ws, got, next, opened: new Promise((r) => ws.on('open', r)) };
}

let admin, sam;
test('a login from before users existed is still the admin; the admin signs in by name, blank or the old "claude"', async () => {
  const legacy = `cw_session=${LEGACY}`;
  const me = await call(legacy, '/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'admin');
  assert.equal((await call(legacy, '/api/convos')).body.map((c) => c.id).join(), 'a1', "the admin's sidebar lists only their own chats");
  for (const name of ['', 'admin', 'claude']) assert.equal(typeof (await login(name, ADMIN_PW)), 'string', `signs in as "${name}"`);
  assert.equal(await login('admin', SAM_PW), 401);
  admin = legacy;
  sam = await login('sam', SAM_PW);
  assert.equal(typeof sam, 'string');
});

test("a user sees only their own work and none of the admin's tools", async () => {
  const me = await call(sam, '/api/me');
  assert.equal(me.body.user.name, 'sam');
  const fable = me.body.usage.find((w) => w.window === 'Fable');
  assert.deepEqual({ mine: fable.mine, cap: fable.cap, label: fable.label }, { mine: 10, cap: 10, label: 'Claude · Fable' });
  assert.equal((await call(sam, '/api/convos')).body.map((c) => c.id).join(), 's1');
  assert.equal((await call(sam, '/api/convos/a1', 'PATCH', { title: 'x' })).status, 403);
  assert.equal((await call(sam, '/api/files/list?cid=a1')).status, 403);
  assert.equal((await call(sam, '/api/files/list?cid=s1&path=/etc')).status, 403, 'no absolute paths');
  assert.equal((await call(sam, '/api/files/list?cid=s1')).status, 200);
  assert.equal((await call(sam, '/api/files/copy', 'POST', { cid: 's1', paths: ['/etc/passwd'], dest: '.' })).status, 403);
  assert.equal((await call(sam, '/api/projects')).body.projects.length, 0, "the admin's folders aren't listed");
  for (const p of ['/api/users', '/api/cluster/nodes', '/api/connections', '/api/stats', '/api/terminals', '/api/settings', '/api/orch/gate', '/api/usage/history'])
    assert.equal((await call(sam, p)).status, 403, p);
  assert.equal((await call(sam, '/api/convos', 'POST', { folder: mine })).status, 403, "can't open the admin's project");
  // The terminal (Caddy's forward_auth) is the admin's only.
  assert.equal((await fetch(base + '/auth/check', { headers: { cookie: sam } })).status, 401);
  assert.equal((await fetch(base + '/auth/check', { headers: { cookie: admin } })).status, 200);
});

test('websocket: a user gets only their chats, and no turn past their cap', async () => {
  const s = socket(sam);
  await s.opened;
  const list = await s.next((m) => m.t === 'convos');
  assert.deepEqual(list.convos.map((c) => c.id), ['s1']);
  assert.ok(!s.got.some((m) => m.t === 'usage'), "the account's plan usage is the admin's");
  s.ws.send(JSON.stringify({ t: 'open', cid: 'a1' }));
  s.ws.send(JSON.stringify({ t: 'open', cid: 's1' }));
  await s.next((m) => m.t === 'history' && m.cid === 's1');
  assert.ok(!s.got.some((m) => m.cid === 'a1'), "the admin's chat never opens");
  s.ws.send(JSON.stringify({ t: 'send', cid: 's1', text: 'hello' }));
  const err = await s.next((m) => m.t === 'error' && m.cid === 's1');
  assert.match(err.text, /reached your 10% cap of the Claude · Fable weekly limit/);
  s.ws.close();
  const a = socket(admin);
  await a.opened;
  assert.deepEqual((await a.next((m) => m.t === 'convos')).convos.map((c) => c.id), ['a1'], "the admin's sidebar lists only their own chats too");
  a.ws.close();
});

test('the admin manages accounts: caps, role rules, delete hands the chats over and signs them out', async () => {
  const list = await call(admin, '/api/users');
  assert.deepEqual(list.body.users.map((u) => u.name), ['admin', 'sam']);
  assert.equal(list.body.users.find((u) => u.name === 'sam').usage.find((w) => w.window === 'Fable').mine, 10);
  assert.deepEqual((await call(admin, '/api/users/sam1', 'PATCH', { caps: { 'claude/Fable': 50, 'claude/seven_day': 20 } })).body.user.caps, { 'claude/Fable': 50, 'claude/seven_day': 20 });
  assert.equal((await call(sam, '/api/me')).body.usage.find((w) => w.window === 'Fable').cap, 50);
  assert.equal((await call(admin, '/api/users/admin', 'PATCH', { role: 'user' })).status, 409);
  assert.equal((await call(admin, '/api/users/admin', 'DELETE')).status, 409);
  const kim = await call(admin, '/api/users', 'POST', { name: 'kim', password: 'kim-password' });
  assert.equal(kim.status, 200);
  assert.equal((await call(admin, '/api/users', 'POST', { name: 'kim', password: 'kim-password' })).status, 409);
  const del = await call(admin, '/api/users/sam1', 'DELETE');
  assert.deepEqual(del.body, { ok: true, moved: 1 });
  assert.equal((await call(sam, '/api/me')).status, 401, 'signed out');
  assert.deepEqual((await call(admin, '/api/convos')).body.map((c) => c.id).sort(), ['a1', 's1']);
});

test('browser: a user sees "Your usage" and none of the admin\'s controls', { skip: skipUi }, async () => {
  const kim = await login('kim', 'kim-password');
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.context().addCookies([{ name: 'cw_session', value: kim.split('=')[1], url: base }]);
  await page.goto(base + '/');
  await page.waitForFunction(() => document.documentElement.dataset.role === 'user');
  for (const id of ['#statsBtn', '#usageCard', '#miniMachine', '#previewsBtn', '#browserTab'])
    assert.equal(await page.isVisible(id), false, `${id} hidden`);
  assert.equal(await page.isVisible('#myUsage'), true);
  await page.click('#settingsBtn');
  assert.equal(await page.textContent('#stMeName'), 'Signed in as kim');
  assert.equal(await page.isVisible('#stUsersOpen'), false);
  assert.equal(await page.isVisible('#stParallel'), false);
  await page.close();
  // The admin's Settings has Users, and its sheet lists everyone with their caps.
  const adm = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await adm.context().addCookies([{ name: 'cw_session', value: LEGACY, url: base }]);
  await adm.goto(base + '/');
  await adm.waitForFunction(() => document.documentElement.dataset.role === 'admin');
  await adm.click('#settingsBtn');
  await adm.click('#stUsersOpen');
  await adm.waitForSelector('.um-user');
  assert.deepEqual(await adm.$$eval('.um-name', (els) => els.map((e) => e.textContent)), ['admin', 'kim']);
  await adm.close();
});
