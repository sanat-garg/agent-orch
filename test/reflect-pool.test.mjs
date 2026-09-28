// Reflection models (#508, projects.reflect_pool): each reflection runs on a random usable model from the project's pool,
// a model-side failure retries on another pool model it hasn't tried, an exhausted pool waits for the earliest reset,
// owner fallbacks never move a reflect task, and the retired reflect_agent/_fallbacks migrate into the pool once.
// Orchestrator runs happen in a child process (it starts timers) with a fake Claude `query` and a seeded RNG.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickReflectModel, migrateReflectPool } from '../orchestrator.mjs';

// mulberry32: a small seeded RNG.
const seeded = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const SEEDED = seeded.toString();
const pool = [{ agent: 'claude', model: 'opus' }, { agent: 'codex', model: 'gpt-a' }, { agent: 'codex', model: 'gpt-b' }];

test('pickReflectModel: uniform over the pool with a seeded RNG, deterministic per seed', () => {
  const rng = seeded(42), counts = {};
  for (let i = 0; i < 3000; i++) { const { pick } = pickReflectModel(pool, { random: rng }); counts[pick.model] = (counts[pick.model] || 0) + 1; }
  assert.deepEqual(Object.keys(counts).sort(), ['gpt-a', 'gpt-b', 'opus']);
  for (const n of Object.values(counts)) assert.ok(n > 900 && n < 1100, JSON.stringify(counts));
  const seq = (s) => { const r = seeded(s); return Array.from({ length: 10 }, () => pickReflectModel(pool, { random: r }).pick.model); };
  assert.deepEqual(seq(7), seq(7));
  assert.equal(pickReflectModel(pool, { random: () => 0.999999 }).pick.model, 'gpt-b');
  assert.equal(pickReflectModel(pool, { random: () => 0 }).pick.model, 'opus');
});

test('pickReflectModel: a limited model and the ones tried this round are excluded; none left → no pick', () => {
  const rng = seeded(1), limited = (agent) => agent !== 'codex';
  for (let i = 0; i < 50; i++) assert.equal(pickReflectModel(pool, { usable: limited, random: rng }).pick.model, 'opus');
  const tried = [{ agent: 'claude', model: 'opus', outcome: 'error' }];
  for (let i = 0; i < 50; i++) assert.notEqual(pickReflectModel(pool, { tried, random: rng }).pick.model, 'opus');
  assert.deepEqual(pickReflectModel(pool, { tried, usable: limited }), { pick: null, left: 2, usable: 0 });
  assert.deepEqual(pickReflectModel(pool, { tried: pool }), { pick: null, left: 0, usable: 0 });
});

test('migrateReflectPool: the retired reflection model, then its fallbacks, without repeats', () => {
  assert.deepEqual(migrateReflectPool({ reflect_agent: 'codex', reflect_model: 'gpt-a', reflect_fallbacks: '[{"agent":"claude","model":"opus"},{"agent":"codex","model":"gpt-a"}]' }),
    [{ agent: 'codex', model: 'gpt-a' }, { agent: 'claude', model: 'opus' }]);
  assert.deepEqual(migrateReflectPool({ reflect_agent: 'claude', reflect_model: null, model: 'sonnet', reflect_fallbacks: null }), [{ agent: 'claude', model: 'sonnet' }]);
  assert.deepEqual(migrateReflectPool({ reflect_fallbacks: '[{"agent":"codex","model":"gpt-b"}]' }), [{ agent: 'codex', model: 'gpt-b' }]);
  assert.equal(migrateReflectPool({ reflect_agent: null, reflect_fallbacks: '[]' }), null, "nothing set: the chat's model");
});

