// Remote sign-in (remote-login.mjs): the controller proxies Connect / code / Cancel for a worker machine over the
// cluster socket as login.* frames. A fake worker answers them here (the login state round-trip and code forwarding
// through the real server), and the worker side (createNodeLogins) runs a stub CLI in the `script` pty fallback.
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
import { PROTOCOL_VERSION, WS_PATH, PAIR_PATH, CLAIM_PATH, createSender } from '../cluster-protocol.mjs';
import { createNodeLogins, wireState } from '../remote-login.mjs';
import { ptyRunner } from '../connections.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'remote-login-password';
let child, base, dataDir, cookie, out = '';
const workers = [];

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const api = async (p, method = 'GET', body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const agent = (id, signedIn, account = null) => ({ id, installed: true, signedIn, account, version: '1.0.0', models: signedIn ? [{ id: 'm1' }] : [] });

// A paired, helloed fake worker that reports `agents` in its inventory and records every frame it receives.
async function fakeWorker(name, agents) {
  const { code } = (await api(PAIR_PATH, 'POST')).body;
  const r = await fetch(base + CLAIM_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name, os: 'darwin', arch: 'arm64' }) });
  const { node, token } = await r.json();
  const ws = new WebSocket(base.replace('http', 'ws') + WS_PATH, { headers: { authorization: `Bearer ${token}` } });
  const frames = [];
  ws.on('message', (d) => frames.push(JSON.parse(d)));
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const sender = createSender('w');
  const send = (t, f) => ws.send(sender(t, f));
  send('hello', { node, protocol: PROTOCOL_VERSION, version: 'test', jobs: [] });
  await waitFor(() => frames.find((f) => f.t === 'welcome'), { timeout: 5000 });
  send('inventory', { node, name, os: 'darwin', arch: 'arm64', cores: 8, mem: 16e9, agents, versions: {} });
  const w = { node, ws, frames, send, next: (t) => waitFor(() => frames.find((f) => f.t === t && !f.seen && (f.seen = true)), { timeout: 5000 }) };
  workers.push(w);
  return w;
}
const rows = async (node) => (await api(`/api/connections?node=${node}`)).body.connections;
const row = async (node, id) => (await rows(node)).find((c) => c.id === id);

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rlogin-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' } });
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

