// Fallback lists over HTTP (save/load for a chat and for a project's reflection tasks) and manual delegation: boots
// server.mjs with a stub codex CLI (signed in, fixture model list) and no Claude.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedPath } from './helpers/isolated-path.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'fallbacks-api-password';
const CID = 'chat-1';
let child, base, dataDir, home, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-prev-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-prev-home-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'p', cwd: path.join(dataDir, 'no-such-project'), mode: 'orchestrator', model: '', createdAt: 1, updatedAt: 1, fullAccess: true }]));
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/codex-stub.mjs'), path.join(bin, 'codex'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // PATH without the real claude/codex: only the stub in the temp HOME.
  const PATH = isolatedPath(bin);
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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

const get = async (p) => { const r = await fetch(base + p, { headers: { cookie } }); return { status: r.status, body: JSON.parse(await r.text()) }; };
// Wait for CLI discovery: PUT validates against the discovered models.
async function discovered() {
  for (let i = 0; i < 100; i++) {
    const { body } = await get('/api/agents');
    if (body.agents?.find((a) => a.id === 'codex')?.models.length) return;
    await new Promise((res) => setTimeout(res, 200));
  }
  assert.fail('model discovery never finished');
}

test('GET /api/delegate/preview is gone', async () => {
  assert.equal((await fetch(base + '/api/delegate/preview?agent=codex', { headers: { cookie } })).status, 404);
});

const put = async (p, body) => { const r = await fetch(base + p, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: JSON.parse(await r.text()) }; };

test('PUT /api/convos/:id/fallbacks: validated against the discovered models; saved and loaded with the chat', { timeout: 60000 }, async () => {
  await discovered();
  const unauth = await fetch(base + `/api/convos/${CID}/fallbacks`, { method: 'PUT', body: '{"fallbacks":null}' });
  assert.equal(unauth.status, 401);
  await unauth.arrayBuffer();
  for (const bad of [[{ agent: 'nope', model: 'gpt-5.5' }], [{ agent: 'codex', model: 'gpt-9000' }], [{ agent: 'claude', model: 'gpt-5.5' }], [{ agent: 'codex' }], 'codex', undefined]) {
    const r = await put(`/api/convos/${CID}/fallbacks`, { fallbacks: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await put('/api/convos/nope/fallbacks', { fallbacks: null })).status, 404);
  assert.equal((await get('/api/convos')).body.find((c) => c.id === CID).fallbacks, null, 'none by default');

  const list = [{ agent: 'codex', model: 'gpt-6-sol' }, { agent: 'codex', model: 'gpt-6-astra' }, { agent: 'codex', model: 'gpt-6-sol' }];
  const r = await put(`/api/convos/${CID}/fallbacks`, { fallbacks: list });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.fallbacks, list.slice(0, 2), 'duplicates dropped, order kept');
  assert.deepEqual((await get('/api/convos')).body.find((c) => c.id === CID).fallbacks, list.slice(0, 2));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'convos.json'), 'utf8'))[0].fallbacks, list.slice(0, 2));

  assert.deepEqual((await put(`/api/convos/${CID}/fallbacks`, { fallbacks: [] })).body.fallbacks, []);
  assert.deepEqual((await get('/api/convos')).body.find((c) => c.id === CID).fallbacks, []);
  assert.equal((await put(`/api/convos/${CID}/fallbacks`, { fallbacks: null })).body.fallbacks, null);
});

