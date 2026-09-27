// Owner controls on a running task: pause keeps the worktree and session and resume continues that session there;
// a handoff starts another agent (the codex stub) in the same worktree with the previous session's messages, tool calls
// and the worktree's git state in its prompt. createOrchestrator runs in a child process with a fake Claude `query`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ph-'))), repo = path.join(root, 'proj');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  return { root, repo };
}

// The fake Claude session: a fresh one writes wip.txt (uncommitted), says so, calls a tool and then works until it is
// aborted. A resumed one (options.resume) finishes. `LIMIT` in the prompt: the session ends on a usage limit instead.
async function scenario(body, { codex = false } = {}) {
  const { root, repo } = makeRepo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ph-data-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ph-home-'));
  const bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  if (codex) fs.symlinkSync(new URL('./fixtures/codex-stub.mjs', import.meta.url).pathname, path.join(bin, 'codex'));
  try {
    const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
      import { setModelCatalog } from ${url('agents.mjs')};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      import { execFileSync } from 'node:child_process';
      const [dataDir, repo, stubLog] = process.argv.slice(1);
      setModelCatalog('claude', { models: [{ id: 'opus', default: true }], error: null, at: 1 });
      setModelCatalog('codex', { models: [{ id: 'gpt-a' }], error: null, at: 1 });
      const calls = [];
      const query = ({ prompt, options }) => (async function* () {
        calls.push({ cwd: options.cwd, resume: options.resume || null });
        if (options.resume) {
          fs.writeFileSync(path.join(options.cwd, 'done.txt'), 'finished\\n');
          yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: options.resume, num_turns: 1 };
          return;
        }
        fs.writeFileSync(path.join(options.cwd, 'wip.txt'), 'half done\\n');
        yield { type: 'system', subtype: 'init', session_id: 's-1' };
        yield { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'Halfway: wrote wip.txt, tests next' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } };
        if (/QUICK/.test(prompt)) { // finishes at once; the done-when check is what takes time
          yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 's-1', num_turns: 1 };
          return;
        }
        if (/LIMIT/.test(prompt)) {
          yield { type: 'rate_limit_event', session_id: 's-1', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' } };
          yield { type: 'assistant', session_id: 's-1', error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your limit · resets 5pm" }] } };
          yield { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 5pm", session_id: 's-1', num_turns: 1 };
          return;
        }
        await new Promise((r) => options.abortController.signal.addEventListener('abort', r, { once: true }));
      })();
      const o = createOrchestrator({ config: { pollMs: 100, meminfo: ${JSON.stringify(new URL('./fixtures/meminfo-ample', import.meta.url).pathname)} }, query, dataDir,
        claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_STUB_LOG: stubLog }, getLimits: () => [], onSubscription: () => true, broadcast() {}, emitChat() {}, convoExists: () => false });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,created_at) VALUES(?,?,50,'active',0,0)").run(repo, 'proj').lastInsertRowid);
      const add = (title, prompt, doneWhen = 'wip.txt exists') => Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,priority,done_when,created_at) VALUES(?,?,?,50,?,1)')
        .run(pid, title, prompt, doneWhen).lastInsertRowid);
      const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const until = async (f) => { for (let i = 0; i < 300 && !f(); i++) await sleep(100); return !!f(); };
      const out = await (async () => { ${body} })();
      console.log(JSON.stringify(out));
      process.exit(0);`;
    const stubLog = path.join(dataDir, 'codex-call.json');
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repo, stubLog], { encoding: 'utf8', timeout: 90000, env });
    return { ...JSON.parse(stdout.trim().split('\n').pop()), codexCall: fs.existsSync(stubLog) ? JSON.parse(fs.readFileSync(stubLog, 'utf8')) : null, repo };
  } finally {
    for (const d of [root, dataDir, home]) fs.rmSync(d, { recursive: true, force: true });
  }
}

describe('pause, resume and handoff', { concurrency: true, timeout: 120000 }, () => {
  test('pause keeps the worktree and session; the scheduler skips it; resume continues the same session there', async () => {
    const r = await scenario(`
      const id = add('Build it', 'build the thing');
      await until(() => calls.length === 1 && get(id).worktree && fs.existsSync(path.join(get(id).worktree, 'wip.txt')));
      const paused = await o.pauseTask(id);
      const wt = get(id).worktree, afterPause = { ...get(id) }, wtKept = fs.existsSync(path.join(wt, 'wip.txt'));
      await sleep(800); // the scheduler must leave a paused task alone
      const idle = calls.length;
      const again = await o.pauseTask(id);
      const resumed = o.resumeTask(id);
      await until(() => get(id).status === 'done');
      const merged = execFileSync('git', ['show', 'main:wip.txt'], { cwd: repo, encoding: 'utf8' });
      return { merged, paused: { ok: paused.ok, status: paused.task.status, note: paused.note || null }, afterPause, wtKept,
        idle, again, resumed: resumed.ok, calls, final: get(id).status, wt };`);
    assert.deepEqual(r.paused, { ok: true, status: 'paused', note: null });
    assert.equal(r.afterPause.status, 'paused');
    assert.equal(r.afterPause.session_id, 's-1', 'the session id is kept');
    assert.equal(r.afterPause.agent, 'claude', 'pinned to the agent it ran on');
    assert.equal(r.afterPause.attempts, 0, 'pausing costs no attempt');
    assert.ok(r.wtKept, 'the worktree and its uncommitted work stay');
    assert.equal(r.idle, 1, 'nothing ran while paused');
    assert.equal(r.again.status, 409, 'a paused task is not running');
    assert.ok(r.resumed);
    assert.equal(r.calls.length, 2);
    assert.deepEqual(r.calls[1], { cwd: r.wt, resume: 's-1' }, 'resume: same session, same worktree');
    assert.equal(r.final, 'done');
    assert.equal(r.merged, 'half done\n', 'the paused work merged with the rest');
  });

  test('handoff: codex starts in the same worktree with the diff, messages and tool calls in its prompt', async () => {
    const r = await scenario(`
      const id = add('Build it', 'build the thing');
      await until(() => calls.length === 1 && get(id).worktree && fs.existsSync(path.join(get(id).worktree, 'wip.txt')));
      const wt = get(id).worktree;
      const bad = [await o.handoffTask(id, { agent: 'codex', model: 'gpt-9000' }), await o.handoffTask(id, { agent: 'claude' })];
      const moved = await o.handoffTask(id, { agent: 'codex', model: 'gpt-a' });
      await until(() => ['done', 'failed'].includes(get(id).status));
      const t = get(id);
      return { bad: bad.map((b) => b.error || null), moved: { ok: moved.ok, note: moved.note || null }, wt, final: t.status,
        t: { agent: t.agent, model: t.model, ran_agent: t.ran_agent, delegated_from: t.delegated_from, delegated_reason: t.delegated_reason, moves: JSON.parse(t.moves), handoff: t.handoff },
        claudeCalls: calls.length };`, { codex: true });
    assert.match(r.bad[0], /not a codex model/);
    assert.match(r.bad[1], /already runs on claude\/default/);
    assert.deepEqual(r.moved, { ok: true, note: null });
    assert.equal(r.claudeCalls, 1, 'Claude was not asked again');
    assert.ok(r.codexCall, 'the codex stub ran');
    assert.equal(r.codexCall.cwd, r.wt, 'same worktree');
    assert.ok(!r.codexCall.argv.includes('resume'), 'a fresh codex session');
    const prompt = r.codexCall.argv.at(-1);
    assert.match(prompt, /moved this task to you from Claude \(default model\)/);
    assert.match(prompt, /do not redo it/);
    assert.match(prompt, /## git status\n\?\? wip\.txt/);
    assert.match(prompt, /## git diff --stat/);
    assert.match(prompt, /> Halfway: wrote wip\.txt, tests next/);
    assert.match(prompt, /## Its last tool calls\n- Bash · npm test/);
    assert.match(prompt, /# Task #\d+: Build it\n\nbuild the thing\n\n## Done when\nwip\.txt exists/);
    assert.equal(r.final, 'done');
    assert.deepEqual([r.t.agent, r.t.model, r.t.ran_agent], ['codex', 'gpt-a', 'codex']);
    assert.deepEqual([r.t.delegated_from, r.t.delegated_reason], ['claude/opus', 'moved by owner'], 'from the default model it ran on');
    assert.equal(r.t.moves.at(-1).by, 'owner');
    assert.equal(r.t.handoff, null, 'cleared once codex had its own session');
  });

  test('a limit that ends the run first: the requeued task still hands off, with the handoff prompt', async () => {
    const r = await scenario(`
      const id = add('Limited', 'LIMIT build the thing');
      await until(() => get(id).status === 'queued' && calls.length === 1);
      const moved = await o.handoffTask(id, { agent: 'codex', model: 'gpt-a' });
      await until(() => ['done', 'failed'].includes(get(id).status));
      return { moved: moved.ok, final: get(id).status, reason: get(id).delegated_reason };`, { codex: true });
    assert.ok(r.moved);
    assert.equal(r.reason, 'moved by owner');
    assert.equal(r.final, 'done');
    assert.match(r.codexCall.argv.at(-1), /moved this task to you from Claude/);
    assert.match(r.codexCall.argv.at(-1), /\?\? wip\.txt/);
  });

  test('races: a pause that lands during the done-when check pauses it; one on a finished task is refused', async () => {
    const r = await scenario(`
      const id = add('Checked', 'QUICK build it', 'Done when \`node -e "setTimeout(Boolean, 2500)"\` passes');
      await until(() => db.prepare("SELECT 1 AS x FROM events WHERE message LIKE 'checking #%'").get());
      const paused = await o.pauseTask(id);
      const mid = { status: get(id).status, attempts: get(id).attempts, session: get(id).session_id };
      o.resumeTask(id);
      await until(() => get(id).status === 'done');
      const late = await o.pauseTask(id);
      return { paused: paused.task.status, mid, final: get(id).status, late, resumes: calls.map((c) => c.resume) };`);
    assert.equal(r.paused, 'paused');
    assert.deepEqual(r.mid, { status: 'paused', attempts: 0, session: 's-1' });
    assert.equal(r.final, 'done');
    assert.deepEqual(r.resumes, [null, 's-1'], 'resumed the same session after the interrupted check');
    assert.equal(r.late.status, 409);
    assert.match(r.late.error, /is done, not running/);
  });
});
