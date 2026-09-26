// GET /api/delegate/preview: boots server.mjs with stub codex/agy CLIs (signed in, fixture model lists) and no Claude.
// Codex is then marked at its usage limit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'preview-test-password';
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
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/agy-stub.mjs'), path.join(bin, 'agy'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // PATH without the real claude/codex/agy: only the stubs in the temp HOME.
  const PATH = `${bin}:/usr/local/bin:/usr/bin:/bin:${path.dirname(process.execPath)}`;
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
// Wait for CLI discovery (the start model's label comes from the discovered list).
async function preview(q) {
  let r;
  for (let i = 0; i < 100; i++) {
    r = await get(`/api/delegate/preview?${q}`);
    if (r.status === 200 && r.body.start.label !== r.body.start.model) return r;
    await new Promise((res) => setTimeout(res, 200));
  }
  assert.fail(`preview never settled: ${JSON.stringify(r)}`);
}

test('GET /api/delegate/preview needs a session', async () => {
  const r = await fetch(base + '/api/delegate/preview?agent=codex');
  assert.equal(r.status, 401);
  await r.arrayBuffer();
});

test('preview: start model with its usage status; no fallback list means no candidates', { timeout: 60000 }, async () => {
  let { body } = await preview('agent=codex&model=gpt-5.5');
  assert.deepEqual([body.start.agent, body.start.model, body.start.status], ['codex', 'gpt-5.5', 'available']);
  assert.deepEqual([body.fallbacks, body.candidates], [null, []]);
  for (const k of ['suggested', 'category', 'source', 'release', 'data_status']) assert.equal(k in body, false, k);

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  const until = Math.floor(Date.now() / 1000) + 3600;
  db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)').run('blocked_until:codex', String(until));
  db.close();
  ({ body } = await get('/api/delegate/preview?agent=codex&model=gpt-5.5'));
  assert.deepEqual([body.start.status, body.start.until, body.start.note], ['limited', until, 'usage limit']);

  assert.equal((await get('/api/delegate/preview?agent=nope')).status, 400);
});

const put = async (p, body) => { const r = await fetch(base + p, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: JSON.parse(await r.text()) }; };

test('PUT /api/convos/:id/fallbacks: validated against the discovered models; the convo payload and ?convo= preview carry it', { timeout: 60000 }, async () => {
  await preview('agent=codex&model=gpt-5.5'); // models discovered
  const unauth = await fetch(base + `/api/convos/${CID}/fallbacks`, { method: 'PUT', body: '{"fallbacks":null}' });
  assert.equal(unauth.status, 401);
  await unauth.arrayBuffer();
  for (const bad of [[{ agent: 'nope', model: 'gpt-5.5' }], [{ agent: 'codex', model: 'gpt-9000' }], [{ agent: 'antigravity', model: 'gpt-5.5' }], [{ agent: 'codex' }], 'codex', undefined]) {
    const r = await put(`/api/convos/${CID}/fallbacks`, { fallbacks: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await put('/api/convos/nope/fallbacks', { fallbacks: null })).status, 404);
  assert.equal((await get('/api/convos')).body.find((c) => c.id === CID).fallbacks, null, 'none by default');

  const list = [{ agent: 'codex', model: 'gpt-6-sol' }, { agent: 'antigravity', model: 'gemini-3.1-pro-high' }, { agent: 'codex', model: 'gpt-6-sol' }];
  let r = await put(`/api/convos/${CID}/fallbacks`, { fallbacks: list });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.fallbacks, list.slice(0, 2), 'duplicates dropped, order kept');
  assert.deepEqual((await get('/api/convos')).body.find((c) => c.id === CID).fallbacks, list.slice(0, 2));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'convos.json'), 'utf8'))[0].fallbacks, list.slice(0, 2));

  // Preview for the chat: the list in the owner's order (codex is limited by the earlier test).
  ({ body: r } = await get(`/api/delegate/preview?agent=codex&model=gpt-5.5&convo=${CID}`));
  assert.deepEqual(r.fallbacks, list.slice(0, 2));
  assert.deepEqual(r.candidates.map((c) => [c.model, c.status]), [['gpt-6-sol', 'limited'], ['gemini-3.1-pro-high', 'available']]);
  assert.equal((await get('/api/delegate/preview?agent=codex&convo=nope')).status, 404);

  assert.deepEqual((await put(`/api/convos/${CID}/fallbacks`, { fallbacks: [] })).body.fallbacks, []);
  assert.deepEqual((await get(`/api/delegate/preview?agent=codex&model=gpt-5.5&convo=${CID}`)).body.candidates, []);
  assert.equal((await put(`/api/convos/${CID}/fallbacks`, { fallbacks: null })).body.fallbacks, null);
  ({ body: r } = await get(`/api/delegate/preview?agent=codex&model=gpt-5.5&convo=${CID}`));
  assert.equal(r.fallbacks, null);
  assert.deepEqual(r.candidates, []);
});

