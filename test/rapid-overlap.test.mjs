// Rapid development mode and file overlap (#378): overlap is a preference, not a gate. A free slot takes overlapping
// work when nothing disjoint is ready (strict mode still waits); a per-file concurrency cap, tuned from 24 h of merge
// outcomes, is the only hard limit; a running task is never requeued for overlap; a merge conflict is retried once
// after a pause before an integrator is queued.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { FILE_CAP, nextFileCap, fileConcurrency, fileCapFull } from '../parallel.mjs';
import { plannerTurnPrompt, reflectPrompt, rapidQueueTarget } from '../orchestrator.mjs';

const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
const MEMINFO = new URL('./fixtures/meminfo-ample', import.meta.url).pathname; // ample memory whatever this machine has
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('per-file caps (parallel.mjs)', () => {
  test('nextFileCap: above 30% conflicts lowers by one (min 1), under 10% raises by one (max 6), between keeps', () => {
    assert.equal(nextFileCap(3, { conflicts: 2, total: 5 }), 2);
    assert.equal(nextFileCap(1, { conflicts: 1, total: 1 }), 1);
    assert.equal(nextFileCap(3, { conflicts: 0, total: 4 }), 4);
    assert.equal(nextFileCap(6, { conflicts: 0, total: 1 }), 6);
    assert.equal(nextFileCap(3, { conflicts: 1, total: 5 }), 3); // 20%: unchanged
    assert.equal(nextFileCap(3, { conflicts: 0, total: 0 }), 3);
    assert.equal(nextFileCap(undefined, { conflicts: 1, total: 1 }), FILE_CAP.default - 1);
    assert.equal(nextFileCap(99, { conflicts: 0, total: 1 }), FILE_CAP.max);
  });
  test('fileConcurrency counts running declarations touching a file; undeclared running work never counts', () => {
    const running = [['public/app.js'], ['public/*.js', 'server.mjs'], null, ['lib/x.mjs']];
    assert.equal(fileConcurrency('public/app.js', running), 2);
    assert.equal(fileConcurrency('server.mjs', running), 1);
    assert.equal(fileConcurrency('other.txt', running), 0);
  });
  test('fileCapFull names the first declared file at its cap; an undeclared task is never capped', () => {
    const running = [['a.js'], ['a.js'], ['b.js']];
    assert.equal(fileCapFull(['b.js', 'a.js'], running, () => 2), 'a.js');
    assert.equal(fileCapFull(['b.js', 'a.js'], running, () => 3), null);
    assert.equal(fileCapFull(['a.js'], running, (f) => (f === 'a.js' ? 6 : 1)), null);
    assert.equal(fileCapFull(null, running, () => 1), null);
  });
});

describe('hot files in the planner and reflection prompts', () => {
  const project = { name: 'p', path: '/p', priority: 50, mode: 'build' };
  const rapid = { ...rapidQueueTarget(10, 2, 1), hotFiles: [{ file: 'public/app.js', running: 2, cap: 3 }, { file: 'server.mjs', running: 1, cap: 2 }] };
  test('the planner turn lists hot files with their caps and asks for small localised edits', () => {
    const p = plannerTurnPrompt(project, [], 'Add a feature', '', rapid);
    assert.match(p, /Hot files .*public\/app\.js ×3, server\.mjs ×2/);
    assert.match(p, /small and localised/);
    assert.doesNotMatch(plannerTurnPrompt(project, [], 'Add a feature', '', { ...rapid, hotFiles: [] }), /Hot files/);
  });
  test('the rapid top-up prompt lists them too', () => {
    const p = reflectPrompt(project, [], '', false, [], '', [], { done: 0, failed: 0 }, '', rapid);
    assert.match(p, /Hot files .*public\/app\.js ×3, server\.mjs ×2/);
    assert.doesNotMatch(reflectPrompt(project, [], '', false, [], '', [], { done: 0, failed: 0 }, '', null), /Hot files/);
  });
});

