// Orchestrator drain(): no new claims while draining; resolves once running tasks finish; undrain() resumes claiming.
// Restart-when-idle also waits for busy chat work (chatIdle/whenIdle, AUDIT #24).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chatIdle, whenIdle } from '../runtimes.mjs';

const ORCH = JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href);

// Same harness as scheduling.test.mjs: a child process with a fake query() and rows inserted before the first tick.
test('drain() lets the running task finish, claims nothing new, then resolves', { timeout: 120000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-drain-')), root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-drain-p-'));
  try {
    const script = `import { createOrchestrator } from ${ORCH};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, root] = process.argv.slice(1);
      const query = ({ options }) => (async function* () {
        await new Promise((r) => { const t = setTimeout(r, 2000); options.abortController.signal.addEventListener('abort', () => { clearTimeout(t); r(); }); });
        yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 's', num_turns: 1 };
      })();
      const o = createOrchestrator({ query, dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => false });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const p = path.join(root, 'p'); fs.mkdirSync(p);
      const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,created_at) VALUES(?,'p',50,'active',0,0)").run(p).lastInsertRowid);
      const task = (title, n) => Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,priority,urgency,created_at) VALUES(?,?,?,50,'normal',?)").run(pid, title, title, n).lastInsertRowid);
      const a = task('a', 1), b = task('b', 2);
      const get = (id) => db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 200 && get(a) !== 'running'; i++) await sleep(50);
      const before = { a: get(a), b: get(b), draining: o.stateView().draining };
      let resolved = false;
      const done = o.drain().then(() => { resolved = true; });
      const during = { draining: o.stateView().draining, resolved };
      await done;
      const after = { a: get(a), b: get(b), running: o.stateView().running };
      await sleep(4000); // more polls: b stays queued
      const later = { b: get(b), kv: db.prepare("SELECT count(*) AS n FROM kv WHERE key LIKE '%drain%'").get().n };
      let idle = false; await o.drain().then(() => { idle = true; });
      console.log(JSON.stringify({ before, during, after, later, idle }));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, root], { encoding: 'utf8', timeout: 90000 });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    assert.deepEqual(r.before, { a: 'running', b: 'queued', draining: false }); // one running task per project
    assert.deepEqual(r.during, { draining: true, resolved: false });
    assert.deepEqual(r.after, { a: 'done', b: 'queued', running: 0 });
    assert.deepEqual(r.later, { b: 'queued', kv: 0 });
    assert.equal(r.idle, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('chatIdle is false while a Claude reply, agent turn or chat planner turn is in flight', () => {
  const base = { runtimes: new Map([['a', { busy: false }]]), agentTurns: new Map(), planning: new Set() };
  assert.equal(chatIdle(base), true);
  assert.equal(chatIdle({ ...base, runtimes: new Map([['a', { busy: true }]]) }), false);
  assert.equal(chatIdle({ ...base, agentTurns: new Map([['b', new AbortController()]]) }), false);
  assert.equal(chatIdle({ ...base, planning: new Set(['c']) }), false);
  assert.equal(chatIdle({ ...base, chatPlanning: () => true }), false);
});

test('the restart exit waits while a chat turn is busy, and a cancel stops it', async () => {
  const rt = { busy: true }, runtimes = new Map([['a', rt]]);
  const idle = () => chatIdle({ runtimes, agentTurns: new Map(), planning: new Set() });
  let exited = null;
  const p = whenIdle({ drained: Promise.resolve(), idle, cancelled: () => false, pollMs: 20 }).then((ok) => { exited = ok; });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(exited, null); // drained, but the chat reply is still running
  rt.busy = false;
  await p;
  assert.equal(exited, true);

  rt.busy = true;
  let cancel = false;
  const q = whenIdle({ drained: Promise.resolve(), idle, cancelled: () => cancel, pollMs: 20 });
  setTimeout(() => { cancel = true; }, 60);
  assert.equal(await q, false);
});

test('undrain() cancels a drain and task claiming resumes', { timeout: 120000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-drain-')), root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-drain-p-'));
  try {
    const script = `import { createOrchestrator } from ${ORCH};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      const [dataDir, root] = process.argv.slice(1);
      const query = () => (async function* () {
        yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 's', num_turns: 1 };
      })();
      const o = createOrchestrator({ query, dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => false });
      o.drain(); // before the first tick
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const p = path.join(root, 'p'); fs.mkdirSync(p);
      const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,created_at) VALUES(?,'p',50,'active',0,0)").run(p).lastInsertRowid);
      const a = Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,priority,urgency,created_at) VALUES(?,'a','a',50,'normal',1)").run(pid).lastInsertRowid);
      const get = () => db.prepare('SELECT status FROM tasks WHERE id=?').get(a).status;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await sleep(4000); // past a poll: nothing claimed while draining
      const drained = { a: get(), draining: o.stateView().draining };
      o.undrain();
      const undrained = o.stateView().draining;
      for (let i = 0; i < 200 && get() === 'queued'; i++) await sleep(50);
      console.log(JSON.stringify({ drained, undrained, a: get() }));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, root], { encoding: 'utf8', timeout: 90000 });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    assert.deepEqual(r.drained, { a: 'queued', draining: true });
    assert.equal(r.undrained, false);
    assert.notEqual(r.a, 'queued');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