test('PUT /api/orch/projects/:id/reflect-fallbacks: validated against the discovered models; stored per project; ?project= preview carries it', { timeout: 60000 }, async () => {
  await preview('agent=codex&model=gpt-5.5'); // models discovered
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
    for (const bad of [[{ agent: 'nope', model: 'gpt-5.5' }], [{ agent: 'codex', model: 'gpt-9000' }], [{ agent: 'antigravity', model: 'gpt-5.5' }], [{ agent: 'codex' }], 'codex', undefined]) {
      const r = await put(url, { fallbacks: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal(stored(), null, 'rejected lists are not saved');
    assert.equal((await put('/api/orch/projects/99999/reflect-fallbacks', { fallbacks: null })).status, 404);

    const list = [{ agent: 'antigravity', model: 'gemini-3.1-pro-high' }, { agent: 'codex', model: 'gpt-6-sol' }, { agent: 'antigravity', model: 'gemini-3.1-pro-high' }];
    let r = await put(url, { fallbacks: list });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.project.reflect_fallbacks, list.slice(0, 2), 'duplicates dropped, order kept');
    assert.deepEqual(JSON.parse(stored()), list.slice(0, 2));

    ({ body: r } = await get(`/api/delegate/preview?project=${pid}`));
    assert.equal(r.start.agent, 'claude', "starts on the project's default route");
    assert.deepEqual(r.fallbacks, list.slice(0, 2));
    assert.deepEqual(r.candidates.map((c) => [c.model, c.status]), [['gemini-3.1-pro-high', 'available'], ['gpt-6-sol', 'limited']]);
    assert.equal((await get('/api/delegate/preview?project=99999')).status, 404);

    assert.deepEqual((await put(url, { fallbacks: [] })).body.project.reflect_fallbacks, []);
    assert.equal(stored(), '[]');
    assert.equal((await put(url, { fallbacks: null })).body.project.reflect_fallbacks, null);
    assert.equal(stored(), null);
    ({ body: r } = await get(`/api/delegate/preview?project=${pid}`));
    assert.equal(r.fallbacks, null);
    assert.deepEqual(r.candidates, []);
  } finally { db.close(); }
});

test('manual delegation lists every connected model with its status; the owner\'s choice overrides pins', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  try {
    db.prepare("DELETE FROM kv WHERE key='blocked_until:codex'").run();
    const pid = Number(db.prepare("INSERT INTO projects(path,name,status,created_at) VALUES(?,?,'active',0)").run(path.join(dataDir, 'manual'), 'manual').lastInsertRowid);
    const id = Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,agent,model,pinned_model,created_at) VALUES(?,'Fix code','code','codex','gpt-5.5','gpt-5.5',0)").run(pid).lastInsertRowid);
    const manual = (await get(`/api/orch/tasks/${id}/delegate`)).body;
    assert.equal(manual.current.model, 'gpt-5.5', 'explicit task route is retained');
    assert.ok(manual.candidates.some((c) => c.model === 'gemini-3.1-pro-high' && c.status === 'available'));
    assert.ok(manual.candidates.every((c) => !('score' in c) && !('metrics' in c)));
    const target = manual.candidates.find((c) => c.model === 'gpt-6-sol');
    const response = await fetch(base + `/api/orch/tasks/${id}/delegate`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ agent: target.agent, model: target.model }) });
    assert.equal(response.status, 200); await response.json();
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    assert.equal(task.model, 'gpt-6-sol');
    assert.equal(task.delegated_reason, 'chosen by the owner');
  } finally { db.close(); }
});