after(() => {
  for (const w of workers) w.ws.terminate();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('remote sign-in: login.start → login.state round-trip, pasted code forwarded, cancel', async () => {
  const w = await fakeWorker('mac-1', [agent('claude', false), agent('codex', true, 'me@example.com')]);
  await waitFor(async () => (await rows(w.node))?.length === 2, { timeout: 5000 });
  const claude = await row(w.node, 'claude');
  assert.equal(claude.signedIn, false);
  assert.equal(claude.canLogin, true);
  assert.equal((await row(w.node, 'codex')).account, 'me@example.com');
  assert.equal((await api('/api/connections?node=n_nope')).status, 404);

  const s = await api(`/api/connections/claude/start?node=${w.node}`, 'POST', {});
  assert.equal(s.status, 200);
  assert.equal(s.body.login.state, 'waiting');
  const start = await w.next('login.start');
  assert.equal(start.agent, 'claude');
  const url = 'https://claude.ai/oauth/authorize?code=true&x=1';
  w.send('login.state', { login: start.login, state: 'waiting_code', url });
  await waitFor(async () => (await row(w.node, 'claude')).login?.url === url, { timeout: 5000 });
  const l = (await row(w.node, 'claude')).login;
  assert.equal(l.state, 'waiting');
  assert.equal(l.needsPastedCode, true);

  const c = await api(`/api/connections/claude/code?node=${w.node}`, 'POST', { code: '  abc#123-XYZ ' });
  assert.equal(c.status, 200);
  const fwd = await w.next('login.code');
  assert.deepEqual([fwd.login, fwd.code], [start.login, 'abc#123-XYZ']);
  assert.equal((await api(`/api/connections/claude/code?node=${w.node}`, 'POST', { code: 'a\nb' })).status, 400);

  w.send('login.state', { login: start.login, state: 'done', account: 'me@example.com' });
  await waitFor(async () => (await row(w.node, 'claude')).login?.state === 'done', { timeout: 5000 });
  // A stale login id (or another node's) changes nothing.
  w.send('login.state', { login: start.login, state: 'failed', message: 'late' });

  // Cancel: the worker is told, and the row shows cancelled at once.
  const s2 = await api(`/api/connections/claude/start?node=${w.node}`, 'POST', {});
  const start2 = await w.next('login.start');
  assert.notEqual(start2.login, start.login);
  assert.equal(s2.body.login.state, 'waiting');
  const x = await api(`/api/connections/claude/cancel?node=${w.node}`, 'POST', {});
  assert.equal(x.body.login.state, 'cancelled');
  assert.equal((await w.next('login.cancel')).login, start2.login);

  // A failure the worker reports reaches the row with its message.
  await api(`/api/connections/claude/start?node=${w.node}`, 'POST', {});
  const start3 = await w.next('login.start');
  w.send('login.state', { login: start3.login, state: 'failed', message: 'tmux not found' });
  await waitFor(async () => (await row(w.node, 'claude')).login?.error === 'tmux not found', { timeout: 5000 });
});

test('remote sign-out asks for confirmation for Claude, then waits for the worker', async () => {
  const w = await fakeWorker('vps-2', [agent('claude', true, 'owner@example.com'), agent('codex', false)]);
  await waitFor(async () => (await rows(w.node))?.length === 2, { timeout: 5000 });
  const warn = await api(`/api/connections/claude/logout?node=${w.node}`, 'POST', {});
  assert.equal(warn.status, 409);
  assert.equal(warn.body.needsConfirm, true);
  assert.match(warn.body.error, /vps-2/);
  const done = api(`/api/connections/claude/logout?node=${w.node}`, 'POST', { confirm: true });
  const lo = await w.next('login.logout');
  assert.equal(lo.agent, 'claude');
  w.send('login.state', { login: lo.login, state: 'signed_out' });
  assert.equal((await done).status, 200);
});

test('the same account on two machines is marked as sharing limits', async () => {
  const a = await fakeWorker('mac-a', [agent('claude', false), agent('codex', true, 'Shared@Example.com')]);
  const b = await fakeWorker('mac-b', [agent('claude', false), agent('codex', true, 'shared@example.com')]);
  await waitFor(async () => (await row(b.node, 'codex'))?.sharedWith?.includes('mac-a'), { timeout: 5000 });
  assert.ok((await row(a.node, 'codex')).sharedWith.includes('mac-b'));
  assert.deepEqual((await row(a.node, 'claude')).sharedWith, []);
});

test('worker side: a stub CLI in the script pty streams its URL, takes the forwarded code and reports done', { timeout: 20000 }, async () => {
  const sent = [], sender = createSender('w');
  const send = (t, f) => { sender(t, f); sent.push({ t, ...f }); return true; }; // sender() validates the frame
  const cli = 'echo "Open https://claude.ai/oauth/authorize?client=x"; printf "Paste code here > "; read c; [ "$c" = "good-code" ] && echo "Login successful"';
  let changedFor = null;
  const logins = createNodeLogins({
    send, pollMs: 50, tmux: ptyRunner(), afterChange: (id) => { changedFor = id; },
    entries: [{ id: 'claude', label: 'Claude Code', installed: () => true, signedIn: () => false, account: () => 'me@example.com',
      spec: { start: ['sh', '-c', cli], url: /(https:\/\/claude\.ai\/\S*oauth\/authorize\S+)/, needsPastedCode: true, successRe: /Login successful/i },
      afterChange: () => { changedFor = 'claude'; } }],
  });
  await logins.handle({ t: 'login.start', login: 'l_1', agent: 'claude' });
  assert.equal(sent[0].state, 'starting');
  await waitFor(() => sent.find((f) => f.state === 'waiting_code'), { timeout: 5000 });
  assert.equal(sent.find((f) => f.state === 'waiting_code').url, 'https://claude.ai/oauth/authorize?client=x');
  assert.equal(logins.active(), true);
  await logins.handle({ t: 'login.code', login: 'l_1', code: 'good-code' });
  const done = await waitFor(() => sent.find((f) => f.state === 'done'), { timeout: 5000 });
  assert.equal(done.login, 'l_1');
  assert.equal(changedFor, 'claude');
  assert.equal(logins.active(), false);
  // A code for a login this machine doesn't have fails cleanly.
  await logins.handle({ t: 'login.code', login: 'l_nope', code: 'x' });
  assert.equal(sent.at(-1).state, 'failed');
});

test('wireState maps connections.mjs logins onto the protocol states', () => {
  assert.equal(wireState({ state: 'waiting' }), 'starting');
  assert.equal(wireState({ state: 'waiting', url: 'u', needsPastedCode: false }), 'url');
  assert.equal(wireState({ state: 'waiting', url: 'u', needsPastedCode: true }), 'waiting_code');
  assert.equal(wireState({ state: 'cancelled' }), 'cancelled');
});
