// Per-user caps in the orchestrator (createOrchestrator userCap, users.mjs capBlock): a task in a project whose owner
// has reached their cap for its model waits, with the cap as its reason, while other users' tasks run; it starts once
// the cap no longer applies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test("a capped user's task waits with the cap as its reason; other users' tasks run", { timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'user-cap-'));
  const dataDir = path.join(tmp, 'data'), repos = path.join(tmp, 'repos');
  fs.mkdirSync(repos);
  const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
    import { DatabaseSync } from 'node:sqlite';
    import { execFileSync } from 'node:child_process';
    import path from 'node:path';
    const [dataDir, repos] = process.argv.slice(1);
    let capped = true;
    const o = createOrchestrator({ query: () => (async function* () {})(), dataDir, disabled: true, claudeEnv: {}, getLimits: () => [],
      onSubscription: () => true, broadcast() {}, emitChat() {}, convoExists: () => false,
      config: { controllerWork: true, parallelTasks: 4 },
      projectUser: (dir) => (dir.endsWith('/sams') ? 'sam1' : 'admin'),
      userCap: (dir, agent) => (capped && dir.endsWith('/sams') && agent === 'claude'
        ? { agent, window: 'Fable', label: 'Claude · Fable', cap: 10, mine: 12, resetsAt: Date.now() / 1000 + 86400 } : null) });
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    let pos = 0;
    const task = (name) => {
      const repo = path.join(repos, name);
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,position,created_at) VALUES(?,?,50,'active',0,?,0)").run(repo, name, ++pos).lastInsertRowid);
      return Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,created_at) VALUES(?,'work',?,'p',?)").run(pid, name, Date.now() / 1000).lastInsertRowid);
    };
    const sams = task('sams'), mine = task('mine');
    const why = new Map(), out = {};
    const claim = () => { const c = o.claimNext(null, { why }); return c && c.task.title; };
    out.first = [claim(), claim()];
    out.why = why.get(sams) || null;
    capped = false;
    out.after = claim();
    console.log(JSON.stringify(out));
    process.exit(0);`;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repos], { cwd: ROOT, encoding: 'utf8', timeout: 45000 });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    assert.deepEqual(r.first, ['mine', null], "sam's task (ahead in the order) waits; the admin's runs");
    assert.match(r.why, /owner reached their 10% cap of the Claude · Fable weekly limit/);
    assert.equal(r.after, 'sams', 'it starts once the cap no longer applies');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
