// AUDIT #28: an integrator that fails or is cancelled takes its 'needs_integration' owner along (same status, worktree
// parked on its branch, dependents blocked), and retrying the owner revives the chain.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A temp git repo (worktrees on). The fake query writes `WRITE <file> <text>` lines into its cwd after the scenario
// releases a named WAIT gate; integrator prompts follow globalThis.INTEG: 'fail' (never finishes), 'hold' (runs until
// aborted) or 'ok' (resolves like a worker).
async function scenario(body, { config = {}, origin = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-integ-'))), repo = path.join(root, 'proj');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  if (origin) { // a temp bare repo stands in for GitHub
    git(root, 'init', '-q', '--bare', 'origin.git');
    git(repo, 'remote', 'add', 'origin', path.join(root, 'origin.git'));
    git(repo, 'push', '-q', 'origin', 'main');
  }
  try {
    const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
      import { setModelCatalog } from ${url('agents.mjs')};
      import { waitFor as until } from ${url('test/helpers/wait.mjs')};
      import { DatabaseSync } from 'node:sqlite';
      import { execFileSync } from 'node:child_process';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, repo] = process.argv.slice(1);
      setModelCatalog('claude', { models: [{ id: 'opus', default: true }], error: null, at: Date.now() });
      globalThis.PLAN = [];
      globalThis.INTEG = 'fail';
      const released = new Set();
      const done = (text) => ({ type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: ' + text, session_id: 's-' + Math.random(), num_turns: 1 });
      const query = ({ prompt, options }) => (async function* () {
        const aborted = () => options.abortController.signal.aborted;
        if (/\\[Owner says\\]/.test(prompt)) {
          yield { type: 'result', subtype: 'success', result: 'Queued.\\n\`\`\`agent-orch-tasks\\n' + JSON.stringify({ tasks: PLAN }) + '\\n\`\`\`', session_id: 'plan', num_turns: 1 };
          return;
        }
        if (/finished in its own git worktree/.test(prompt) && INTEG !== 'ok') {
          if (INTEG === 'hold') await until(aborted, { timeout: 60000 });
          if (!aborted()) yield done('continue — conflicts left');
          return;
        }
        const gate = /^WAIT (\\w+)$/m.exec(prompt)?.[1];
        if (gate) await until(() => released.has(gate) || aborted(), { timeout: 60000 });
        if (aborted()) return;
        for (const [, f, text] of prompt.matchAll(/^WRITE (\\S+) (\\S+)$/gm)) fs.writeFileSync(path.join(options.cwd, f), text + '\\n');
        yield done('done — ok');
      })();
      const convo = { id: 'c1', cwd: repo };
      const o = createOrchestrator({ query, dataDir, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => true, config: ${JSON.stringify({ pollMs: 100, ...config })} });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const all = () => db.prepare("SELECT * FROM tasks WHERE kind='work' ORDER BY id").all();
      const byTitle = (t) => all().find((r) => r.title === t);
      const integratorOf = (id) => db.prepare('SELECT * FROM tasks WHERE integrates=:id ORDER BY id DESC').get({ id });
      const plan = async (tasks) => { PLAN = tasks; await o.planTurn(convo, 'go'); db.prepare('UPDATE projects SET perpetual=0').run(); };
      // Change README.md on the main tree while the gated task runs, so its merge conflicts.
      const conflictWhileRunning = async (title, text) => {
        await until(() => byTitle(title)?.status === 'running' && byTitle(title).worktree);
        fs.writeFileSync(path.join(repo, 'README.md'), text + '\\n');
        execFileSync('git', ['commit', '-qam', 'main change'], { cwd: repo });
        released.add(title);
        await until(() => byTitle(title).status === 'needs_integration');
      };
      const branchExists = (id) => { try { execFileSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/agent-orch/task-' + id], { cwd: repo }); return true; } catch { return false; } };
      const onOrigin = (id) => execFileSync('git', ['ls-remote', '--heads', 'origin', 'agent-orch/task-' + id], { cwd: repo, encoding: 'utf8' }).trim() !== '';
      const events = (id) => db.prepare('SELECT message FROM events WHERE task_id=:id ORDER BY id').all({ id }).map((e) => e.message);
      const out = await (async () => { ${body} })();
      console.log(JSON.stringify(out));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repo], { encoding: 'utf8', timeout: 110000 });
    return JSON.parse(stdout.trim().split('\n').pop());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('integrator failure releases its owner', { concurrency: true, timeout: 120000 }, () => {
  test('a failed integrator fails its owner and blocks its dependents; retrying the owner revives them', async () => {
    const r = await scenario(`
      await plan([
        { title: 'A', prompt: 'WAIT A\\nWRITE README.md A', files: ['README.md'] },
        { title: 'B', prompt: 'WRITE b.txt B', files: ['b.txt'], after: [0] },
      ]);
      await conflictWhileRunning('A', 'main');
      const integ = integratorOf(byTitle('A').id);
      await until(() => byTitle('A').status !== 'needs_integration');
      await until(() => byTitle('A').worktree === null);
      const failed = { a: byTitle('A'), b: byTitle('B'), integ: integratorOf(byTitle('A').id), branch: branchExists(byTitle('A').id), events: events(byTitle('A').id) };
      INTEG = 'ok';
      const retry = o.taskAction(failed.a.id, 'retry');
      const revived = byTitle('B').status;
      await until(() => byTitle('A').status === 'done' && byTitle('B').status === 'done');
      return { integId: integ.id, failed, retry, revived, readme: fs.readFileSync(path.join(repo, 'README.md'), 'utf8') };`,
    { config: { maxContinuations: 0 } });
    const { a, b, integ } = r.failed;
    assert.equal(integ.status, 'failed');
    assert.equal(a.status, 'failed');
    assert.match(a.result, new RegExp(`^integrator #${r.integId} failed: \\(unfinished\\)`));
    assert.equal(b.status, 'failed');
    assert.equal(b.result, `blocked: #${a.id} (integration)`);
    assert.equal(r.failed.branch, true, "the owner's work stays on its branch");
    assert.ok(r.failed.events.some((m) => m.includes(`its integrator #${r.integId} failed`)), JSON.stringify(r.failed.events));
    assert.deepEqual(r.retry, { ok: true });
    assert.equal(r.revived, 'queued');
    assert.equal(r.readme, 'A\n');
  });

  test('cancelling a running integrator cancels its owner and the owner\'s dependents', async () => {
    const r = await scenario(`
      INTEG = 'hold';
      await plan([
        { title: 'C', prompt: 'WAIT C\\nWRITE README.md C', files: ['README.md'] },
        { title: 'D', prompt: 'WRITE d.txt D', files: ['d.txt'], after: [0] },
      ]);
      await conflictWhileRunning('C', 'main');
      const cid = byTitle('C').id;
      await until(() => integratorOf(cid)?.status === 'running');
      const integ = integratorOf(cid);
      o.taskAction(integ.id, 'cancel');
      const now = { c: byTitle('C'), d: byTitle('D') };
      await until(() => byTitle('C').worktree === null && !fs.existsSync(path.join(repo, '..', '.agent-orch-worktrees', 'proj-task-' + cid)));
      return { integId: integ.id, now, branch: branchExists(cid) };`);
    assert.equal(r.now.c.status, 'cancelled');
    assert.equal(r.now.c.result, `cancelled with integrator #${r.integId}`);
    assert.equal(r.now.d.status, 'cancelled');
    assert.equal(r.now.d.result, `cancelled with #${r.now.c.id}`);
    assert.equal(r.branch, true);
  });

  test("an integrator's merge deletes the branch its owner pushed as WIP from origin", async () => {
    const r = await scenario(`
      INTEG = 'ok';
      await plan([{ title: 'E', prompt: 'WAIT E\\nWRITE README.md E', files: ['README.md'] }]);
      await until(() => byTitle('E')?.status === 'running' && byTitle('E').worktree);
      const eid = byTitle('E').id;
      // Stand in for a worker that pushed E's WIP to origin before E came back here.
      execFileSync('git', ['push', '-q', 'origin', 'main:refs/heads/agent-orch/task-' + eid], { cwd: repo });
      db.prepare('UPDATE tasks SET wip_sha=:s WHERE id=:id').run({ s: execFileSync('git', ['rev-parse', 'main'], { cwd: repo, encoding: 'utf8' }).trim(), id: eid });
      const pushed = onOrigin(eid);
      fs.writeFileSync(path.join(repo, 'README.md'), 'main\\n');
      execFileSync('git', ['commit', '-qam', 'main change'], { cwd: repo });
      released.add('E');
      await until(() => byTitle('E').status === 'done');
      const integ = integratorOf(eid);
      return { pushed, integ: integ.status, merged: byTitle('E').result, gone: !onOrigin(eid) };`, { origin: true });
    assert.equal(r.pushed, true);
    assert.equal(r.integ, 'done');
    assert.match(r.merged, /^Merged by integrator #/);
    assert.equal(r.gone, true, "the integrated task's branch is deleted from origin");
  });
});