// A temp git repo (worktrees on). The fake query answers planner turns with globalThis.PLAN as a tasks block, and work
// prompts by writing `WRITE <file> <text>` lines into its cwd after the scenario releases a named WAIT gate (or right
// away). An integrator prompt resolves like a worker (its owner's WRITE lines). `origin: true` adds a bare origin.
async function scenario(body, { config = {}, origin = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rapid-'))), repo = path.join(root, 'proj');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  if (origin) {
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
      const [dataDir, repo, root] = process.argv.slice(1);
      setModelCatalog('claude', { models: [{ id: 'opus', default: true }], error: null, at: Date.now() });
      globalThis.PLAN = [];
      const released = new Set();
      const done = (text) => ({ type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: ' + text, session_id: 's-' + Math.random(), num_turns: 1 });
      const query = ({ prompt, options }) => (async function* () {
        const aborted = () => options.abortController.signal.aborted;
        if (/\\[Owner says\\]/.test(prompt)) {
          yield { type: 'result', subtype: 'success', result: 'Queued.\\n\`\`\`agent-orch-tasks\\n' + JSON.stringify({ tasks: PLAN }) + '\\n\`\`\`', session_id: 'plan', num_turns: 1 };
          return;
        }
        const gate = /^WAIT (\\w+)$/m.exec(prompt)?.[1];
        if (gate) await until(() => released.has(gate) || aborted(), { timeout: 60000 });
        else await new Promise((r) => setTimeout(r, 300));
        if (aborted()) return;
        for (const [, f, text] of prompt.matchAll(/^WRITE (\\S+) (\\S+)$/gm)) fs.writeFileSync(path.join(options.cwd, f), text + '\\n');
        yield done('done — ok');
      })();
      const convo = { id: 'c1', cwd: repo };
      const o = createOrchestrator({ query, dataDir, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => true, config: ${JSON.stringify({ pollMs: 100, meminfo: MEMINFO, ...config })} });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const all = () => db.prepare("SELECT * FROM tasks WHERE kind='work' ORDER BY id").all();
      const byTitle = (t) => all().find((r) => r.title === t);
      const integratorOf = (id) => db.prepare('SELECT * FROM tasks WHERE integrates=:id ORDER BY id DESC').get({ id });
      const kv = (k) => db.prepare('SELECT value FROM kv WHERE key=:k').get({ k })?.value ?? null;
      const setKv = (k, v) => db.prepare('INSERT INTO kv(key,value) VALUES(:k,:v) ON CONFLICT(key) DO UPDATE SET value=:v').run({ k, v });
      const projectId = () => db.prepare('SELECT id FROM projects WHERE path=:p').get({ p: repo }).id;
      const plan = async (tasks) => { PLAN = tasks; await o.planTurn(convo, 'go'); db.prepare('UPDATE projects SET perpetual=0').run(); };
      const runsOf = (id) => db.prepare('SELECT COUNT(*) AS n FROM runs WHERE task_id=:id').get({ id }).n;
      const events = (id) => db.prepare('SELECT message FROM events WHERE task_id=:id ORDER BY id').all({ id }).map((e) => e.message);
      const allEvents = () => db.prepare('SELECT message FROM events ORDER BY id').all().map((e) => e.message);
      const runningWithWorktree = (title) => byTitle(title)?.status === 'running' && !!byTitle(title).worktree;
      const spans = () => Object.fromEntries(all().map((t) => [t.title, [t.started_at, t.finished_at]]));
      const settled = () => all().every((t) => !['queued', 'running', 'needs_integration'].includes(t.status));
      const mainCommit = (file, text, message = 'main change') => {
        fs.writeFileSync(path.join(repo, file), text + '\\n');
        execFileSync('git', ['add', '-A'], { cwd: repo });
        execFileSync('git', ['commit', '-qm', message], { cwd: repo });
      };
      const out = await (async () => { ${body} })();
      console.log(JSON.stringify(out));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repo, root], { encoding: 'utf8', timeout: 110000 });
    return JSON.parse(stdout.trim().split('\n').pop());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];

describe('rapid mode: file overlap is a preference, not a gate', { concurrency: true, timeout: 120000 }, () => {
  test('a free slot plus only an overlapping ready task: it starts in rapid mode', async () => {
    const r = await scenario(`
      await plan([{ title: 'A', prompt: 'WAIT a\\nWRITE a.js A', files: ['src/a.js'] }]);
      await until(() => runningWithWorktree('A'));
      await plan([{ title: 'C', prompt: 'WRITE c.js C', files: ['src/*.js'] }]);
      await until(() => byTitle('C')?.status === 'running');
      const aStillRunning = byTitle('A').status === 'running';
      released.add('a');
      await until(settled);
      return { aStillRunning, spans: spans(), statuses: all().map((t) => t.status) };`, { config: { parallelTasks: 2, agentSlots: 2 } });
    assert.ok(r.aStillRunning, 'C started while A (overlapping src/a.js) was still running');
    assert.ok(overlaps(r.spans.A, r.spans.C));
    assert.deepEqual(r.statuses, ['done', 'done']);
  });

  test('the same overlapping task waits for the running one when rapid mode is off', async () => {
    const r = await scenario(`
      setKv('parallel_settings', JSON.stringify({ rapidDevelopment: false }));
      await plan([{ title: 'A', prompt: 'WAIT a\\nWRITE a.js A', files: ['src/a.js'] }, { title: 'C', prompt: 'WRITE c.js C', files: ['src/*.js'] }]);
      await until(() => runningWithWorktree('A'));
      await new Promise((r) => setTimeout(r, 800)); // several scheduler ticks with a free slot
      const cWhileA = byTitle('C').status;
      released.add('a');
      await until(settled);
      return { cWhileA, spans: spans(), statuses: all().map((t) => t.status) };`, { config: { parallelTasks: 2, agentSlots: 2 } });
    assert.equal(r.cWhileA, 'queued', 'C waited while A ran');
    assert.ok(!overlaps(r.spans.A, r.spans.C) && r.spans.C[0] >= r.spans.A[1], 'C ran after A finished');
    assert.deepEqual(r.statuses, ['done', 'done']);
  });

  test('the per-file cap is enforced, and a clean merge raises it', async () => {
    const r = await scenario(`
      await plan([{ title: 'A', prompt: 'WAIT a\\nWRITE a.js A', files: ['src/a.js'] }]);
      await until(() => runningWithWorktree('A'));
      setKv('file_caps', JSON.stringify({ [projectId() + ':src/a.js']: 1 }));
      await plan([{ title: 'C', prompt: 'WRITE c.js C', files: ['src/a.js'] }, { title: 'D', prompt: 'WRITE d.js D', files: ['src/b.js'] }]);
      await until(() => byTitle('D')?.status === 'done');
      const cWhileA = byTitle('C').status, aWhileD = byTitle('A').status;
      released.add('a');
      await until(settled);
      return { cWhileA, aWhileD, spans: spans(), caps: JSON.parse(kv('file_caps')), outcomes: JSON.parse(kv('file_merge_outcomes')).map((o) => [o.f, o.c]),
        capEvents: allEvents().filter((m) => m.startsWith('hot file caps')), pid: projectId() };`, { config: { parallelTasks: 3, agentSlots: 3 } });
    assert.equal(r.aWhileD, 'running');
    assert.equal(r.cWhileA, 'queued', 'C waited: src/a.js was at its cap of 1');
    assert.ok(r.spans.C[0] >= r.spans.A[1], 'C started only after A finished');
    assert.ok(overlaps(r.spans.A, r.spans.D), 'D (src/b.js, under its cap) ran beside A');
    // A merged cleanly: 0% conflicts over 24 h raises src/a.js from 1 to 2; C's clean merge raises it again to 3 (the default: dropped).
    assert.ok(r.outcomes.some(([f, c]) => f === 'src/a.js' && c === 0), JSON.stringify(r.outcomes));
    assert.equal(r.caps[`${r.pid}:src/a.js`], undefined, `back at the default after two clean merges: ${JSON.stringify(r.caps)}`);
    assert.equal(r.caps[`${r.pid}:src/b.js`], 4, `src/b.js raised from the default: ${JSON.stringify(r.caps)}`);
    assert.ok(r.capEvents.some((m) => /src\/a\.js ×2/.test(m)), JSON.stringify(r.capEvents));
  });

  test('a running task is not requeued when an overlapping urgent task arrives', async () => {
    const r = await scenario(`
      await plan([{ title: 'A', prompt: 'WAIT a\\nWRITE a.js A', files: ['src/a.js'] }]);
      await until(() => runningWithWorktree('A'));
      const started = byTitle('A').started_at;
      await plan([{ title: 'U', prompt: 'WRITE u.js U', files: ['src/a.js'], urgency: 'urgent' }]);
      await until(() => byTitle('U')?.status === 'running');
      await new Promise((r) => setTimeout(r, 500));
      const a = byTitle('A');
      const during = { status: a.status, sameStart: a.started_at === started, runs: runsOf(a.id) };
      released.add('a');
      await until(settled);
      return { during, runs: runsOf(byTitle('A').id), events: events(byTitle('A').id), statuses: all().map((t) => t.status) };`, { config: { parallelTasks: 2, agentSlots: 2 } });
    assert.deepEqual(r.during, { status: 'running', sameStart: true, runs: 1 });
    assert.equal(r.runs, 1, 'A ran exactly once');
    assert.ok(!r.events.some((m) => /requeued|pausing|interrupted/.test(m)), JSON.stringify(r.events));
    assert.deepEqual(r.statuses, ['done', 'done']);
  });
});

describe('merge conflicts: fetch, retry once, then an integrator', { concurrency: true, timeout: 120000 }, () => {
  test('a conflict is retried after the pause; still conflicting, an integrator is queued and the file cap drops', async () => {
    const r = await scenario(`
      await plan([{ title: 'A', prompt: 'WAIT a\\nWRITE README.md A', files: ['README.md'] }]);
      await until(() => runningWithWorktree('A'));
      // A change pushed to origin's main (another machine's merge): the controller fetches it before rebasing.
      execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: repo }); // the controller's own commits are pushed, as the owner's protocol does
      const clone = path.join(root, 'clone');
      execFileSync('git', ['clone', '-q', '-b', 'main', path.join(root, 'origin.git'), clone]); // -b: the bare origin's HEAD may point at 'master'
      fs.writeFileSync(path.join(clone, 'README.md'), 'remote\\n');
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'remote change'], { cwd: clone });
      execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: clone });
      released.add('a');
      const aid = byTitle('A').id;
      await until(() => events(aid).some((m) => /retrying the rebase/.test(m)));
      await until(() => byTitle('A').status === 'needs_integration');
      const integ = integratorOf(aid);
      await until(settled);
      const log = execFileSync('git', ['log', '--format=%s', 'main'], { cwd: repo, encoding: 'utf8' });
      return { aid, integStatus: integratorOf(aid).status, a: byTitle('A'), events: events(aid), caps: JSON.parse(kv('file_caps')), pid: projectId(),
        readme: fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), log, integQueuedAfterRetry: !!integ };`,
    { config: { conflictRetryMs: 300 }, origin: true });
    assert.ok(r.events.some((m) => /fast-forwarded to origin before merging/.test(m)), JSON.stringify(r.events));
    assert.match(r.log, /remote change/, "origin's commit landed on main before the rebase");
    const retry = r.events.findIndex((m) => /retrying the rebase in 0 s/.test(m)), needs = r.events.findIndex((m) => /needs integration/.test(m));
    assert.ok(retry >= 0 && needs > retry, `retry before the integrator: ${JSON.stringify(r.events)}`);
    assert.equal(r.integStatus, 'done');
    assert.equal(r.a.status, 'done');
    assert.match(r.a.result, /^Merged by integrator #/);
    assert.equal(r.readme, 'A\n');
    assert.equal(r.caps[`${r.pid}:README.md`], FILE_CAP.default - 1, `100% conflicts lowered README.md's cap: ${JSON.stringify(r.caps)}`);
  });

  test('a conflict that clears before the retry merges without an integrator', async () => {
    const r = await scenario(`
      await plan([{ title: 'A', prompt: 'WAIT a\\nWRITE README.md A', files: ['README.md'] }]);
      await until(() => runningWithWorktree('A'));
      mainCommit('README.md', 'main');
      released.add('a');
      const aid = byTitle('A').id;
      await until(() => events(aid).some((m) => /retrying the rebase/.test(m)));
      mainCommit('README.md', 'x', 'revert'); // the other side backs out before the retry
      await until(settled);
      return { a: byTitle('A'), integ: integratorOf(aid) || null, events: events(aid), caps: JSON.parse(kv('file_caps')), pid: projectId(),
        readme: fs.readFileSync(path.join(repo, 'README.md'), 'utf8') };`, { config: { conflictRetryMs: 2500 } });
    assert.equal(r.a.status, 'done');
    assert.equal(r.integ, null, 'no integrator was queued');
    assert.ok(!r.events.some((m) => /needs integration/.test(m)), JSON.stringify(r.events));
    assert.equal(r.readme, 'A\n');
    assert.equal(r.caps[`${r.pid}:README.md`], FILE_CAP.default - 1, `the first conflict still counts for tuning: ${JSON.stringify(r.caps)}`);
  });
});