// Boots an orchestrator on a fresh data dir with one perpetual project whose pool is `pool`, runs `body` and prints its result.
async function run({ pool: p, query, setup = '', body, env = {}, catalogs }) {
  const dirs = ['cw-rp-', 'cw-rp-p-'].map((x) => fs.mkdtempSync(path.join(os.tmpdir(), x)));
  const [dataDir, root] = dirs;
  const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
  const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
    import { setModelCatalog } from ${url('agents.mjs')};
    import { DatabaseSync } from 'node:sqlite';
    import fs from 'node:fs';
    import path from 'node:path';
    const [dataDir, root] = process.argv.slice(1);
    const catalogs = ${JSON.stringify(catalogs || { claude: [{ id: 'opus', default: true }, { id: 'sonnet' }, { id: 'haiku' }] })};
    for (const [a, models] of Object.entries(catalogs)) setModelCatalog(a, { models, error: null, at: 1 });
    const seeded = ${SEEDED};
    const models = [];
    const fake = ${query};
    const query = ({ options }) => { models.push(options.model || null); return fake(options.model, models.length); };
    const o = createOrchestrator({ config: { pollMs: 100, random: seeded(5) }, query, dataDir, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [],
      onSubscription: () => true, broadcast() {}, emitChat() {}, convoExists: () => true, convoFallbacks: (c) => (c === 'chat-1' ? [{ agent: 'claude', model: 'haiku' }] : null) });
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    const dir = path.join(root, 'proj'); fs.mkdirSync(dir);
    const pid = Number(db.prepare("INSERT INTO projects(path,name,status,perpetual,next_reflect_at,convo_id,created_at) VALUES(?,'proj','paused',1,?,'chat-1',0)").run(dir, Date.now() / 1000 + 99999).lastInsertRowid);
    const saved = o.setReflectSettings(pid, { pool: ${JSON.stringify(p)} });
    ${setup}
    const tid = Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,source,origin,created_at) VALUES(?,'reflect','Reflect','(reflection)','reflection','reflection',0)").run(pid).lastInsertRowid);
    db.exec("UPDATE projects SET status='active'");
    const task = () => ({ ...db.prepare('SELECT * FROM tasks WHERE id=?').get(tid) });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (f) => { for (let i = 0; i < 300 && !f(); i++) await sleep(100); };
    console.log(JSON.stringify(await (async () => { ${body} })()));
    process.exit(0);`;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, root], { encoding: 'utf8', timeout: 50000, env: { ...process.env, ...env } });
    return JSON.parse(stdout.trim().split('\n').pop());
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
}
const OK = `'\\n\`\`\`agent-orch-tasks\\n' + JSON.stringify([{ title: 'Improve it', prompt: 'do it' }]) + '\\n\`\`\`'`;

test('a failed reflection retries on a different pool model, never repeating one; the pick is recorded; its work keeps the chat\'s fallbacks', { timeout: 60000 }, async () => {
  const r = await run({
    pool: [{ agent: 'claude', model: 'opus' }, { agent: 'claude', model: 'sonnet' }, { agent: 'claude', model: 'haiku' }],
    // Runs 1 and 2 fail (the model unavailable, then a crash with no verdict); run 3 answers.
    query: `(model, n) => (async function* () {
      if (n === 1) { yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'model unavailable', session_id: 's', num_turns: 0 }; return; }
      if (n === 2) throw new Error('agent crashed');
      yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok' + ${OK}, session_id: 's', num_turns: 1 };
    })()`,
    body: `await until(() => task().status === 'done');
      const work = db.prepare("SELECT fallbacks, source FROM tasks WHERE kind='work'").all().map((x) => ({ ...x }));
      const events = db.prepare("SELECT message FROM events WHERE task_id=? AND message LIKE 'Reflection on %'").all(tid).map((e) => e.message);
      return { saved: saved.reflect, t: task(), models: models.slice(0, 3), work, events };`,
  });
  assert.deepEqual(r.saved, { pool: [{ agent: 'claude', model: 'opus' }, { agent: 'claude', model: 'sonnet' }, { agent: 'claude', model: 'haiku' }], custom: true });
  assert.equal(r.t.status, 'done', JSON.stringify(r));
  assert.equal(r.models.length, 3);
  assert.equal(new Set(r.models).size, 3, `every retry used a different model: ${r.models}`);
  assert.equal(r.t.attempts, 0, 'a retry on another model costs no attempt');
  assert.equal(r.t.route_note, `Reflection on ${r.models[2]} (random from 3)`);
  assert.equal(r.events.length, 3);
  assert.equal(r.events[0], `Reflection on ${r.models[0]} (random from 3)`);
  const pick = JSON.parse(r.t.reflect_pick);
  assert.deepEqual(pick.tried.map((x) => x.model), r.models.slice(0, 2));
  assert.deepEqual(pick.tried.map((x) => x.outcome), ['error', 'error'], 'a crash inside the agent run is its error outcome');
  assert.deepEqual(r.work.map((w) => [w.source, JSON.parse(w.fallbacks)]), [['reflection', [{ agent: 'claude', model: 'haiku' }]]], "its work snapshots the chat's fallbacks");
});

test('an exhausted pool waits: for the earliest reset after limits (no attempt), else a while (one attempt)', { timeout: 60000 }, async () => {
  const fails = await run({
    pool: [{ agent: 'claude', model: 'opus' }, { agent: 'claude', model: 'sonnet' }],
    query: `() => (async function* () { yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'overloaded', session_id: 's', num_turns: 0 }; })()`,
    body: `await until(() => task().status === 'queued' && task().not_before > Date.now() / 1000 + 60);
      await sleep(500);
      return { t: task(), models, at: Date.now() / 1000 };`,
  });
  assert.equal(fails.t.status, 'queued');
  assert.deepEqual([...fails.models].sort(), ['opus', 'sonnet'], 'each pool model once, then it waits');
  assert.equal(fails.t.attempts, 1);
  assert.ok(Math.abs(fails.t.not_before - fails.at - 600) < 30, 'no known reset: it waits reflectWaitSec');
  assert.match(fails.t.last_error, /^\[error\] Tried all 2 reflection models \((opus|sonnet): error, (opus|sonnet): error\); waiting for the earliest reset$/);
  const pick = JSON.parse(fails.t.reflect_pick);
  assert.deepEqual(pick.tried, [], 'the next round starts over');
  assert.match(pick.waiting, /^Tried all 2 reflection models/);
  assert.equal(pick.until, fails.t.not_before);

  const limited = await run({
    pool: [{ agent: 'claude', model: 'opus' }],
    query: `() => (async function* () { yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your limit", api_error_status: 429, session_id: 's', num_turns: 0 }; })()`,
    body: `await until(() => task().status === 'queued' && task().reflect_pick && JSON.parse(task().reflect_pick).waiting);
      await sleep(500);
      const blocked = Number(db.prepare("SELECT value FROM kv WHERE key='blocked_until'").get()?.value || 0);
      return { t: task(), models, blocked };`,
  });
  assert.deepEqual(limited.models, ['opus'], 'a limited model is not retried while limited');
  assert.equal(limited.t.attempts, 0, 'limits cost no attempt');
  assert.ok(limited.blocked > 0);
  assert.equal(limited.t.not_before, limited.blocked, 'it waits for the earliest reset');
  assert.match(limited.t.last_error, /^\[rate_limited\] Tried all 1 reflection model \(opus: rate_limited\); waiting for the earliest reset$/);
});

