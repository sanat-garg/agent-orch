// mcp-probe.mjs: a stdio or streamable-HTTP MCP server's tools, or one line saying why not; nothing is left running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeMcp } from '../mcp-probe.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-mcp.mjs', import.meta.url));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('stdio: initialize + tools/list against the fake server', async () => {
  const r = await probeMcp({ name: 'fake', type: 'stdio', command: process.execPath, args: [FAKE], env: {} });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.serverInfo, { name: 'fake', version: '1' });
  assert.equal(r.protocolVersion, '2025-06-18');
  assert.deepEqual(r.tools, [{ name: 'echo', description: 'Echoes its input' }, { name: 'add', description: 'Adds two numbers' }]);
  assert.equal(typeof r.ms, 'number');
});

test('stdio: a command that does not exist', async () => {
  const r = await probeMcp({ name: 'x', type: 'stdio', command: 'no-such-mcp-server-xyz', args: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /no-such-mcp-server-xyz/);
  assert.ok(r.error.length <= 300 && !r.error.includes('\n'));
});

test('stdio: a server that exits before answering reports its last stderr line', async () => {
  const r = await probeMcp({ type: 'stdio', command: process.execPath, args: ['-e', 'console.error("first"); console.error("bad token"); process.exit(3)'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /code 3/);
  assert.match(r.error, /bad token/);
});

test('stdio: a server that never answers times out and is killed', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-probe-'));
  const pidFile = path.join(tmp, 'pid');
  try {
    const r = await probeMcp({ type: 'stdio', command: process.execPath,
      args: ['-e', 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', pidFile] }, { timeoutMs: 500 });
    assert.equal(r.ok, false);
    assert.match(r.error, /timed out/);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0);
    assert.equal(alive(pid), false, `pid ${pid} is still running`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

function serve(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s));
  });
}
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => resolve(b)); });

test('http: JSON answers, headers passed and the session id honoured', async () => {
  const seen = [];
  const s = await serve(async (req, res) => {
    if (req.method === 'DELETE') { seen.push({ method: 'DELETE', session: req.headers['mcp-session-id'] }); return res.end(); }
    const m = JSON.parse(await readBody(req));
    seen.push({ method: m.method, session: req.headers['mcp-session-id'], auth: req.headers.authorization, accept: req.headers.accept });
    if (m.id == null) { res.writeHead(202); return res.end(); }
    const result = m.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'web', version: '2' } }
      : { tools: [{ name: 'search', description: 'Searches' }, { name: 'fetch' }] };
    res.writeHead(200, { 'content-type': 'application/json', ...(m.method === 'initialize' && { 'mcp-session-id': 'sess-1' }) });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  });
  try {
    const url = `http://127.0.0.1:${s.address().port}/mcp`;
    const r = await probeMcp({ name: 'web', type: 'http', url, headers: { Authorization: 'Bearer t0k' } });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.serverInfo, { name: 'web', version: '2' });
    assert.deepEqual(r.tools, [{ name: 'search', description: 'Searches' }, { name: 'fetch', description: '' }]);
    const posts = seen.filter((x) => x.method !== 'DELETE');
    assert.deepEqual(posts.map((x) => x.method), ['initialize', 'notifications/initialized', 'tools/list']);
    assert.deepEqual(posts.map((x) => x.session), [undefined, 'sess-1', 'sess-1']);
    assert.ok(posts.every((x) => x.auth === 'Bearer t0k' && x.accept === 'application/json, text/event-stream'));
  } finally { s.closeAllConnections(); s.close(); }
});

test('http: an event-stream answer', async () => {
  const s = await serve(async (req, res) => {
    if (req.method === 'DELETE') return res.end();
    const m = JSON.parse(await readBody(req));
    if (m.id == null) { res.writeHead(202); return res.end(); }
    const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'sse-body' } } : { tools: [{ name: 'one', description: 'One' }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`);
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`); // left open
  });
  try {
    const r = await probeMcp({ type: 'http', url: `http://127.0.0.1:${s.address().port}/` }, { timeoutMs: 5000 });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.tools, [{ name: 'one', description: 'One' }]);
  } finally { s.closeAllConnections(); s.close(); }
});

test('http: status 500 and sse type are one-line failures', async () => {
  const s = await serve((req, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom\nstack'); });
  try {
    const r = await probeMcp({ type: 'http', url: `http://127.0.0.1:${s.address().port}/mcp` });
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 500/);
    assert.ok(!r.error.includes('\n'));
    assert.equal(typeof r.ms, 'number');
  } finally { s.closeAllConnections(); s.close(); }
  const sse = await probeMcp({ type: 'sse', url: 'http://127.0.0.1:1/sse' });
  assert.equal(sse.ok, false);
  assert.equal(sse.error, 'SSE servers cannot be probed yet');
});
