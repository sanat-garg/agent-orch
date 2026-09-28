// AUDIT #35: prototype names ('constructor', '__proto__') are not agents, and chat modes are checked against MODES.
// Boots server.mjs with a stub `gh` (so POST /api/convos can create a project) and no agent CLIs.
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
import { isAgent } from '../agents.mjs';
import { isolatedPath } from './helpers/isolated-path.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'agent-names-password';
const CID = 'chat-1';
let child, base, dataDir, home, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-names-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-names-home-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'p', cwd: path.join(home, 'workspace/chat'), mode: 'bypassPermissions', agent: 'codex', model: 'm', createdAt: 1, updatedAt: 1, fullAccess: true }]));
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/gh-stub.mjs'), path.join(bin, 'gh'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH: isolatedPath(bin), PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const ok = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = ok.headers.get('set-cookie').split(';')[0];
  await ok.arrayBuffer();
});

after(() => {
  child?.kill('SIGKILL');
  for (const d of [dataDir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const convo = async (id) => (await (await fetch(base + '/api/convos', { headers: { cookie } })).json()).find((c) => c.id === id);

test('isAgent: own registry ids only', () => {
  assert.equal(isAgent('claude'), true);
  assert.equal(isAgent('codex'), true);
  for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', '', null, undefined, {}]) assert.equal(isAgent(bad), false, String(bad));
});

test('POST /api/convos stores only a listed mode', async () => {
  const post = async (folder, mode) => {
    const r = await fetch(base + '/api/convos', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ folder, mode }) });
    assert.equal(r.status, 200);
    return r.json();
  };
  assert.equal((await post('workspace/weird', 'weird')).mode, 'bypassPermissions');
  assert.equal((await post('workspace/obj', { x: 1 })).mode, 'bypassPermissions');
  assert.equal((await post('workspace/plan', 'plan')).mode, 'plan');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'convos.json'), 'utf8'));
  assert.equal(saved.find((c) => c.cwd.endsWith('/workspace/weird')).mode, 'bypassPermissions');
});

test("WS set_model with agent 'constructor' is refused and the chat keeps its agent", async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie } });
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const waitFor = async (pred) => {
    for (let i = 0; i < 100; i++) {
      const m = msgs.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`no matching message in ${JSON.stringify(msgs)}`);
  };
  try {
    ws.send(JSON.stringify({ t: 'open', cid: CID }));
    for (const agent of ['constructor', '__proto__']) {
      ws.send(JSON.stringify({ t: 'set_model', cid: CID, agent, model: 'x' }));
      const err = await waitFor((m) => m.t === 'error' && m.text.includes(agent));
      assert.equal(err.cid, CID);
    }
    assert.ok(!msgs.some((m) => m.t === 'model'), 'no model broadcast for an unknown agent');
    const c = await convo(CID);
    assert.equal(c.agent, 'codex');
    assert.equal(c.model, 'm');
    // A valid agent still switches.
    ws.send(JSON.stringify({ t: 'set_model', cid: CID, agent: 'claude', model: '' }));
    assert.equal((await waitFor((m) => m.t === 'model')).agent, 'claude');
    assert.equal((await convo(CID)).agent, 'claude');
  } finally { ws.close(); }
});
