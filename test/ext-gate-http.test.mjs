// The whole path for an http connector in a gated run: extensions.mjs mcpFor turns it into a stdio entry for gate-proxy.mjs,
// and that entry, spawned as the agent CLI would, reaches the real (fake) streamable http server and audits the call.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createExtensions } from '../extensions.mjs';
import { readAudit } from '../gate.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ext-gate-http-')));
const LOG = path.join(tmp, 'requests.jsonl');
let fake, url;
before(async () => {
  fake = spawn(process.execPath, [path.join(root, 'test/fixtures/fake-http-mcp.mjs'), LOG], { stdio: ['ignore', 'pipe', 'inherit'] });
  url = await new Promise((resolve, reject) => {
    let buf = '';
    fake.stdout.on('data', (d) => { buf += d; if (buf.includes('\n')) resolve(buf.trim()); });
    fake.on('exit', () => reject(new Error('fake-http-mcp exited')));
  });
});
after(() => { fake?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

const requests = () => { try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// A minimal MCP client over stdio for the entry mcpFor returned.
function client({ command, args, env }) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 0;
  const waits = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waits.get(m.id)?.(m); } });
  const write = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  const rpc = (method, params) => new Promise((r) => { const n = ++id; waits.set(n, r); write({ id: n, method, params }); });
  return { rpc, notify: (method) => write({ method }), close: () => { child.stdin.end(); child.kill(); } };
}

test('an http connector in a gated claude run goes through the gate proxy to the server, and its calls are audited', { timeout: 30000 }, async () => {
  const home = path.join(tmp, 'home'), dir = path.join(tmp, 'gate');
  fs.mkdirSync(dir, { recursive: true });
  const x = createExtensions({ dataDir: path.join(home, 'data'), home });
  x.saveMcp({ name: 'mail', type: 'http', url, headers: 'Authorization: Bearer t0k', outbound: 'send_message', agents: ['claude'] });
  const withheld = [];
  const run = x.mcpFor('claude', { gate: { dir, task: 7, ttlMs: 60_000 }, onWithheld: (...a) => withheld.push(a) });
  assert.deepEqual(withheld, []);
  assert.equal(run.mail.type, 'stdio');
  assert.equal(run.mail.command, process.execPath);
  assert.deepEqual(run.mail.args, [path.join(root, 'gate-proxy.mjs'), '--config', path.join(dir, 'proxy-mail.json')]);

  const c = client(run.mail);
  try {
    const init = await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'fake-http');
    c.notify('notifications/initialized');
    const list = await c.rpc('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name), ['send_message', 'read_inbox']);
    const r = await c.rpc('tools/call', { name: 'read_inbox', arguments: {} });
    assert.equal(r.result.content[0].text, 'inbox: 2 messages');

    assert.deepEqual(requests().map((q) => [q.rpc, q.name, q.session]), [
      ['initialize', null, null], ['notifications/initialized', null, 'fake-session-1'], ['tools/list', null, 'fake-session-1'],
      ['tools/call', 'read_inbox', 'fake-session-1']]);
    assert.ok(requests().every((q) => q.auth === 'Bearer t0k'), "the connector's headers reach the server");
    const e = readAudit(path.join(dir, 'audit.jsonl')).find((a) => a.tool === 'read_inbox');
    assert.ok(e, 'the call is in the gate dir audit.jsonl');
    assert.equal(e.server, 'mail');
    assert.equal(e.class, 'read');
    assert.equal(e.ok, true);
  } finally { c.close(); }
});
