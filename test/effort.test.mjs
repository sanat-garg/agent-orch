// Reasoning effort: Claude gets the SDK `effort` option and Codex `-c model_reasoning_effort=<level>`; other agents never
// see one. Tasks read their chat's CURRENT effort at every session boundary (start, resume), never a queue-time snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AGENTS, agentEfforts, clampEffort, codexModels, runAgentCli, setModelCatalog } from '../agents.mjs';

const fixture = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('only Claude and Codex declare effort levels', () => {
  assert.deepEqual(agentEfforts('claude'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(agentEfforts('codex'), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(agentEfforts('nope'), []);
});

test('clampEffort: the level itself, else the nearest lower one the agent and model accept', () => {
  setModelCatalog('codex', { models: codexModels(JSON.parse(fs.readFileSync(fixture('codex-models.json'), 'utf8'))), error: null, at: 1 });
  assert.equal(clampEffort('codex', 'ultra', 'gpt-6-sol'), 'ultra');
  assert.equal(clampEffort('codex', 'ultra', 'gpt-5.5'), 'xhigh', 'gpt-5.5 stops at xhigh (codex-cli 0.157)');
  assert.equal(clampEffort('codex', 'max', 'gpt-reserve'), 'max');
  assert.equal(clampEffort('codex', 'ultra', null), 'ultra');
  assert.equal(clampEffort('claude', 'ultra'), 'max');
  assert.equal(clampEffort('codex', 'minimal'), 'low', 'below every level: the lowest');
  assert.equal(clampEffort('claude', null), null);
  assert.equal(clampEffort('claude', 'bogus'), null);
  assert.equal(clampEffort('nope', 'high'), null);
});

test('Claude gets the SDK effort option; none when unset', async () => {
  const seen = [];
  const query = ({ options }) => (async function* () {
    seen.push(options);
    yield { type: 'result', subtype: 'success', result: 'ok', session_id: 's', num_turns: 1 };
  })();
  await runAgentCli({ agent: 'claude', prompt: 'hi', cwd: os.tmpdir(), query, effort: 'xhigh' });
  await runAgentCli({ agent: 'claude', prompt: 'hi', cwd: os.tmpdir(), query, effort: 'ultra' }); // clamped
  await runAgentCli({ agent: 'claude', prompt: 'hi', cwd: os.tmpdir(), query });
  assert.equal(seen[0].effort, 'xhigh');
  assert.equal(seen[1].effort, 'max');
  assert.ok(!('effort' in seen[2]));
});

test('Codex gets -c model_reasoning_effort=<level>, on exec and on exec resume; none when unset', async () => {
  const dir = tmp('cw-effort-cx-'), log = path.join(dir, 'argv.json');
  try {
    const run = async (opts) => {
      fs.rmSync(log, { force: true });
      const res = await runAgentCli({ agent: 'codex', bin: fixture('codex-stub.mjs'), prompt: 'hi', cwd: dir, env: { ...process.env, CODEX_STUB_LOG: log }, ...opts });
      assert.equal(res.outcome, 'ok');
      return JSON.parse(fs.readFileSync(log, 'utf8')).argv;
    };
    const flag = (argv) => argv.filter((a, i) => argv[i - 1] === '-c' && a.startsWith('model_reasoning_effort'));
    assert.deepEqual(flag(await run({ effort: 'high' })), ['model_reasoning_effort=high']);
    const resumed = await run({ effort: 'low', resume: 'thread-1' });
    assert.equal(resumed[1], 'resume');
    assert.deepEqual(flag(resumed), ['model_reasoning_effort=low']);
    assert.deepEqual(flag(await run({})), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an agent without effort levels never receives an effort', async () => {
  const got = [];
  AGENTS.plain = { id: 'plain', label: 'Plain', run: async (opts) => { got.push(opts); return { outcome: 'ok', text: 'done' }; } };
  try {
    await runAgentCli({ agent: 'plain', prompt: 'hi', effort: 'high' });
    assert.ok(!('effort' in got[0]), JSON.stringify(Object.keys(got[0])));
  } finally { delete AGENTS.plain; }
});

// createOrchestrator starts timers, so each scenario runs in a child process: a fake SDK query() that records its
// options, the codex stub on PATH (argv logged per run), and convoEffort reading a mutable EFFORT map.
async function scenario(body) {
  const dirs = ['cw-eff-', 'cw-eff-p-', 'cw-eff-home-'].map(tmp);
  const [dataDir, root, home] = dirs;
  try {
    fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
    fs.symlinkSync(fixture('codex-stub.mjs'), path.join(home, '.local/bin/codex'));
    const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
      import { waitFor as until } from ${JSON.stringify(new URL('./helpers/wait.mjs', import.meta.url).href)};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, root, home] = process.argv.slice(1);
      const codexLog = path.join(home, 'codex-argv.json');
      globalThis.HOLD = 0;
      const EFFORT = {}, calls = [];
      const query = ({ options }) => (async function* () {
        calls.push({ effort: options.effort ?? null, resume: options.resume ?? null });
        yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
        if (HOLD) await new Promise((r) => { const t = setTimeout(r, HOLD); options.abortController.signal.addEventListener('abort', () => { clearTimeout(t); r(); }); });
        if (options.abortController.signal.aborted) return;
        yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 'sess-1', num_turns: 1 };
      })();
      const o = createOrchestrator({ config: { pollMs: 100 }, query, dataDir, getLimits: () => [], onSubscription: () => true,
        claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_STUB_LOG: codexLog },
        broadcast() {}, emitChat() {}, convoExists: () => true, convoEffort: (cid) => EFFORT[cid] ?? null });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      let n = 0;
      const project = (convo) => { const p = path.join(root, 'p' + ++n); fs.mkdirSync(p);
        return Number(db.prepare("INSERT INTO projects(path,name,convo_id,priority,status,perpetual,created_at) VALUES(?,?,?,50,'paused',0,0)").run(p, 'p' + n, convo).lastInsertRowid); };
      const task = (pid, title, agent = null) => Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,agent,created_at) VALUES(?,?,?,?,0)').run(pid, title, title, agent).lastInsertRowid);
      const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      const runs = (id) => db.prepare('SELECT agent, effort, outcome FROM runs WHERE task_id=? ORDER BY id').all(id).map((r) => ({ ...r }));
      const codexArgv = () => JSON.parse(fs.readFileSync(codexLog, 'utf8')).argv;
      const out = await (async () => { ${body} })();
      console.log(JSON.stringify(out));
      process.exit(0);`;
    const env = { ...process.env, HOME: home, PATH: `${path.join(home, '.local/bin')}:${process.env.PATH}` };
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, root, home], { encoding: 'utf8', timeout: 90000, env });
    return JSON.parse(stdout.trim().split('\n').pop());
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
}

test('a task queued before an effort change runs with the new effort (Claude and Codex)', { timeout: 60000 }, async () => {
  const r = await scenario(`
    EFFORT.c1 = 'low';
    const p = project('c1');
    const cl = task(p, 'claude work'), cx = task(p, 'codex work', 'codex');
    EFFORT.c1 = 'xhigh';   // after both were queued
    o.projectAction(p, { status: 'active' });
    await until(() => get(cl).status === 'done' && get(cx).status === 'done');
    return { calls, claudeRuns: runs(cl), codexRuns: runs(cx), argv: codexArgv() };`);
  assert.deepEqual(r.calls.map((c) => c.effort), ['xhigh']);
  assert.deepEqual(r.claudeRuns, [{ agent: 'claude', effort: 'xhigh', outcome: 'ok' }]);
  assert.deepEqual(r.codexRuns, [{ agent: 'codex', effort: 'xhigh', outcome: 'ok' }]);
  const i = r.argv.indexOf('model_reasoning_effort=xhigh');
  assert.ok(i > 0 && r.argv[i - 1] === '-c', r.argv.join(' '));
});

test("a resumed session uses the chat's updated effort; the running one kept its own; a task override wins", { timeout: 60000 }, async () => {
  const r = await scenario(`
    EFFORT.c1 = 'low';
    HOLD = 60000;
    const p = project('c1');
    const t = task(p, 'long work');
    o.projectAction(p, { status: 'active' });
    await until(() => calls.length === 1);
    EFFORT.c1 = 'max';                             // while it runs: no effect until the next session boundary
    o.projectAction(p, { status: 'paused' });      // aborts the run; its session is kept for the resume
    await until(() => get(t).status === 'queued' && o.stateView().running === 0);
    const kept = get(t).session_id;
    HOLD = 0;
    o.projectAction(p, { status: 'active' });
    await until(() => get(t).status === 'done');
    // A per-task override (the drawer) beats the chat's effort.
    const t2 = task(p, 'override');
    const set = o.taskAction(t2, 'effort', 'medium'), bad = o.taskAction(t2, 'effort', 'ultra');
    await until(() => get(t2).status === 'done');
    return { calls, runs: runs(t), kept, set, bad, t2: runs(t2) };`);
  assert.equal(r.kept, 'sess-1');
  assert.deepEqual(r.calls.slice(0, 2), [{ effort: 'low', resume: null }, { effort: 'max', resume: 'sess-1' }]);
  assert.deepEqual(r.runs.map((x) => x.effort), ['low', 'max']);
  assert.deepEqual(r.set, { ok: true });
  assert.match(r.bad.error, /claude takes low, medium, high, xhigh, max/);
  assert.deepEqual(r.t2.map((x) => x.effort), ['medium']);
  assert.equal(r.calls.at(-1).effort, 'medium');
});

test('with no chat effort, neither agent gets one', { timeout: 60000 }, async () => {
  const r = await scenario(`
    const p = project('c1');
    const cl = task(p, 'claude work'), cx = task(p, 'codex work', 'codex');
    o.projectAction(p, { status: 'active' });
    await until(() => get(cl).status === 'done' && get(cx).status === 'done');
    return { calls, runs: [...runs(cl), ...runs(cx)], argv: codexArgv() };`);
  assert.deepEqual(r.calls.map((c) => c.effort), [null]);
  assert.deepEqual(r.runs.map((x) => x.effort), [null, null]);
  assert.ok(!r.argv.some((a) => a.startsWith('model_reasoning_effort')), r.argv.join(' '));
});
