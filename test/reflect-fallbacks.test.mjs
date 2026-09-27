// Reflection fallbacks (projects.reflect_fallbacks): reflection-queued tasks snapshot the project's curated list into
// tasks.fallbacks. Runs createOrchestrator in a child process (it starts timers) with a fake Claude `query`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('reflection-queued tasks snapshot the project reflection fallbacks', { timeout: 60000 }, async () => {
  const dirs = ['cw-rf-', 'cw-rf-p-'].map((p) => fs.mkdtempSync(path.join(os.tmpdir(), p)));
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
      setModelCatalog('codex', { models: [{ id: 'gpt-a' }, { id: 'gpt-mini' }], error: null, at: 1 });
      const block = (n) => '\\n\`\`\`agent-orch-tasks\\n' + JSON.stringify([{ title: 'Improve ' + n, prompt: 'do it' }]) + '\\n\`\`\`';
      // The first run in each project is its reflection: it queues one task named after the project; work tasks just finish.
      const seen = new Set();
      const query = ({ options }) => (async function* () {
        const n = path.basename(options.cwd), first = !seen.has(n);
        seen.add(n);
        yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok' + (first ? block(n) : ''), session_id: 's', num_turns: 1 };
      })();
      const o = createOrchestrator({ query, dataDir, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => false });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const pid = (n) => { const p = path.join(root, n); fs.mkdirSync(p); return Number(db.prepare("INSERT INTO projects(path,name,status,perpetual,created_at) VALUES(?,?,'active',0,0)").run(p, n).lastInsertRowid); };
      const ids = { curated: pid('curated'), auto: pid('auto'), empty: pid('empty') };
      o.setReflectFallbacks(ids.curated, [{ agent: 'codex', model: 'gpt-mini' }, { agent: 'claude', model: 'opus' }]);
      o.setReflectFallbacks(ids.empty, []);
      const view = o.setReflectFallbacks(ids.auto, null).project;
      for (const [n, p] of Object.entries(ids)) db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,source,origin,created_at) VALUES(?,'reflect',?,'(reflection)','reflection','reflection',0)").run(p, 'Reflect ' + n);
      const work = () => db.prepare("SELECT t.*, p.name AS pname FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.kind='work'").all();
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 300 && work().length < 3; i++) await sleep(100);
      // A later edit doesn't touch what's already queued.
      o.setReflectFallbacks(ids.curated, null);
      const out = { view: view.reflect_fallbacks,
        tasks: Object.fromEntries(work().map((t) => [t.pname, { fallbacks: t.fallbacks, origin: t.origin, source: t.source }])),
        after: db.prepare('SELECT reflect_fallbacks FROM projects WHERE id=?').get(ids.curated).reflect_fallbacks,
        missing: o.setReflectFallbacks(999, null).status };
      console.log(JSON.stringify(out));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, root], { encoding: 'utf8', timeout: 50000 });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(r.view, null);
    assert.deepEqual(Object.keys(r.tasks).sort(), ['auto', 'curated', 'empty'], JSON.stringify(r));
    for (const t of Object.values(r.tasks)) assert.deepEqual([t.origin, t.source], ['reflection', 'reflection']);
    assert.deepEqual(JSON.parse(r.tasks.curated.fallbacks), [{ agent: 'codex', model: 'gpt-mini' }, { agent: 'claude', model: 'opus' }]);
    assert.equal(r.tasks.auto.fallbacks, null, 'no list: they wait');
    assert.equal(r.tasks.empty.fallbacks, '[]', 'an empty list: they wait');
    assert.equal(r.after, null);
    assert.equal(r.missing, 404);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

// Settings → This project: each project's reflection model and fallbacks (projects.reflect_agent/_model/_fallbacks).
test('reflection settings are per project: its reflect task runs on its model; the work it queues snapshots its list', { timeout: 60000 }, async () => {
  const dirs = ['cw-rs-', 'cw-rs-p-'].map((p) => fs.mkdtempSync(path.join(os.tmpdir(), p)));
  const [dataDir, root] = dirs;
  try {
    const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
    const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
      import { setModelCatalog } from ${url('agents.mjs')};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, root] = process.argv.slice(1);
      setModelCatalog('claude', { models: [{ id: 'opus', default: true }, { id: 'sonnet' }], error: null, at: 1 });
      setModelCatalog('codex', { models: [{ id: 'gpt-a' }], error: null, at: 1 });
      const block = '\\n\`\`\`agent-orch-tasks\\n' + JSON.stringify([{ title: 'Improve it', prompt: 'do it' }]) + '\\n\`\`\`';
      const models = [];
      const query = ({ options }) => (async function* () {
        models.push(options.model || null);
        yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok' + (options.model === 'sonnet' ? block : ''), session_id: 's', num_turns: 1 };
      })();
      const o = createOrchestrator({ query, dataDir, config: { pollMs: 100 }, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => false });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const project = (name) => { const p = path.join(root, name); fs.mkdirSync(p);
        return Number(db.prepare("INSERT INTO projects(path,name,status,perpetual,created_at) VALUES(?,?,'paused',1,0)").run(p, name).lastInsertRowid); };
      const tuned = project('tuned'), plain = project('plain');
      const saved = o.setReflectSettings(tuned, { model: { agent: 'claude', model: 'sonnet' }, fallbacks: [{ agent: 'codex', model: 'gpt-a' }] });
      const missing = o.setReflectSettings(999, { model: null });
      // Reflection starts only after some work has landed and the queue is empty.
      for (const pid of [tuned, plain]) db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,created_at) VALUES(?,'work','Seed','seed','done',0)").run(pid);
      db.exec("UPDATE projects SET status='active'");
      const rows = (pid) => db.prepare("SELECT kind, agent, model, fallbacks FROM tasks WHERE project_id=? AND title != 'Seed' ORDER BY id").all(pid).map((r) => ({ ...r }));
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 300 && !(rows(tuned).some((t) => t.kind === 'work') && rows(plain).some((t) => t.kind === 'reflect')); i++) await sleep(100);
      console.log(JSON.stringify({ saved, missing, tuned: rows(tuned), plain: rows(plain), models }));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, root], { encoding: 'utf8', timeout: 50000 });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    assert.deepEqual(r.saved.reflect, { agent: 'claude', model: 'sonnet', fallbacks: [{ agent: 'codex', model: 'gpt-a' }] });
    assert.deepEqual(r.saved.project.reflect, r.saved.reflect);
    assert.equal(r.missing.status, 404);
    const reflect = r.tuned.find((t) => t.kind === 'reflect'), work = r.tuned.find((t) => t.kind === 'work');
    assert.deepEqual([reflect?.agent, reflect?.model], ['claude', 'sonnet'], JSON.stringify(r));
    assert.ok(r.models.includes('sonnet'), 'the reflection ran on the project\'s model');
    assert.deepEqual(JSON.parse(work.fallbacks), [{ agent: 'codex', model: 'gpt-a' }], 'its queued work snapshots the project\'s list');
    const other = r.plain.find((t) => t.kind === 'reflect');
    assert.deepEqual([other?.agent, other?.model, other?.fallbacks], [null, null, null], 'another project keeps the defaults');
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
    db.close();
    const after = await boot(dataDir, `return { cap: o.stateView().capacity.cap, reflect: o.convoSnapshot({ cwd: '/x/a' }).project.reflect,
      reflect2: o.convoSnapshot({ cwd: '/x/b' }).project.reflect };`);
    assert.equal(after.cap, 1);
    assert.deepEqual(after.reflect, { agent: 'codex', model: 'gpt-a', fallbacks: [{ agent: 'claude', model: 'sonnet' }] });
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
