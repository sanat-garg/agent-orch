// Parallel planning (#156): glob-aware file-overlap gating, multi-dependencies ("after": [...]), agent spreading across
// the fallback list, and an integrator task that starts only after all its parts. #302: the controller's own slots are the
// owner's setting (1-16, default from the head's cores: 4 on 2), memory only an emergency floor (/proc/meminfo fixture), and the low-memory pause.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { filesOverlap, parseFiles, spreadAssign, readMemInfo, taskSlots } from '../parallel.mjs';
import { extractTasks, resolveAfter, TASKS_FORMAT } from '../orchestrator.mjs';

const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
const fixture = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
// A /proc/meminfo with `availMB` available and `swapUsedMB` of a 4 GB swap in use.
const meminfo = (availMB, swapUsedMB = 0) => `MemTotal:       6000000 kB\nMemFree:  100000 kB\nMemAvailable:   ${availMB * 1024} kB\n` +
  `SwapTotal:      ${4096 * 1024} kB\nSwapFree:       ${(4096 - swapUsedMB) * 1024} kB\n`;

describe('file overlap', () => {
  test('plain paths, directories and globs', () => {
    const cases = [
      [['a.txt'], ['b.txt'], false],
      [['a.txt'], ['./a.txt'], true],
      [['src/*.js'], ['src/*.css'], false],
      [['src/*.js'], ['src/app.js'], true],
      [['src/**/*.js'], ['src/deep/x/a.js'], true],
      [['src/**/*.js'], ['src/**/*.css'], false],
      [['src/**/*.js'], ['src/a.css'], true],      // conservative: 'src/a.css' might be a directory holding .js files
      [['src/**'], ['src/a.css'], true],
      [['public'], ['public/app.js'], true],       // a plain path may be a directory
      [['.agent-orch'], ['.agent-orch/AUDIT.md'], true], // ...even with a dot in its name (AUDIT #31)
      [['test/fixtures.v2'], ['test/fixtures.v2/x.js'], true],
      [['src/a.mjs'], ['src/b.mjs'], false],
      [['.agent-orch/ROADMAP.md'], ['.agent-orch/AUDIT.md'], false],
      [['src/a/'], ['src/b/c.js'], false],
      [['test/*.test.mjs'], ['test/fixtures/x.mjs'], false],
      [['test/?.mjs'], ['test/a.mjs'], true],
      [['*.{js,css}'], ['app.css'], true],
      [['*.{js,css}'], ['app.html'], false],
      [['**'], ['anything/at/all.md'], true],
      [['a.txt', 'lib/**'], ['b.txt', 'lib/x/y.js'], true],
    ];
    for (const [a, b, want] of cases) {
      assert.equal(filesOverlap(a, b), want, `${a} vs ${b}`);
      assert.equal(filesOverlap(b, a), want, `${b} vs ${a} (symmetric)`);
    }
  });
  test('undeclared files overlap everything', () => {
    assert.equal(filesOverlap(null, ['a.txt']), true);
    assert.equal(filesOverlap(['a.txt'], []), true);
    assert.equal(filesOverlap('["a.txt"]', '["b.txt"]'), false); // JSON as stored in tasks.files
    assert.deepEqual(parseFiles([' ./src/a.js ', 'src/a.js', 3, '']), ['src/a.js']);
    assert.equal(parseFiles([]), null);
  });
});

describe('planner block', () => {
  test('"after" takes one reference or an array; "files" is parsed', () => {
    assert.deepEqual(resolveAfter(null, [10, 11]), []);
    assert.deepEqual(resolveAfter(1, [10, 11]), [11]);
    assert.deepEqual(resolveAfter([0, 1, '#1', 0], [10, 11]), [10, 11, 1]); // "#1" is always task id 1
    assert.deepEqual(resolveAfter(['#12', 'x'], []), [12]);
    const [, p] = extractTasks('ok\n```agent-orch-tasks\n{"tasks": [{"title": "t", "prompt": "p", "after": [0, "#3"], "files": ["./ui/*.css"]}]}\n```');
    assert.deepEqual([p.tasks[0].after, p.tasks[0].files], [[0, '#3'], ['ui/*.css']]);
  });
});

