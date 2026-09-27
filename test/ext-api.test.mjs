// /api/ext* and /api/convos/:id/persona on a real server.mjs (temporary HOME, data dir and port; no orchestrator):
// sign-in required, skills land in HOME's CLI folders, MCP secrets never leave the server, a deleted persona is cleared
// from the chats that used it, every change is broadcast as {t:'ext'}, and the sheet's assets are served.
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
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'ext-api-password';
let child, base, root, home, dataDir, cookie;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-extapi-'));
  home = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(root, 'proj'));
  fs.mkdirSync(dataDir);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: 'c0', title: 'Demo', cwd: path.join(root, 'proj'), mode: 'default', model: '', createdAt: 1, updatedAt: 1 }]));
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
});
after(() => {
  child?.kill('SIGKILL');
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { cookie, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test('needs a sign-in', async () => {
  const r = await fetch(`${base}/api/ext`);
  assert.equal(r.status, 401);
  await r.arrayBuffer();
});

test('the sheet script and styles are served', async () => {
  for (const f of ['/ext.js', '/ext.css']) {
    const r = await fetch(base + f, { headers: { cookie } });
    assert.equal(r.status, 200, f);
    await r.arrayBuffer();
  }
});

test('skills, subagents and MCP servers: saved, listed, masked and removed; changes are broadcast', async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie } });
  const seen = [];
  ws.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'ext') seen.push(m.kind); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  try {
    let r = await call('POST', '/api/ext/skills', { name: 'notes', description: 'Use when writing notes', body: '# Notes', agents: ['claude', 'codex'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.item.folder, r.body.item.agents], ['notes', ['claude', 'codex']]);
    assert.ok(fs.existsSync(path.join(home, '.claude/skills/notes/SKILL.md')));
    assert.ok(fs.existsSync(path.join(home, '.codex/skills/notes/SKILL.md')));
    r = await call('POST', '/api/ext/skills', { name: 'Bad Name', description: 'd', body: 'b' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /lowercase/);

    r = await call('POST', '/api/ext/agents', { name: 'reviewer', description: 'Reviews diffs', prompt: 'You review.' });
    assert.equal(r.status, 200);
    assert.ok(fs.existsSync(path.join(home, '.claude/agents/reviewer.md')));

    r = await call('POST', '/api/ext/mcp', { name: 'pw', type: 'stdio', commandLine: 'npx -y @playwright/mcp@latest', env: 'TOKEN=very-secret' });
    assert.equal(r.status, 200);
    assert.doesNotMatch(JSON.stringify(r.body), /very-secret/);
    r = await call('PATCH', '/api/ext/mcp/pw', { enabled: false });
    assert.equal(r.body.item.enabled, false);
    const list = await call('GET', '/api/ext');
    assert.doesNotMatch(JSON.stringify(list.body), /very-secret/);
    assert.deepEqual(Object.keys(list.body).sort(), ['agents', 'mcp', 'paths', 'personas', 'skills']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'extensions/mcp.json'), 'utf8')).servers[0].env.TOKEN, 'very-secret');

    for (const [kind, name] of [['skills', 'notes'], ['agents', 'reviewer'], ['mcp', 'pw']]) {
      r = await call('DELETE', `/api/ext/${kind}/${name}`);
      assert.equal(r.status, 200, kind);
      assert.deepEqual(r.body[kind], [], kind);
    }
    assert.equal((await call('DELETE', '/api/ext/skills/notes')).status, 400);
    assert.equal((await call('PUT', '/api/ext/skills')).status, 405);
    await waitFor(() => seen.length >= 7, { message: `ext broadcasts: ${seen}` });
    assert.deepEqual(seen, ['skills', 'agents', 'mcp', 'mcp', 'skills', 'agents', 'mcp']); // refused writes broadcast nothing
  } finally { ws.close(); }
});

test("a chat's persona: set, refused when unknown, cleared when the persona is deleted", async () => {
  let r = await call('POST', '/api/ext/personas', { name: 'Staff engineer', description: 'Pragmatic', prompt: 'Be terse.' });
  assert.equal(r.status, 200);
  const id = r.body.item.id;
  assert.deepEqual((await call('GET', '/api/ext/personas')).body.personas.map((p) => p.name), ['Staff engineer']);
  r = await call('PUT', '/api/convos/c0/persona', { persona: id });
  assert.equal(r.status, 200);
  assert.equal(r.body.persona, id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'convos.json'), 'utf8'))[0].persona, id);
  assert.equal((await call('PUT', '/api/convos/c0/persona', { persona: 'nope' })).status, 400);
  assert.equal((await call('PUT', '/api/convos/missing/persona', { persona: null })).status, 404);
  r = await call('DELETE', `/api/ext/personas/${id}`);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'convos.json'), 'utf8'))[0].persona, null);
});
