// Rigor (#778) in the DB and over HTTP: projects that predate projects.rigor migrate to 3, new projects start at 2, the
// project fields accept {rigor} (POST or PATCH) and GET /api/orch/rigor-levels lists the 5 levels.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedPath } from './helpers/isolated-path.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'rigor-password';

// A database from before rigor existed: the original projects table with two projects in it.
function oldDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'orchestrator'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec(`CREATE TABLE projects (
    id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL, convo_id TEXT,
    status TEXT NOT NULL DEFAULT 'active', priority INTEGER NOT NULL DEFAULT 50, mode TEXT NOT NULL DEFAULT 'build',
    model TEXT, perpetual INTEGER NOT NULL DEFAULT 1, autonomous INTEGER NOT NULL DEFAULT 0,
    chat_session_id TEXT, next_reflect_at REAL NOT NULL DEFAULT 0, created_at REAL NOT NULL)`);
  const ins = db.prepare("INSERT INTO projects(path,name,perpetual,created_at) VALUES(?, ?, 0, 1)");
  ins.run(path.join(dataDir, 'old-a'), 'old-a');
  ins.run(path.join(dataDir, 'old-b'), 'old-b');
  db.close();
}

test('migration: existing projects → 3; a new project → 2; projectAction sets and validates rigor; the planner sees it', { timeout: 60000 }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rigor-')), proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rigor-p-'));
  try {
    oldDb(dataDir);
    const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
      const [dataDir, proj] = process.argv.slice(1);
      const prompts = [];
      const query = ({ prompt }) => (async function* () { prompts.push(prompt); yield { type: 'result', subtype: 'success', result: 'Noted.', session_id: 's1', num_turns: 1 }; })();
      const o = createOrchestrator({ config: { pollMs: 60000 }, query, dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => true });
      const migrated = ['old-a', 'old-b'].map((n) => o.projectFor({ cwd: dataDir + '/' + n })).map((p) => [p.name, p.rigor]);
      const convo = { id: 'c1', cwd: proj };
      await o.planTurn(convo, 'Add a contact form to the website');
      const fresh = o.projectFor(convo);
      const bad = [0, 6, 2.5, 'x', null].map((rigor) => o.projectAction(fresh.id, { rigor }).error || null);
      const set = o.projectAction(fresh.id, { rigor: 5 });
      await o.planTurn(convo, 'Again');
      console.log(JSON.stringify({ migrated, fresh: fresh.rigor, bad, set, after: o.projectFor(convo).rigor, prompts }));
      process.exit(0);`;
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, dataDir, proj], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').pop());
    assert.deepEqual(out.migrated.sort(), [['old-a', 3], ['old-b', 3]]);
    assert.equal(out.fresh, 2);
    assert.ok(out.bad.every(Boolean), JSON.stringify(out.bad));
    assert.deepEqual(out.set, { ok: true });
    assert.equal(out.after, 5);
    assert.match(out.prompts[0], /Rigor: 2 · Ship it/);
    assert.match(out.prompts[1], /Rigor: 5 · Hardened/);
    // Migrating again leaves a project's chosen level alone.
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    db.prepare("UPDATE projects SET rigor=1 WHERE name='old-a'").run();
    db.close();
    const again = execFileSync(process.execPath, ['--input-type=module', '-e', `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
      const o = createOrchestrator({ config: { pollMs: 60000 }, query: () => (async function* () {})(), dataDir: process.argv[1], claudeEnv: {}, getLimits: () => [], onSubscription: () => true, broadcast() {}, emitChat() {}, convoExists: () => true });
      console.log(JSON.stringify(['old-a', 'old-b'].map((n) => o.projectFor({ cwd: process.argv[1] + '/' + n }).rigor))); process.exit(0);`, dataDir], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(again.trim().split('\n').pop()), [1, 3]);
  } finally {
    for (const d of [dataDir, proj]) fs.rmSync(d, { recursive: true, force: true });
  }
});

let child, base, dataDir, home, cookie;
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rigor-srv-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rigor-home-'));
  oldDb(dataDir);
  fs.mkdirSync(path.join(home, 'bin'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH: isolatedPath(path.join(home, 'bin')), PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: JSON.parse(await r.text()) };
};

test('GET /api/orch/rigor-levels: 5 levels, examples for the same request; needs sign-in', { timeout: 30000 }, async () => {
  const anon = await fetch(base + '/api/orch/rigor-levels');
  assert.equal(anon.status, 401);
  await anon.arrayBuffer();
  const { status, body } = await call('GET', '/api/orch/rigor-levels');
  assert.equal(status, 200);
  assert.deepEqual(body.map((l) => [l.level, l.name]), [[1, 'Sketch'], [2, 'Ship it'], [3, 'Solid'], [4, 'Robust'], [5, 'Hardened']]);
  for (const l of body) {
    assert.ok(l.summary && l.use);
    assert.deepEqual(l.dials.map((d) => d.key), ['tests', 'errors', 'security', 'care', 'focus']);
    assert.match(l.example.title, /contact form/i);
    assert.ok(l.example.prompt && l.example.done_when);
  }
});

test('PATCH (and POST) /api/orch/project/:id accepts {rigor}; migrated projects start at 3', { timeout: 30000 }, async () => {
  // Read back from the server's DB: the owner's UI gets projects over the websocket.
  const find = () => {
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'), { readOnly: true });
    try { return db.prepare("SELECT id, rigor FROM projects WHERE name='old-a'").get(); } finally { db.close(); }
  };
  const p = find();
  assert.equal(p.rigor, 3);
  assert.deepEqual(await call('PATCH', `/api/orch/project/${p.id}`, { rigor: 1 }), { status: 200, body: { ok: true } });
  assert.equal(find().rigor, 1);
  assert.equal((await call('PATCH', `/api/orch/project/${p.id}`, { rigor: 9 })).status, 400);
  assert.equal((await call('POST', `/api/orch/project/${p.id}`, { rigor: 4 })).status, 200);
  assert.equal(find().rigor, 4);
});
