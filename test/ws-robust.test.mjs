// AUDIT #33: malformed WebSocket frames from a signed-in client must not crash the server.
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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'ws-robust-password';
let child, base, dataDir, out = '';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-wsr-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
});

after(() => {
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('non-object and odd WebSocket frames leave the server running (AUDIT #33)', async () => {
  const ok = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  for (const frame of ['null', '1', '"str"', '[]', '{}', '{"t":"open","id":{}}']) ws.send(frame);
  // The server handles frames in order, so its pong comes after every message above was processed.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no pong:\n${out}`)), 5000);
    ws.once('pong', () => { clearTimeout(timer); resolve(); });
    ws.ping();
  });
  assert.equal(ws.readyState, WebSocket.OPEN);
  assert.equal(child.exitCode, null, `server exited:\n${out}`);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  const r = await fetch(base + '/api/status', { headers: { cookie } });
  assert.equal(r.status, 200);
  await r.arrayBuffer();
  ws.close();
});
