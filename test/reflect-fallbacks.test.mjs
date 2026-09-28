// Reflection outcomes, migrations and direction (the reflection models themselves: reflect-pool.test.mjs). Runs
// createOrchestrator in a child process (it starts timers) with a fake Claude `query`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A reflection that ends without an agent-orch-tasks block is a slip, not a verdict: the empty streak stays and it
// retries in 5 min. An explicit empty list still bumps the streak.
test('reflection without a task block retries in 5 min; an empty list bumps the streak', { timeout: 60000 }, async () => {
  const dirs = ['cw-rm-', 'cw-rm-p-'].map((p) => fs.mkdtempSync(path.join(os.tmpdir(), p)));
  const [dataDir, root] = dirs;
  try {
    const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
    const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
      import { setModelCatalog } from ${url('agents.mjs')};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, root] = process.argv.slice(1);
      setModelCatalog('claude', { models: [{ id: 'opus', default: true }], error: null, at: 1 });
      const query = ({ options }) => (async function* () {
        const empty = path.basename(options.cwd) === 'empty';
        yield { type: 'result', subtype: 'success', result: 'Looked around.' + (empty ? '\\n\`\`\`agent-orch-tasks\\n{"tasks": []}\\n\`\`\`' : ''), session_id: 's', num_turns: 1 };
      })();
      const o = createOrchestrator({ query, dataDir, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => false });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const ids = {};
      for (const n of ['missing', 'empty']) {
        const p = path.join(root, n); fs.mkdirSync(p);
        ids[n] = Number(db.prepare("INSERT INTO projects(path,name,status,perpetual,created_at) VALUES(?,?,'active',0,0)").run(p, n).lastInsertRowid);
        db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES(?,'2')").run('reflect_empty_streak:' + ids[n]);
        db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,source,origin,created_at) VALUES(?,'reflect','Reflect','(reflection)','reflection','reflection',0)").run(ids[n]);
      }
      const done = () => db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind='reflect' AND status='done'").get().n;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 300 && done() < 2; i++) await sleep(100);
      const at = Date.now() / 1000, out = { at };
      for (const [n, id] of Object.entries(ids)) out[n] = { streak: db.prepare('SELECT value FROM kv WHERE key=?').get('reflect_empty_streak:' + id).value,
        next: db.prepare('SELECT next_reflect_at AS n FROM projects WHERE id=?').get(id).n,
        warn: db.prepare("SELECT level, message FROM events WHERE project_id=? AND message LIKE '%without a task block%'").all(id) };
      console.log(JSON.stringify(out));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, root], { encoding: 'utf8', timeout: 50000 });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(r.missing.streak, '2', JSON.stringify(r));
    assert.ok(Math.abs(r.missing.next - r.at - 300) < 30, 'retries in ~5 min');
    assert.equal(r.missing.warn.length, 1);
    assert.equal(r.missing.warn[0].level, 'warn');
    assert.match(r.missing.warn[0].message, /^reflection #\d+ ended without a task block; retrying in 5 min$/);
    assert.equal(r.empty.streak, '3', 'an explicit empty list is a verdict');
    assert.ok(r.empty.next - r.at > 300, 'backs off');
    assert.equal(r.empty.warn.length, 0);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

// Upgrading: the old every-project kv reflect_settings is copied into each project once; an install that ran one task at
// a time (no stored parallelTasks 2) keeps that as a cap of 1 (maxTasks); a fresh install has no cap.
test('migrations: global reflection settings move into every project; the old one-at-a-time default becomes a cap of 1', { timeout: 60000 }, async () => {
  const dirs = ['cw-rsm-', 'cw-rsm-fresh-'].map((p) => fs.mkdtempSync(path.join(os.tmpdir(), p)));
  const [dataDir, freshDir] = dirs;
  try {
    const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
    // Boots the orchestrator on dataDir, prints what `body` returns and exits.
    const boot = async (dir, body) => {
      const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
        const [dataDir] = process.argv.slice(1);
        const o = createOrchestrator({ query: () => (async function* () {})(), dataDir, disabled: true, claudeEnv: {}, getLimits: () => [], onSubscription: () => false,
          broadcast() {}, emitChat() {}, convoExists: () => false });
        console.log(JSON.stringify(await (async () => { ${body} })()));
        process.exit(0);`;
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dir], { encoding: 'utf8', timeout: 30000 });
      return JSON.parse(stdout.trim().split('\n').pop());
    };
    const fresh = await boot(freshDir, 'return o.stateView().capacity;');
    assert.equal(fresh.cap, null, 'a fresh install has no cap');
    await boot(dataDir, 'return null;');
    // Make it look like an install from before this change.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    const pid = Number(db.prepare("INSERT INTO projects(path,name,status,created_at) VALUES('/x/a','a','paused',0)").run().lastInsertRowid);
    const pid2 = Number(db.prepare("INSERT INTO projects(path,name,status,reflect_fallbacks,created_at) VALUES('/x/b','b','paused',?,0)").run('[{"agent":"claude","model":"opus"}]').lastInsertRowid);
    db.prepare("INSERT INTO tasks(project_id,title,prompt,status,created_at) VALUES(?,'old','old','done',0)").run(pid);
    db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES('reflect_settings',?)").run(JSON.stringify({ agent: 'codex', model: 'gpt-a', fallbacks: [{ agent: 'claude', model: 'sonnet' }] }));
    db.exec("DELETE FROM kv WHERE key IN ('parallel_cap_migrated','parallel_settings')");
    db.exec('ALTER TABLE projects DROP COLUMN reflect_pool'); // and from before #508, whose pool migration follows
    db.close();
    const after = await boot(dataDir, `return { cap: o.stateView().capacity.cap, reflect: o.convoSnapshot({ cwd: '/x/a' }).project.reflect,
      reflect2: o.convoSnapshot({ cwd: '/x/b' }).project.reflect };`);
    assert.equal(after.cap, 1);
    assert.deepEqual(after.reflect, { pool: [{ agent: 'codex', model: 'gpt-a' }, { agent: 'claude', model: 'sonnet' }], custom: true });
    assert.deepEqual(after.reflect2, after.reflect, 'the global list replaced the project\'s (it used to win anyway)');
    const db2 = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    assert.equal(db2.prepare("SELECT 1 AS x FROM kv WHERE key='reflect_settings'").get(), undefined, 'the global setting is gone');
    db2.close();
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

// The owner's optional reflection direction (projects.reflect_direction, Settings → This project): it leads the reflection
// prompt when set, is absent when blank, and a new direction skips the "found nothing" cooldown.
test('reflection direction: steers the reflect prompt when set; blank leaves it to the reflector', { timeout: 60000 }, async () => {
  const dirs = ['cw-rd-', 'cw-rd-p-'].map((p) => fs.mkdtempSync(path.join(os.tmpdir(), p)));
  const [dataDir, root] = dirs;
  try {
    const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
    const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
      import { setModelCatalog } from ${url('agents.mjs')};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, root] = process.argv.slice(1);
      setModelCatalog('claude', { models: [{ id: 'opus', default: true }], error: null, at: 1 });
      const prompts = {};
      const query = ({ prompt, options }) => (async function* () {
        prompts[path.basename(options.cwd)] = prompt;
        yield { type: 'result', subtype: 'success', result: 'Nothing to add.\\n\`\`\`agent-orch-tasks\\n[]\\n\`\`\`', session_id: 's', num_turns: 1 };
      })();
      const o = createOrchestrator({ config: { pollMs: 100 }, query, dataDir, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => false });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const project = (n) => { const p = path.join(root, n); fs.mkdirSync(p); const id = Number(db.prepare("INSERT INTO projects(path,name,status,perpetual,next_reflect_at,created_at) VALUES(?,?,'active',1,?,0)").run(p, n, Date.now() / 1000 + 9999).lastInsertRowid);
        db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,created_at) VALUES(?,'work','Seed','seed','done',0)").run(id); return id; };
      const steered = project('steered'), free = project('free');
      const long = 'Harden security: hash passwords and add a captcha to the login form. ' + 'x'.repeat(1200);
      o.projectAction(steered, { reflectDirection: '  ' + long + '  ' });
      const view = o.projectFor({ cwd: path.join(root, 'steered') });
      const cooldown = db.prepare('SELECT next_reflect_at AS n FROM projects WHERE id=?').get(steered).n;
      db.prepare('UPDATE projects SET next_reflect_at=0 WHERE id=?').run(free);
      o.projectAction(free, { reflectDirection: '   ' });
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 300 && Object.keys(prompts).length < 2; i++) await sleep(100);
      console.log(JSON.stringify({ prompts, stored: view.reflect_direction, cooldown, freeDir: db.prepare('SELECT reflect_direction AS d FROM projects WHERE id=?').get(free).d }));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, root], { encoding: 'utf8', timeout: 50000 });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(r.stored.length, 1000, 'trimmed and capped');
    assert.match(r.stored, /^Harden security: hash passwords/);
    assert.equal(r.cooldown, 0, 'a new direction reflects at once, past the cooldown');
    assert.equal(r.freeDir, null, 'blank means no direction');
    assert.match(r.prompts.steered, /The owner's direction for this reflection:\n> Harden security: hash passwords and add a captcha to the login form\./);
    assert.match(r.prompts.steered, /most of the steps you queue should serve it/);
    assert.match(r.prompts.steered, /unless the brief or the direction above asks for it/);
    assert.ok(r.prompts.steered.indexOf("owner's direction") < r.prompts.steered.indexOf('Ask yourself'), 'the direction comes first');
    assert.doesNotMatch(r.prompts.free, /owner's direction/);
    assert.match(r.prompts.free, /Ask yourself: what else should be done\?/);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});
