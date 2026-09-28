// A worker's status daemon socket (worker-status.mjs serveStatus/request) over a real unix socket in a temp home:
// answers in request order on one connection (and {ok:false} when answer throws), a stale socket file left by a dead
// daemon replaced, a second daemon on a live home refused, an over-long line dropping only that client, a socket path
// past ~100 characters still bound and dialled, close() removing the file and dropping clients, and request's errors
// when nobody listens (ENOENT, ECONNREFUSED). renderStatus is covered in test/worker-cap.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { request, serveStatus, socketPath } from '../worker-status.mjs';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')); });
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });
const home = () => fs.mkdtempSync(path.join(tmp, 'h'));

// A raw client: connect, then collect the reply lines and whether the server closed it.
function client(file) {
  const sock = net.connect(file), lines = [];
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  sock.on('error', () => {});
  const closed = new Promise((r) => sock.once('close', r));
  const connected = new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
  return { sock, lines, closed, connected };
}
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`timed out: ${what}`); })]);

test('status gets the answer; three requests on one connection are answered in order; a throwing answer gives ok:false', async () => {
  const h = home();
  const d = await serveStatus({ home: h, answer: async (req) => {
    if (req?.op === 'boom') throw new Error('it broke');
    if (req?.delay) await sleep(req.delay);
    return { ok: true, op: req?.op, n: req?.n };
  } });
  let c;
  try {
    assert.equal(d.file, socketPath(h));
    assert.deepEqual(await request(h, { op: 'status' }), { ok: true, op: 'status' });
    assert.deepEqual(await request(h, { op: 'boom' }), { ok: false, error: 'it broke' });
    c = client(d.file);
    await c.connected;
    // The first answer resolves last, yet the replies come back in request order.
    c.sock.write(`${[{ op: 'status', n: 1, delay: 80 }, { op: 'status', n: 2 }, { op: 'status', n: 3, delay: 20 }].map((r) => JSON.stringify(r)).join('\n')}\n`);
    await within((async () => { while (c.lines.length < 3) await sleep(5); })(), 3000, 'three replies');
    assert.deepEqual(c.lines.map((l) => l.n), [1, 2, 3]);
  } finally {
    c?.sock.destroy();
    await d.close();
  }
});

test('a stale socket file left by a dead daemon is replaced and the new daemon serves', async () => {
  const h = home(), file = socketPath(h);
  // A daemon that dies while listening leaves its socket file behind (nothing unlinks it).
  const r = spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(file)}, () => process.exit(0))`]);
  assert.equal(r.status, 0, String(r.stderr));
  assert.ok(fs.statSync(file).isSocket());
  const d = await serveStatus({ home: h, answer: () => ({ ok: true, fresh: true }) });
  try {
    assert.deepEqual(await request(h, { op: 'status' }), { ok: true, fresh: true });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { await d.close(); }
});

test('a second serveStatus on a home whose daemon answers is refused', async () => {
  const h = home();
  const d = await serveStatus({ home: h, answer: () => ({ ok: true, first: true }) });
  try {
    await assert.rejects(serveStatus({ home: h, answer: () => ({ ok: true }) }), /already runs/);
    // The first daemon is untouched and still answers.
    assert.deepEqual(await request(h, { op: 'status' }), { ok: true, first: true });
  } finally { await d.close(); }
});

test('a client sending more than 64 KiB without a newline is dropped; the next client is served', async () => {
  const h = home();
  const d = await serveStatus({ home: h, answer: () => ({ ok: true }) });
  let c;
  try {
    c = client(d.file);
    await c.connected;
    c.sock.write('x'.repeat(70 * 1024));
    await within(c.closed, 3000, 'the server to drop the client');
    assert.deepEqual(c.lines, []);
    await assert.rejects(request(h, { op: 'status', pad: 'y'.repeat(70 * 1024) }));
    assert.deepEqual(await request(h, { op: 'status' }), { ok: true });
  } finally {
    c?.sock.destroy();
    await d.close();
  }
});

test('a home whose socket path is longer than 100 characters still binds and answers', async () => {
  let h = home();
  while (socketPath(h).length <= 110) h = path.join(h, 'a-rather-long-directory-name');
  fs.mkdirSync(h, { recursive: true, mode: 0o700 });
  const cwd = process.cwd();
  const d = await serveStatus({ home: h, answer: () => ({ ok: true, deep: true }) });
  try {
    assert.equal(process.cwd(), cwd);
    assert.ok(fs.statSync(socketPath(h)).isSocket());
    assert.deepEqual(await request(h, { op: 'status' }), { ok: true, deep: true });
    assert.equal(process.cwd(), cwd);
  } finally { await d.close(); }
  assert.equal(fs.existsSync(socketPath(h)), false);
});

test('close() removes the socket file and drops a connected client', async () => {
  const h = home();
  const d = await serveStatus({ home: h, answer: () => ({ ok: true }) });
  let c;
  try {
    c = client(d.file);
    await c.connected;
    assert.ok(fs.existsSync(d.file));
    await within(d.close(), 3000, 'close() with a client connected');
    await within(c.closed, 3000, 'the client to be dropped');
    assert.equal(fs.existsSync(d.file), false);
    await assert.rejects(request(h, { op: 'status' }), { code: 'ENOENT' });
  } finally {
    c?.sock.destroy();
    await d.close();
  }
});

test('request rejects with ENOENT when there is no socket and ECONNREFUSED when nobody listens on it', async () => {
  const h = home();
  await assert.rejects(request(h, { op: 'status' }), { code: 'ENOENT' });
  const file = socketPath(h);
  const r = spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(file)}, () => process.exit(0))`]);
  assert.equal(r.status, 0, String(r.stderr));
  await assert.rejects(request(h, { op: 'status' }), { code: 'ECONNREFUSED' });
});
