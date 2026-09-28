// gate-proxy.mjs with an http upstream (cfg.upstream.url) against the fake streamable http MCP: messages become POSTs that
// carry the session id initialize returned, JSON and SSE answers reach the client, an outbound call is held and a denied one
// never reaches the server, a failed POST becomes a JSON-RPC error, and a server that restarted (404 to the old session) gets
// a new session transparently.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { answer, readAudit } from '../gate.mjs';
import { waitFor } from './helpers/wait.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(root, 'test/fixtures/fake-http-mcp.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-proxy-http-')));
const LOG = path.join(tmp, 'requests.jsonl');
const fakes = [];
async function startFake(log) {
  const proc = spawn(process.execPath, [FAKE, log], { stdio: ['ignore', 'pipe', 'inherit'] });
  fakes.push(proc);
  return new Promise((resolve, reject) => {
    let buf = '';
    proc.stdout.on('data', (d) => { buf += d; if (buf.includes('\n')) resolve(buf.trim()); });
    proc.on('exit', () => reject(new Error('fake-http-mcp exited')));
  });
}
let url;
before(async () => { url = await startFake(LOG); });
after(() => { for (const f of fakes) f.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

const requests = (log = LOG) => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const txt = (r) => (r?.content || []).map((c) => c.text || '').join('\n');

// A minimal MCP client over stdio: initialize, then notifications/initialized, like a real one.
function mcp(command, args) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', id = 0, stderr = '';
  const waits = new Map(), seen = [];
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); seen.push(m); waits.get(m.id)?.(m); } });
  const write = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const rpc = (method, params) => new Promise((r) => { const n = ++id; waits.set(n, r); write({ id: n, method, params }); });
  return {
    init: async () => {
      const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
      write({ method: 'notifications/initialized' });
      return r;
    },
    rpc, seen, stderr: () => stderr,
    call: (name, args = {}) => rpc('tools/call', { name, arguments: args }),
    close: () => { child.stdin.end(); child.kill(); },
  };
}

// A proxy in front of the fixture, its config written like extensions.mjs gated() but with an http upstream.
function proxy(name, { base = url, query = '', headers } = {}) {
  const dir = path.join(tmp, name), cfg = path.join(dir, 'proxy-mail.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ dir, server: 'mail', kind: 'connector', task: null, ttlMs: 60_000, hook: false,
    upstream: { url: `${base}${query}`, ...(headers && { headers }) }, connector: { outbound: ['send_message'] } }));
  const c = mcp(process.execPath, [path.join(root, 'gate-proxy.mjs'), '--config', cfg]);
  const box = path.join(dir, 'approvals');
  const pending = () => { try { return fs.readdirSync(box).filter((n) => /^[\w-]+\.json$/.test(n) && !n.includes('answer') && !fs.existsSync(path.join(box, n.replace('.json', '.answer.json')))); } catch { return []; } };
  const approval = (n) => JSON.parse(fs.readFileSync(path.join(box, n), 'utf8'));
  return { c, dir, pending, approval, audit: () => readAudit(path.join(dir, 'audit.jsonl')) };
}

