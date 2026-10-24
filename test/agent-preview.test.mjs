// Agents publish their own project (bin/preview.mjs → POST /api/agent/preview, server.mjs agentPreview): run inside a
// project (or a folder under it) it prints https://<folder>.<domain> and keeps that address on a second run; a clash gets
// -2; a folder outside every project, a wrong key or a request through Caddy (X-Forwarded-For) is refused; with no head
// on the machine the script says so. Boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir, sandboxed Caddy).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'bin', 'preview.mjs');
let child, base, dataDir, ws;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const run = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CW_DATA_DIR: dataDir } });

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-agentpv-'));
  ws = path.join(dataDir, 'ws');
  const site = (rel) => { const d = path.join(ws, rel); fs.mkdirSync(path.join(d, 'src'), { recursive: true }); fs.writeFileSync(path.join(d, 'index.html'), '<h1>hi</h1>'); return d; };
  const a = site('one/pv-shop'), b = site('two/pv-shop');
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([
    { id: '11111111-1111-4111-8111-111111111111', title: 'shop', cwd: a, model: '', createdAt: Date.now(), updatedAt: Date.now() },
    { id: '22222222-2222-4222-8222-222222222222', title: 'shop 2', cwd: b, model: '', createdAt: Date.now(), updatedAt: Date.now() }]));
  const port = await freePort();
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
});

after(() => {
  child?.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the key file is private to the owner', () => {
  assert.equal(fs.statSync(path.join(dataDir, 'agent-api.json')).mode & 0o777, 0o600);
});

test('an agent publishes its project and gets the link; a second run keeps it; a clash gets -2', () => {
  const r = run(path.join(ws, 'one/pv-shop/src'));
  assert.equal(r.status, 0, r.stderr);
  const [link, info] = r.stdout.trim().split('\n');
  assert.match(link, /^https:\/\/pv-shop\.[a-z0-9.-]+$/);
  assert.match(info, /^Published\. Status: /);
  const again = run(path.join(ws, 'one/pv-shop'));
  assert.equal(again.stdout.split('\n')[0], link);
  assert.match(again.stdout, /Already published/);
  const other = run(path.join(ws, 'two/pv-shop'));
  assert.equal(other.status, 0, other.stderr);
  assert.equal(other.stdout.split('\n')[0], link.replace('pv-shop.', 'pv-shop-2.'));
  assert.equal(run(path.join(ws, 'one/pv-shop'), '--logs').status, 0);
});

test('outside a project, with a wrong key or through Caddy, nothing is published', async () => {
  const r = run(ws);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /isn't in an agent-orch project folder/);
  const { key } = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-api.json'), 'utf8'));
  const post = (headers) => fetch(`${base}/api/agent/preview`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ dir: path.join(ws, 'one/pv-shop') }) });
  assert.equal((await post({ 'x-agent-orch-key': 'nope' })).status, 401);
  assert.equal((await post({ 'x-agent-orch-key': key, 'x-forwarded-for': '1.2.3.4' })).status, 401);
  assert.equal((await post({ 'x-agent-orch-key': key })).status, 200);
});

test('with no head on the machine the script says so', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--data', path.join(dataDir, 'nowhere')], { cwd: ws, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /isn't running the agent-orch head/);
});