test('PUT /api/orch/projects/:id/reflect-fallbacks: validated against the discovered models; stored per project', { timeout: 60000 }, async () => {
  await discovered();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,created_at) VALUES(?,?,'active',0)").run(path.join(dataDir, 'rf-project'), 'rf').lastInsertRowid);
  const stored = () => db.prepare('SELECT reflect_fallbacks FROM projects WHERE id=?').get(pid).reflect_fallbacks;
  const url = `/api/orch/projects/${pid}/reflect-fallbacks`;
  try {
    const unauth = await fetch(base + url, { method: 'PUT', body: '{"fallbacks":null}' });
    assert.equal(unauth.status, 401);
    await unauth.arrayBuffer();
    assert.equal(stored(), null, 'none by default');
    for (const bad of [[{ agent: 'nope', model: 'gpt-5.5' }], [{ agent: 'codex', model: 'gpt-9000' }], [{ agent: 'claude', model: 'gpt-5.5' }], [{ agent: 'codex' }], 'codex', undefined]) {
      const r = await put(url, { fallbacks: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal(stored(), null, 'rejected lists are not saved');
    assert.equal((await put('/api/orch/projects/99999/reflect-fallbacks', { fallbacks: null })).status, 404);

    const list = [{ agent: 'codex', model: 'gpt-6-astra' }, { agent: 'codex', model: 'gpt-6-sol' }, { agent: 'codex', model: 'gpt-6-astra' }];
    const r = await put(url, { fallbacks: list });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.project.reflect_fallbacks, list.slice(0, 2), 'duplicates dropped, order kept');
    assert.deepEqual(JSON.parse(stored()), list.slice(0, 2));

    assert.deepEqual((await put(url, { fallbacks: [] })).body.project.reflect_fallbacks, []);
    assert.equal(stored(), '[]');
    assert.equal((await put(url, { fallbacks: null })).body.project.reflect_fallbacks, null);
    assert.equal(stored(), null);
  } finally { db.close(); }
});

test('manual delegation lists every connected model with its status; the owner\'s choice goes through', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  try {
    const pid = Number(db.prepare("INSERT INTO projects(path,name,status,created_at) VALUES(?,?,'active',0)").run(path.join(dataDir, 'manual'), 'manual').lastInsertRowid);
    const id = Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,agent,model,created_at) VALUES(?,'Fix code','code','codex','gpt-5.5',0)").run(pid).lastInsertRowid);
    const manual = (await get(`/api/orch/tasks/${id}/delegate`)).body;
    assert.equal(manual.current.model, 'gpt-5.5', 'explicit task route is retained');
    assert.ok(manual.candidates.some((c) => c.model === 'gpt-6-astra' && c.status === 'available'));
    assert.ok(manual.candidates.every((c) => !('score' in c) && !('metrics' in c)));
    const target = manual.candidates.find((c) => c.model === 'gpt-6-sol');
    const response = await fetch(base + `/api/orch/tasks/${id}/delegate`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ agent: target.agent, model: target.model }) });
    assert.equal(response.status, 200); await response.json();
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    assert.equal(task.model, 'gpt-6-sol');
    assert.equal(task.delegated_reason, 'chosen by the owner');
  } finally { db.close(); }
});

test('PATCH task fallbacks validates models, isolates the snapshot and rejects finished tasks', async () => {
  await discovered();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  const patch = async (id, fallbacks) => {
    const r = await fetch(base + `/api/orch/tasks/${id}/fallbacks`, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ fallbacks }) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const pid = Number(db.prepare("INSERT INTO projects(path,name,status,created_at) VALUES(?,'task-fb','paused',0)").run(path.join(dataDir, 'task-fb')).lastInsertRowid);
    const add = (status, kind = 'work') => Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,status,kind,created_at) VALUES(?,'Edit','code',?,?,0)").run(pid, status, kind).lastInsertRowid);
    const id = add('queued'), sibling = add('queued');
    const chatBefore = (await get('/api/convos')).body;
    const unauth = await fetch(base + `/api/orch/tasks/${id}/fallbacks`, { method: 'PATCH', body: '{"fallbacks":[]}' });
    assert.equal(unauth.status, 401); await unauth.arrayBuffer();
    for (const bad of [undefined, {}, [{ agent: 'codex', model: 'invented' }], [{ agent: 'nope', model: 'gpt-6-sol' }], [{ agent: 'codex' }], Array(21).fill({ agent: 'codex', model: 'gpt-6-sol' })]) {
      assert.equal((await patch(id, bad)).status, 400);
    }
    assert.equal((await patch(999999, [])).status, 404);
    const list = [{ agent: 'codex', model: 'gpt-6-sol' }, { agent: 'codex', model: 'gpt-6-astra' }];
    const r = await patch(id, [...list, list[0]]);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.task.fallbacks, list);
    assert.deepEqual((await get(`/api/orch/task/${id}`)).body.task.fallbacks, list);
    assert.equal(db.prepare('SELECT fallbacks FROM tasks WHERE id=?').get(sibling).fallbacks, null);
    assert.deepEqual((await get('/api/convos')).body, chatBefore);
    assert.deepEqual((await patch(id, [])).body.task.fallbacks, []);
    assert.equal((await patch(id, null)).body.task.fallbacks, null);
    const running = add('running');
    assert.equal((await patch(running, list)).body.task.status, 'running');
    for (const status of ['done', 'cancelled', 'failed', 'needs_integration']) assert.equal((await patch(add(status), list)).status, 409);
    assert.equal((await patch(add('queued', 'plan'), list)).status, 409);
  } finally { db.close(); }
});