describe('agent spreading (spreadAssign)', () => {
  const opts = (a) => [{ agent: 'claude', model: 'opus', primary: true }, ...a];
  test('primary first; only tasks that would wait spill to a fallback with a free slot and usage', () => {
    const ready = [
      { task: 1, options: opts([{ agent: 'codex', model: 'gpt-a' }]) },
      { task: 2, options: opts([{ agent: 'codex', model: 'gpt-a' }]) },
      { task: 3, options: opts([{ agent: 'third', model: 'g' }, { agent: 'codex', model: 'gpt-a' }]) },
      { task: 4, options: opts([]) },
    ];
    const got = spreadAssign(ready, { slotsFree: (a) => ({ claude: 1, codex: 2, third: 1 })[a], hasUsage: (a) => a !== 'third' }); // 'third': a stand-in agent id
    assert.deepEqual(got.map((g) => [g.task, g.agent, g.spilled]), [[1, 'claude', false], [2, 'codex', true], [3, 'codex', true]]);
    // With room on the primary nothing spills.
    assert.deepEqual(spreadAssign(ready.slice(0, 2), { slotsFree: () => 5, hasUsage: () => true }).map((g) => g.agent), ['claude', 'claude']);
  });
});

// A temp git repo (worktrees on) plus a HOME with the codex stub. The fake Claude query answers planner turns
// ('[Owner says]') with globalThis.PLAN as a tasks block, and work prompts by writing `WRITE <file> <text>` lines
// into its cwd after a short hold, or after the scenario releases a named WAIT gate. `setMem(MB, swapMB)` rewrites
// the scenario's meminfo (ample by default).
async function scenario(body, { config = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-par-'))), repo = path.join(root, 'proj');
  const dataDir = path.join(root, 'data'), home = path.join(root, 'home');
  fs.mkdirSync(repo); fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  fs.symlinkSync(fixture('codex-stub.mjs'), path.join(home, '.local/bin/codex'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  const mem = path.join(root, 'meminfo');
  fs.writeFileSync(mem, meminfo(12000));
  try {
    const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
      import { setModelCatalog } from ${url('agents.mjs')};
      import { waitFor as until } from ${url('test/helpers/wait.mjs')};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, repo] = process.argv.slice(1);
      const meminfo = ${meminfo.toString()};
      const setMem = (mb, swap = 0) => fs.writeFileSync(${JSON.stringify(mem)}, meminfo(mb, swap));
      setModelCatalog('claude', { models: [{ id: 'opus', default: true }], error: null, at: Date.now() });
      setModelCatalog('codex', { models: [{ id: 'gpt-a', default: true }], error: null, at: Date.now() });
      globalThis.PLAN = [];
      const released = new Set();
      const query = ({ prompt, options }) => (async function* () {
        if (/\\[Owner says\\]/.test(prompt)) {
          yield { type: 'result', subtype: 'success', result: 'Queued.\\n\`\`\`agent-orch-tasks\\n' + JSON.stringify({ tasks: PLAN }) + '\\n\`\`\`', session_id: 'plan', num_turns: 1 };
          return;
        }
        const gate = /^WAIT (\\w+)$/m.exec(prompt)?.[1];
        if (gate) await until(() => released.has(gate) || options.abortController.signal.aborted);
        else await new Promise((r) => setTimeout(r, 700));
        if (options.abortController.signal.aborted) return;
        for (const [, f, text] of prompt.matchAll(/^WRITE (\\S+) (\\S+)$/gm)) fs.writeFileSync(path.join(options.cwd, f), text + '\\n');
        yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 's-' + Math.random(), num_turns: 1 };
      })();
      const convo = { id: 'c1', cwd: repo, fallbacks: [{ agent: 'codex', model: 'gpt-a' }] };
      const o = createOrchestrator({ query, dataDir, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => true, config: ${JSON.stringify({ pollMs: 100, meminfo: mem, ...config })} });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const all = () => db.prepare("SELECT * FROM tasks WHERE kind='work' ORDER BY id").all();
      const byTitle = (t) => all().find((r) => r.title === t);
      const plan = async (tasks) => { PLAN = tasks; await o.planTurn(convo, 'go'); db.prepare('UPDATE projects SET perpetual=0').run(); };
      // Run intervals, from what the fake query and the DB saw: [started_at, finished_at] per title.
      const spans = () => Object.fromEntries(all().map((t) => [t.title, [t.started_at, t.finished_at]]));
      const out = await (async () => { ${body} })();
      console.log(JSON.stringify(out));
      process.exit(0);`;
    const env = { ...process.env, HOME: home, PATH: `${path.join(home, '.local/bin')}:${process.env.PATH}` };
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repo], { encoding: 'utf8', timeout: 110000, env });
    return { repo, ...JSON.parse(stdout.trim().split('\n').pop()) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];

describe('parallel scheduling', { concurrency: true, timeout: 120000 }, () => {
  test('with overlapWaits: file-disjoint tasks run together; overlapping (glob) and undeclared ones wait', async () => {
    const r = await scenario(`
      await plan([
        { title: 'A', prompt: 'WRITE a.js A', files: ['src/a.js'] },
        { title: 'B', prompt: 'WRITE b.js B', files: ['src/b.js'] },
        { title: 'C', prompt: 'WRITE c.js C', files: ['src/*.js'] },
        { title: 'D', prompt: 'WRITE d.txt D' },
      ]);
      await until(() => all().length === 4 && all().every((t) => t.status === 'done'));
      return { spans: spans(), statuses: all().map((t) => t.status), files: all().map((t) => JSON.parse(t.files)) };`, { config: { concurrency: 4, parallelTasks: 4, agentSlots: 4, overlapWaits: true } });
    assert.deepEqual(r.statuses, ['done', 'done', 'done', 'done']);
    assert.deepEqual(r.files, [['src/a.js'], ['src/b.js'], ['src/*.js'], null]);
    const s = r.spans;
    assert.ok(overlaps(s.A, s.B), 'A and B (disjoint files) ran at the same time');
    assert.ok(!overlaps(s.C, s.A) && !overlaps(s.C, s.B), 'C (src/*.js) waited for A and B');
    for (const t of ['A', 'B', 'C']) assert.ok(!overlaps(s.D, s[t]), `D (no files) never ran beside ${t}`);
  });

  test('by default a free slot takes disjoint work first, then overlapping work runs beside the task it overlaps', async () => {
    const r = await scenario(`
      await plan([
        { title: 'A', prompt: 'WAIT a\\nWRITE a.js A', files: ['src/a.js'] },
        { title: 'C', prompt: 'WRITE c.js C', files: ['src/*.js'] },
        { title: 'B', prompt: 'WRITE b.js B', files: ['src/b.js'] },
      ]);
      await until(() => byTitle('C')?.status === 'done');
      const aStillRunning = byTitle('A').status === 'running';
      released.add('a');
      await until(() => all().length === 3 && all().every((t) => t.status === 'done'));
      return { spans: spans(), aStillRunning };`, { config: { concurrency: 2, parallelTasks: 2, agentSlots: 2 } });
    const s = r.spans;
    assert.ok(s.B[0] <= s.C[0], 'B (disjoint) took the free slot before C (overlapping), though queued after it');
    assert.ok(r.aStillRunning && overlaps(s.C, s.A), 'C ran beside A (src/*.js overlaps src/a.js) instead of waiting');
  });

  test('multi-dependency: the integrator starts only after ALL parts; cancel cascades and retry revives', async () => {
    const r = await scenario(`
      await plan([
        { title: 'part1', prompt: 'WRITE p1.txt one', files: ['p1.txt'] },
        { title: 'part2', prompt: 'WAIT part2\\nWRITE p2.txt two', files: ['p2.txt'] },
        { title: 'integrate', prompt: 'WRITE merged.txt both', after: [0, 1], done_when: '\`test -f p1.txt\` and \`test -f p2.txt\`' },
      ]);
      const ids = all().map((t) => t.id);
      const deps = db.prepare('SELECT task_id, depends_on FROM task_deps ORDER BY depends_on').all();
      const view = o.taskDetail(ids[2]);
      await until(() => byTitle('part1').status === 'done');
      const whenPart1Done = { part2: byTitle('part2').status, integrate: byTitle('integrate').status };
      released.add('part2');
      await until(() => all().every((t) => t.status === 'done'));
      // Cascade: a new pair where one prerequisite is cancelled.
      await plan([
        { title: 'x', prompt: 'WAIT x', files: ['x.txt'] },
        { title: 'y', prompt: 'WAIT y', files: ['y.txt'] },
        { title: 'z', prompt: 'ok', after: [0, 1] },
      ]);
      await until(() => byTitle('y').status === 'running');
      o.taskAction(byTitle('y').id, 'cancel');
      const cancelled = { z: byTitle('z').status, zResult: byTitle('z').result };
      o.taskAction(byTitle('y').id, 'retry');
      const revived = byTitle('z').status;
      released.add('x'); released.add('y');
      await until(() => ['x', 'y', 'z'].every((t) => byTitle(t).status === 'done'));
      return { ids, deps, after: view.after.map((t) => t.id), zDeps: view.task.deps, spans: spans(), whenPart1Done, cancelled, revived,
        statuses: all().map((t) => t.status) };`, { config: { concurrency: 3, parallelTasks: 3, agentSlots: 3 } });
    const [p1, p2, it] = r.ids;
    assert.deepEqual(r.deps, [{ task_id: it, depends_on: p1 }, { task_id: it, depends_on: p2 }]);
    assert.deepEqual(r.after, [p1, p2]);
    assert.deepEqual(r.zDeps, [p1, p2]);
    assert.deepEqual(r.whenPart1Done, { part2: 'running', integrate: 'queued' }, 'one finished part is not enough');
    const s = r.spans;
    assert.ok(overlaps(s.part1, s.part2), 'the parts ran in parallel');
    assert.ok(s.integrate[0] >= s.part1[1] && s.integrate[0] >= s.part2[1], 'the integrator started after both parts finished');
    assert.equal(r.cancelled.z, 'cancelled');
    assert.match(r.cancelled.zResult, /^cancelled with #\d+/);
    assert.equal(r.revived, 'queued');
    assert.ok(r.statuses.every((x) => x === 'done'), JSON.stringify(r.statuses));
  });

  test("agent spreading: a task beyond the primary's slots runs on the next fallback with usage left", async () => {
    const r = await scenario(`
      await plan([
        { title: 'S1', prompt: 'WAIT s1\\nWRITE s1.txt one', files: ['s1.txt'] },
        { title: 'S2', prompt: 'WRITE s2.txt two', files: ['s2.txt'] },
      ]);
      await until(() => o.stateView().lanes.length === 2);
      const state = o.stateView();
      await until(() => byTitle('S2')?.status === 'done');
      released.add('s1');
      await until(() => all().every((t) => t.status === 'done'));
      return { state, spans: spans(), rows: all().map((t) => ({ title: t.title, ran: t.ran_agent, agent: t.agent, moves: JSON.parse(t.moves || '[]'), reason: t.delegated_reason })) };`,
    { config: { parallelTasks: 2 } });
    assert.equal(r.state.slots, 2);
    assert.deepEqual(r.state.lanes.map(l => l.agent).sort(), ['claude', 'codex']);
    assert.ok(r.state.lanes.every(l => l.task > 0 && l.model && l.elapsed >= 0));
    const [s1, s2] = r.rows;
    assert.equal(s1.ran, 'claude', 'the first task keeps its primary model');
    assert.deepEqual(s1.moves, []);
    assert.equal(s2.ran, 'codex', 'the second spilled to the fallback');
    assert.deepEqual(s2.moves.map((m) => [m.from.agent, m.to.agent, m.to.model, m.by]), [['claude', 'codex', 'gpt-a', 'spread']]);
    assert.match(s2.reason, /^spread: Claude already runs 1 task/);
    assert.ok(overlaps(r.spans.S1, r.spans.S2), 'both ran at once, on two agents');
  });

  test('four work tasks by default on a 2-core head; the owner sets 1-16 and memory above the floor never lowers it, re-checked per claim', async () => {
    const r = await scenario(`
      const two = (a, b) => [{ title: a, prompt: 'WAIT ' + a + '\\nWRITE ' + a + '.txt x', files: [a + '.txt'] }, { title: b, prompt: 'WRITE ' + b + '.txt y', files: [b + '.txt'] }];
      const phase = async (a, b) => {
        await plan(two(a, b));
        await until(() => byTitle(a)?.status === 'running');
        for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 150)); // several scheduler polls
        const seen = { second: byTitle(b).status, slots: o.stateView().slots };
        released.add(a);
        await until(() => [a, b].every((t) => byTitle(t).status === 'done'));
        return seen;
      };
      const byDefault = await phase('d1', 'd2');
      const bad = o.setParallelSettings({ parallelTasks: 17 }).error;
      o.setParallelSettings({ parallelTasks: 1 });
      const one = await phase('o1', 'o2');
      o.setParallelSettings({ parallelTasks: 2 });
      setMem(1000, 2048); // 1 GB available, half the swap in use: above the emergency floor
      const lowMem = await phase('l1', 'l2');
      return { byDefault, bad, one, lowMem, setting: o.stateView().parallel.parallelTasks, spans: spans() };`,
    { config: { hardware: { cores: 2 } } });
    assert.equal(r.byDefault.slots, 4, 'default: four slots');
    assert.notEqual(r.byDefault.second, 'queued', 'default: the second task runs too');
    assert.ok(overlaps(r.spans.d1, r.spans.d2));
    assert.match(r.bad, /1-16/);
    assert.deepEqual(r.one, { second: 'queued', slots: 1 }, 'setting 1: the second task waits');
    assert.ok(!overlaps(r.spans.o1, r.spans.o2));
    assert.equal(r.setting, 2);
    assert.equal(r.lowMem.slots, 2, 'memory above the floor does not throttle');
    assert.notEqual(r.lowMem.second, 'queued');
    assert.ok(overlaps(r.spans.l1, r.spans.l2));
  });

  test('low memory: nothing is claimed under 800 MB; 30 s under 300 MB pauses the newest task, which resumes later', async () => {
    const r = await scenario(`
      await plan([{ title: 'M', prompt: 'WAIT m\\nWRITE m.txt m', files: ['m.txt'] }]);
      await until(() => byTitle('M')?.status === 'running');
      setMem(200);
      await until(() => byTitle('M').status === 'queued');
      const events = db.prepare("SELECT message FROM events WHERE message LIKE 'Paused #%' ORDER BY id").all().map((e) => e.message);
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 150));
      const whileLow = { status: byTitle('M').status, slots: o.stateView().slots,
        waiting: db.prepare("SELECT 1 AS x FROM events WHERE message LIKE 'waiting: server memory low%'").get()?.x === 1 };
      setMem(12000); released.add('m');
      await until(() => byTitle('M').status === 'done');
      return { events, whileLow, runs: db.prepare('SELECT COUNT(*) AS n FROM runs WHERE task_id=?').get(byTitle('M').id).n, status: byTitle('M').status };`,
    { config: { memCheckMs: 100, memLowPauseSec: 0.5 } });
    assert.match(r.events[0], /^Paused #\d+: server memory low$/);
    assert.deepEqual(r.whileLow, { status: 'queued', slots: 0, waiting: true });
    assert.equal(r.status, 'done');
    assert.ok(r.runs >= 2, 'the paused task ran again');
  });
});

test('taskSlots: the setting (capped by pacing) whenever memory is above the 800 MB floor; none under it', () => {
  const GB = 1024 ** 3;
  assert.equal(taskSlots({ mem: { avail: 4 * GB, swapPct: 0 } }), 1);
  assert.equal(taskSlots({ setting: 4, mem: { avail: 1 * GB, swapPct: 0 } }), 4);
  assert.equal(taskSlots({ setting: 16, mem: { avail: 1 * GB, swapPct: 0.9 } }), 16, 'swap does not throttle');
  assert.equal(taskSlots({ setting: 4, mem: { avail: 0.7 * GB, swapPct: 0 } }), 0);
  assert.equal(taskSlots({ setting: 4, mem: { avail: 4 * GB, swapPct: 0 }, pacingLimit: 2 }), 2);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mem-')), 'meminfo');
  fs.writeFileSync(f, meminfo(3000, 1024));
  assert.deepEqual(readMemInfo(f), { avail: 3000 * 1024 ** 2, swapPct: 0.25 });
  fs.rmSync(path.dirname(f), { recursive: true });
  assert.ok(readMemInfo(f).avail > 0, 'unreadable → os.freemem()');
});

test('shared task format permits independent parallel work with true prerequisites', () => {
  assert.match(TASKS_FORMAT, /Independent tasks can run in parallel across the cluster; use `after` only for true prerequisites\./);
  assert.doesNotMatch(TASKS_FORMAT, /machine runs one task at a time/);
  assert.doesNotMatch(TASKS_FORMAT, /parallel-group|decompose EVERY|Spread parts/);
  assert.match(TASKS_FORMAT, /`files` \(optional metadata\)/);
});
