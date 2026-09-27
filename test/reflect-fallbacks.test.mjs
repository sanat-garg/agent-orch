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

// Settings sheet (kv reflect_settings): one reflection model + fallback list for every project, over each project's own list.
test('reflection settings: the reflect task runs on the chosen model; the global list beats the project list', { timeout: 60000 }, async () => {
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
        yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok' + (models.length === 1 ? block : ''), session_id: 's', num_turns: 1 };
      })();
      const o = createOrchestrator({ query, dataDir, config: { pollMs: 100 }, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => false });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const p = path.join(root, 'proj'); fs.mkdirSync(p);
      const before = o.stateView().reflect;
      const saved = o.setReflectSettings({ model: { agent: 'claude', model: 'sonnet' }, fallbacks: [{ agent: 'codex', model: 'gpt-a' }] });
      const pid = Number(db.prepare("INSERT INTO projects(path,name,status,perpetual,created_at) VALUES(?,?,'active',1,0)").run(p, 'proj').lastInsertRowid);
      o.setReflectFallbacks(pid, [{ agent: 'claude', model: 'opus' }]);
      // Reflection starts only after some work has landed and the queue is empty.
      db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,created_at) VALUES(?,'work','Seed','seed','done',0)").run(pid);
      const rows = () => db.prepare("SELECT kind, agent, model, fallbacks FROM tasks WHERE title != 'Seed' ORDER BY id").all();
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 300 && !rows().some((t) => t.kind === 'work'); i++) await sleep(100);
      console.log(JSON.stringify({ before, saved, state: o.stateView().reflect, rows: rows(), models }));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, root], { encoding: 'utf8', timeout: 50000 });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    assert.deepEqual(r.before, { agent: null, model: null, fallbacks: null });
    assert.deepEqual(r.state, { agent: 'claude', model: 'sonnet', fallbacks: [{ agent: 'codex', model: 'gpt-a' }] });
    const reflect = r.rows.find((t) => t.kind === 'reflect'), work = r.rows.find((t) => t.kind === 'work');
    assert.deepEqual([reflect?.agent, reflect?.model], ['claude', 'sonnet'], JSON.stringify(r));
    assert.equal(r.models[0], 'sonnet', 'the reflection ran on the chosen model');
    assert.deepEqual(JSON.parse(work.fallbacks), [{ agent: 'codex', model: 'gpt-a' }], 'the global list wins over the project list');
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});