test('parallel settings validate, persist, and appear in state', async () => {
  const url = '/api/orch/parallel';
  const unauth = await fetch(base + url, { method: 'PUT', body: '{}' });
  assert.equal(unauth.status, 401); await unauth.arrayBuffer();
  for (const value of [null, {}, { parallelTasks: 3 }, { parallelTasks: 0 }, { parallelTasks: '2' }, { maxParallel: 2 }]) {
    assert.equal((await put(url, value)).status, 400);
  }
  const before = await put(url, { parallelTasks: 1 });
  assert.equal(before.body.state.parallel.parallelTasks, 1);
  assert.ok(before.body.state.slots <= 1, 'one slot by default');
  const r = await put(url, { parallelTasks: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.body.state.parallel.parallelTasks, 2);
  assert.ok(r.body.state.parallel.memAvailable > 0);
  assert.deepEqual(r.body.state.lanes, []);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM kv WHERE key='parallel_settings'").get().value), { parallelTasks: 2 });
  db.close();
  assert.equal((await put(url, { parallelTasks: 1 })).body.state.parallel.parallelTasks, 1);
});

test('POST /api/orch/projects/reorder: sets positions, derives priority 90 → 10 and broadcasts the order', { timeout: 30000 }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { default: WebSocket } = await import('ws');
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  const add = (name) => Number(db.prepare("INSERT INTO projects(path,name,status,created_at) VALUES(?,?,'paused',0)").run(path.join(dataDir, name), name).lastInsertRowid);
  const [a, b, c] = ['order-a', 'order-b', 'order-c'].map(add);
  const post = async (body, headers = { cookie }) => {
    const r = await fetch(base + '/api/orch/projects/reorder', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: JSON.parse(await r.text()) };
  };
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie } });
  try {
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    assert.equal((await post({ ids: [a] }, {})).status, 401);
    for (const bad of [{}, { ids: [] }, { ids: 'x' }, { ids: [a, a] }, { ids: [a, '2'] }]) assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await post({ ids: [a, 999999] })).status, 404);

    const broadcast = new Promise((res) => ws.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'oprojects') res(m); }));
    const r = await post({ ids: [c, a, b] });
    assert.equal(r.status, 200);
    const rows = db.prepare('SELECT id, position, priority FROM projects WHERE id IN (?,?,?) ORDER BY position').all(a, b, c).map((p) => ({ ...p }));
    assert.deepEqual(rows.map((p) => p.id), [c, a, b]);
    assert.deepEqual(rows.map((p) => p.position), [1, 2, 3], 'the listed projects are the top three');
    const pri = rows.map((p) => p.priority);
    assert.equal(pri[0], 90, 'the top project gets the highest priority');
    assert.ok(pri[0] > pri[1] && pri[1] > pri[2], `priorities fall down the list: ${pri}`);
    const msg = await broadcast;
    assert.deepEqual(msg.order.slice(0, 3).map((p) => [p.id, p.position, p.priority]), rows.map((p) => [p.id, p.position, p.priority]));
    assert.deepEqual(r.body.order, msg.order);
  } finally { ws.close(); db.close(); }
});