test('the session id initialize returned is sent from the second request on; tools/list reaches the client', async () => {
  fs.rmSync(LOG, { force: true });
  const p = proxy('session', { headers: { Authorization: 'Bearer t0k' } });
  try {
    const init = await p.c.init();
    assert.equal(init.result.serverInfo.name, 'fake-http');
    const list = await p.c.rpc('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name), ['send_message', 'read_inbox']);
    const r = requests();
    assert.deepEqual(r.map((x) => [x.rpc, x.session, x.status]), [
      ['initialize', null, 200], ['notifications/initialized', 'fake-session-1', 202], ['tools/list', 'fake-session-1', 200]]);
    assert.equal(r[2].protocol, '2025-06-18', 'the negotiated protocol version is sent too');
    assert.ok(r.every((x) => x.auth === 'Bearer t0k'), 'the configured headers go on every request');
  } finally { p.c.close(); }
});

test('a read call passes through and its JSON answer reaches the client, audited', async () => {
  const p = proxy('read');
  try {
    await p.c.init();
    const r = await p.c.call('lookup', { q: 'x' });
    assert.ok(!r.error);
    assert.match(txt(r.result), /lookup: done/);
    assert.deepEqual(p.pending(), []);
    const e = p.audit().find((x) => x.tool === 'lookup');
    assert.equal(e.class, 'read');
    assert.equal(e.ok, true);
  } finally { p.c.close(); }
});

test('an SSE-shaped answer is delivered, notifications in the stream too', async () => {
  const p = proxy('sse');
  try {
    await p.c.init();
    const r = await p.c.call('read_inbox');
    assert.equal(txt(r.result), 'inbox: 2 messages');
    assert.ok(p.c.seen.some((m) => m.method === 'notifications/message'), 'the stream\'s notification is forwarded');
    assert.ok(requests().some((x) => x.name === 'read_inbox' && x.sse));
  } finally { p.c.close(); }
});

test('?sse=1: every answer, initialize included, comes as SSE and still works', async () => {
  const p = proxy('allsse', { query: '?sse=1' });
  try {
    assert.equal((await p.c.init()).result.serverInfo.name, 'fake-http');
    assert.equal((await p.c.rpc('tools/list', {})).result.tools.length, 2);
    assert.match(txt((await p.c.call('lookup')).result), /lookup: done/);
    const mine = requests().filter((x) => x.url.includes('sse=1'));
    assert.ok(mine.filter((x) => x.rpc !== 'initialize').every((x) => x.session === 'fake-session-1'));
    assert.ok(mine.filter((x) => x.rpc === 'tools/call').every((x) => x.sse));
  } finally { p.c.close(); }
});

test('an outbound send_message is held; a deny makes it a tool error and nothing reaches the server; approve sends it', async () => {
  const p = proxy('outbound');
  try {
    await p.c.init();
    const sent = () => requests().filter((x) => x.name === 'send_message').length;
    const denied = p.c.call('send_message', { to: 'bob@example.com', body: 'hi' });
    await waitFor(() => p.pending().length === 1, { timeout: 10000 });
    const a = p.approval(p.pending()[0]);
    assert.equal(a.cls, 'outbound');
    assert.equal(a.tool, 'send_message');
    assert.equal(a.server, 'mail');
    assert.equal(sent(), 0, 'held, not forwarded');
    answer(p.dir, 'approvals', a.id, { decision: 'deny', reason: 'no' });
    const d = (await denied).result;
    assert.equal(d.isError, true);
    assert.match(txt(d), /denied this action.*It was NOT performed/s);
    assert.equal(sent(), 0, 'the denied call never reached the server');
    const ok = p.c.call('send_message', { to: 'bob@example.com', body: 'hi' });
    await waitFor(() => p.pending().length === 1, { timeout: 10000 });
    answer(p.dir, 'approvals', p.approval(p.pending()[0]).id, { decision: 'approve' });
    assert.match(txt((await ok).result), /send_message: done/);
    assert.equal(sent(), 1);
    assert.deepEqual(p.audit().filter((e) => e.tool === 'send_message').map((e) => [e.class, e.decision, e.ok]),
      [['outbound', 'deny', false], ['outbound', 'approve', true]]);
  } finally { p.c.close(); }
});

test('a 500 from the server becomes a JSON-RPC error, audited, and the next call still runs', async () => {
  const p = proxy('fail');
  try {
    await p.c.init();
    const r = await p.c.call('broken');
    assert.deepEqual(r.error, { code: -32603, message: 'gate: mail http 500' });
    const e = p.audit().find((x) => x.tool === 'broken');
    assert.equal(e.ok, false);
    assert.equal(e.result, 'gate: mail http 500');
    assert.match(txt((await p.c.call('lookup')).result), /lookup: done/);
  } finally { p.c.close(); }
});

test('an unreachable server: requests get a JSON-RPC error, not a hang', async () => {
  const dir = path.join(tmp, 'down'), cfg = path.join(dir, 'proxy-mail.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ dir, server: 'mail', kind: 'connector', ttlMs: 60_000, upstream: { url: 'http://127.0.0.1:1/mcp' } }));
  const c = mcp(process.execPath, [path.join(root, 'gate-proxy.mjs'), '--config', cfg]);
  try {
    const r = await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(r.error.code, -32603);
    assert.match(r.error.message, /^gate: mail http .*ECONNREFUSED/);
  } finally { c.close(); }
});

// A restarted server: POST <fake>/reset makes it forget the session (404) and hand out fake-session-2 on the next initialize.
const restart = (base, query = '') => fetch(`${base}/reset${query}`, { method: 'POST' });
const initResults = (c) => c.seen.filter((m) => m.result?.serverInfo);

test('a 404 to a stale session: initialize is sent again, its answer swallowed, and the call retried with the new session', async () => {
  const log = path.join(tmp, 'restart.jsonl'), base = await startFake(log);
  const p = proxy('restart', { base, headers: { Authorization: 'Bearer t0k' } });
  try {
    await p.c.init();
    assert.equal((await p.c.rpc('tools/list', {})).result.tools.length, 2);
    await restart(base);
    const n = p.c.seen.length;
    const list = await p.c.rpc('tools/list', {});
    assert.ok(!list.error, JSON.stringify(list.error));
    assert.deepEqual(list.result.tools.map((t) => t.name), ['send_message', 'read_inbox']);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(p.c.seen.slice(n).map((m) => m.id), [list.id], 'exactly one answer for the request, nothing else');
    assert.equal(initResults(p.c).length, 1, 'no stray initialize result reaches the client');
    const r = requests(log);
    assert.deepEqual(r.map((x) => [x.rpc, x.session, x.status]), [
      ['initialize', null, 200], ['notifications/initialized', 'fake-session-1', 202], ['tools/list', 'fake-session-1', 200],
      ['tools/list', 'fake-session-1', 404], ['initialize', null, 200], ['notifications/initialized', 'fake-session-2', 202],
      ['tools/list', 'fake-session-2', 200]]);
    assert.ok(r.every((x) => x.auth === 'Bearer t0k'), 'the re-initialize carries the configured headers too');
    assert.match(txt((await p.c.call('lookup')).result), /lookup: done/, 'later calls use the new session');
    assert.equal(requests(log).at(-1).session, 'fake-session-2');

    // Parallel calls that all hit the stale session share one re-initialize.
    await restart(base);
    const before = requests(log).length;
    const [a, b, c] = await Promise.all([p.c.rpc('tools/list', {}), p.c.call('lookup', { n: 1 }), p.c.rpc('tools/list', {})]);
    for (const x of [a, b, c]) assert.ok(!x.error, JSON.stringify(x.error));
    const again = requests(log).slice(before);
    assert.equal(again.filter((x) => x.rpc === 'initialize').length, 1, 'one re-initialize for all of them');
    assert.ok(again.filter((x) => x.status === 200 && x.rpc !== 'initialize').every((x) => x.session === 'fake-session-3'));
    assert.equal(initResults(p.c).length, 1);
  } finally { p.c.close(); }
});

test('a 404 that persists after one re-initialize is reported to the client as an error, not retried forever', async () => {
  const log = path.join(tmp, 'gone.jsonl'), base = await startFake(log);
  const p = proxy('gone', { base });
  try {
    await p.c.init();
    await restart(base, '?gone=1');
    const list = await p.c.rpc('tools/list', {});
    assert.deepEqual(list.error, { code: -32603, message: 'gate: mail http 404' });
    const r = requests(log);
    assert.equal(r.filter((x) => x.rpc === 'initialize').length, 2, 'initialize was sent again exactly once');
    assert.deepEqual(r.filter((x) => x.rpc === 'tools/list').map((x) => [x.session, x.status]),
      [['fake-session-1', 404], ['fake-session-2', 404]], 'the call was retried once, with the new session');
    const call = await p.c.call('lookup');
    assert.equal(call.error.message, 'gate: mail http 404', 'a tools/call fails the same way');
    assert.equal(initResults(p.c).length, 1);
  } finally { p.c.close(); }
});