// A signed-in stand-in codex CLI (codex-stub.mjs) makes codex a usable pool agent.
const fixture = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));
test('a limited model is excluded from the pick and owner fallbacks never move a reflect task', { timeout: 60000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rp-home-'));
  try {
    fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
    fs.symlinkSync(fixture('codex-stub.mjs'), path.join(home, '.local/bin/codex'));
    const r = await run({
      env: { HOME: home, PATH: `${path.join(home, '.local/bin')}:${process.env.PATH}` },
      catalogs: { claude: [{ id: 'opus', default: true }, { id: 'sonnet' }], codex: [{ id: 'gpt-a' }, { id: 'gpt-mini' }] },
      pool: [{ agent: 'claude', model: 'opus' }, { agent: 'claude', model: 'sonnet' }, { agent: 'codex', model: 'gpt-a' }],
      query: `() => (async function* () { yield { type: 'result', subtype: 'success', result: 'ok', session_id: 's', num_turns: 1 }; })()`,
      // Claude is at its limit; the retired fallbacks (and a snapshot on the task) name gpt-mini: neither applies.
      setup: `db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES('blocked_until',?)").run(String(Date.now() / 1000 + 3600));
        o.setReflectFallbacks(pid, [{ agent: 'codex', model: 'gpt-mini' }]);`,
      body: `db.prepare("UPDATE tasks SET fallbacks=? WHERE id=?").run('[{"agent":"codex","model":"gpt-mini"}]', tid);
        await until(() => ['done', 'failed'].includes(task().status));
        return { t: task(), claude: models.length };`,
    });
    assert.equal(r.t.status, 'done', JSON.stringify(r.t));
    assert.equal(r.claude, 0, 'the limited Claude models were never picked');
    assert.deepEqual([r.t.agent, r.t.model, r.t.ran_agent, r.t.ran_model], ['codex', 'gpt-a', 'codex', 'gpt-a']);
    assert.equal(r.t.delegated_from, null, 'no fallback move');
    assert.equal(r.t.route_note, 'Reflection on gpt-a (random from 3)');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('migration: an install from before #508 gets its reflection model + fallbacks as the pool, once', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rpm-'));
  try {
    const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
    const boot = async (body) => {
      const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
        const [dataDir] = process.argv.slice(1);
        const o = createOrchestrator({ query: () => (async function* () {})(), dataDir, disabled: true, claudeEnv: {}, getLimits: () => [], onSubscription: () => false,
          broadcast() {}, emitChat() {}, convoExists: () => false });
        console.log(JSON.stringify(await (async () => { ${body} })()));
        process.exit(0);`;
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir], { encoding: 'utf8', timeout: 30000 });
      return JSON.parse(stdout.trim().split('\n').pop());
    };
    await boot('return null;');
    const { DatabaseSync } = await import('node:sqlite');
    let db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    db.exec('ALTER TABLE projects DROP COLUMN reflect_pool'); // as before #508
    const add = db.prepare("INSERT INTO projects(path,name,status,model,reflect_agent,reflect_model,reflect_fallbacks,created_at) VALUES(?,?,'paused',?,?,?,?,0)");
    add.run('/x/a', 'a', null, 'codex', 'gpt-a', '[{"agent":"claude","model":"opus"}]');
    add.run('/x/b', 'b', 'sonnet', null, null, null);
    db.close();
    const after = await boot(`return { a: o.convoSnapshot({ cwd: '/x/a' }).project.reflect, b: o.convoSnapshot({ cwd: '/x/b' }).project.reflect };`);
    assert.deepEqual(after.a, { pool: [{ agent: 'codex', model: 'gpt-a' }, { agent: 'claude', model: 'opus' }], custom: true });
    assert.deepEqual(after.b, { pool: [{ agent: 'claude', model: 'sonnet' }], custom: false }, "nothing set: the chat's model");
    // Once: a later change to the retired columns doesn't reach the pool.
    db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    db.exec("UPDATE projects SET reflect_fallbacks='[{\"agent\":\"claude\",\"model\":\"haiku\"}]'");
    db.close();
    const again = await boot(`return o.convoSnapshot({ cwd: '/x/a' }).project.reflect;`);
    assert.deepEqual(again, after.a);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
