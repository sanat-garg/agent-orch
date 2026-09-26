// An Antigravity work task on a project without the autonomous flag must still launch agy with
// --dangerously-skip-permissions: headless agy denies every run_command otherwise (found by the #149 orchestrator run),
// so the worker could not run tests. Runs createOrchestrator in a child process with the agy stub as ~/.local/bin/agy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('agy work tasks skip permissions even on a non-autonomous project', { timeout: 60000 }, async () => {
  const dirs = ['cw-agyw-', 'cw-agyw-p-', 'cw-agyw-home-'].map((p) => fs.mkdtempSync(path.join(os.tmpdir(), p)));
  const [dataDir, root, home] = dirs;
  try {
    fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
    fs.symlinkSync(fileURLToPath(new URL('./fixtures/agy-stub.mjs', import.meta.url)), path.join(home, '.local/bin/agy'));
    const argvLog = path.join(home, 'agy-argv.json');
    const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
    const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
      import { setModelCatalog } from ${url('agents.mjs')};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, root, argvLog] = process.argv.slice(1);
      setModelCatalog('antigravity', { models: [{ id: 'gemini-3.1-pro-high' }], error: null, at: 1 });
      const query = () => { throw new Error('Claude must not run'); };
      createOrchestrator({ query, dataDir, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME, AGY_STUB: 'ok', AGY_STUB_LOG: argvLog },
        getLimits: () => [], onSubscription: () => true, broadcast() {}, emitChat() {}, convoExists: () => true });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const p = path.join(root, 'proj'); fs.mkdirSync(p);
      const pid = Number(db.prepare("INSERT INTO projects(path,name,status,perpetual,autonomous,created_at) VALUES(?,?,'active',0,0,0)").run(p, 'proj').lastInsertRowid);
      const id = Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,agent,model,created_at) VALUES(?,?,?,'antigravity','gemini-3.1-pro-high',0)")
        .run(pid, 'Add a function', 'code').lastInsertRowid);
      const get = () => db.prepare('SELECT status, ran_agent FROM tasks WHERE id=?').get(id);
      for (let i = 0; i < 300 && !fs.existsSync(argvLog); i++) await new Promise((r) => setTimeout(r, 100));
      for (let i = 0; i < 100 && get().status === 'running'; i++) await new Promise((r) => setTimeout(r, 100));
      console.log(JSON.stringify({ ...get(), argv: JSON.parse(fs.readFileSync(argvLog, 'utf8')).argv }));
      process.exit(0);`;
    const env = { ...process.env, HOME: home, PATH: `${path.join(home, '.local/bin')}:${process.env.PATH}` };
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, root, argvLog], { encoding: 'utf8', timeout: 50000, env });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(r.ran_agent, 'antigravity');
    assert.ok(r.argv.includes('--dangerously-skip-permissions'), JSON.stringify(r.argv));
    assert.deepEqual(r.argv.slice(r.argv.indexOf('--model'), r.argv.indexOf('--model') + 2), ['--model', 'gemini-3.1-pro-high']);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});
