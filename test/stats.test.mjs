// stats.mjs (the Stats sheet): one raw snapshot from the task DB, chat logs, usage log, server metrics and git history.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createStats, commitKind, parseGitLog, windowPeriods, ownerAction, runModel, hourlyMachine } from '../stats.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-stats-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('commitKind: task, reflection, your edits and other commits', () => {
  assert.deepEqual(commitKind('agent-orch #238: Integrate #222: Remote sign-in'), { by: 'task', task: 238 });
  assert.deepEqual(commitKind('AO2 #20 failed: Rebrand (partial work)'), { by: 'task', task: 20 });
  assert.deepEqual(commitKind('agent-orch #100 (in progress): Sidebar footer'), { by: 'task', task: 100 });
  assert.deepEqual(commitKind('agent-orch: roadmap update (reflection #12)'), { by: 'reflect', task: 12 });
  assert.deepEqual(commitKind('agent-orch: uncommitted changes before merging #238'), { by: 'you', task: null });
  assert.deepEqual(commitKind('Chat: fix the menu'), { by: 'you', task: null });
  assert.deepEqual(commitKind('Initial commit'), { by: 'other', task: null });
});

test('parseGitLog: line counts and file lists leave generated files out', () => {
  const out = '\x1eabc1234567\t1790000000\tagent-orch #3: Add x\n\n5\t1\tsrc/a.js\n900\t10\tpackage-lock.json\n-\t-\tlogo.png\n2\t0\tnode_modules/x/y.js\n'
    + '\x1edef7654321\t1790000100\tChat: tweak\n\n1\t1\tREADME.md\n';
  assert.deepEqual(parseGitLog(out), [
    { sha: 'abc123456', t: 1790000000e3, by: 'task', task: 3, add: 5, del: 1, files: ['src/a.js'] },
    { sha: 'def765432', t: 1790000100e3, by: 'you', task: null, add: 1, del: 1, files: ['README.md'] },
  ]);
});

test('windowPeriods: one row per reset, with its peak and whether it has closed', () => {
  const now = 2_000_000e3;
  const rows = windowPeriods([
    { t: 10, agent: 'claude', kind: 'window', window: 'five_hour', pct: 20, resetsAt: 1000 },
    { t: 20, agent: 'claude', kind: 'window', window: 'five_hour', pct: 91, resetsAt: 1000 },
    { t: 30, agent: 'claude', kind: 'window', window: 'five_hour', pct: 88, resetsAt: 1000 }, // a reading after the peak
    { t: 40, agent: 'claude', kind: 'window', window: 'five_hour', pct: 5, resetsAt: 3_000_000 },
    { t: 50, agent: 'claude', kind: 'tokens', input: 1 },
  ], now);
  assert.equal(rows.length, 2);
  assert.deepEqual({ ...rows[0] }, { agent: 'claude', window: 'five_hour', resetsAt: 1000e3, first: 10, last: 30, peak: 91, end: 88, n: 3, closed: true });
  assert.equal(rows[1].closed, false);
});

test('ownerAction: what you steered, from the event log', () => {
  assert.equal(ownerAction('#209 (+1 dependent) moved before #202'), 'reorder');
  assert.equal(ownerAction('#200 moved after #183'), 'reorder');
  assert.equal(ownerAction('■ #226 cancelled; also #227'), 'cancel');
  assert.equal(ownerAction('#159 delegated by the owner from claude/opus to codex/gpt-6-sol'), 'delegate');
  assert.equal(ownerAction('✔ #237 approved; the queue continues'), 'review');
  assert.equal(ownerAction('project settings: {"status":"paused"}'), 'settings');
  assert.equal(ownerAction('started #223: Machines view'), null);
  assert.equal(ownerAction('pacing: 5h window at 20%'), null);
});

test('runModel: the model a run used, from the task and its moves', () => {
  const moved = { agent: 'claude', model: 'opus', ran_agent: 'codex', ran_model: 'gpt-6-sol',
    moves: JSON.stringify([{ at: 100, from: { agent: 'claude', model: 'opus' }, to: { agent: 'codex', model: 'gpt-6-sol' } }]) };
  assert.equal(runModel('claude', 50e3, moved), 'opus'); // before the move
  assert.equal(runModel('codex', 200e3, moved), 'gpt-6-sol'); // after it
  assert.equal(runModel('claude', 50e3, { agent: 'claude', model: null }), null); // the agent's default
  assert.equal(runModel('claude', 50e3, { ran_agent: 'claude', ran_model: 'haiku' }), 'haiku');
});

test('hourlyMachine: minute samples become hourly means and peaks', () => {
  const h = 1790000000e3 - (1790000000e3 % 3600e3);
  assert.deepEqual(hourlyMachine([{ t: h, cpu: 10, mem: 40 }, { t: h + 60e3, cpu: 30, mem: 50 }, { t: h + 3600e3, cpu: 5, mem: 45 }]),
    [{ t: h, cpu: 20, mem: 45, peak: 30 }, { t: h + 3600e3, cpu: 5, mem: 45, peak: 5 }]);
});

test('createStats: joins every source into one snapshot, cached until asked for fresh', async () => {
  const data = path.join(tmp, 'data'), repo = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(data, 'orchestrator', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(data, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(data, 'metrics'), { recursive: true });
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' });
  g('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.js'), '1\n2\n3\n');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}\n'.repeat(50));
  g('add', '.'); g('commit', '-qm', 'agent-orch #2: Add a');
  fs.writeFileSync(path.join(repo, 'a.js'), '1\n2\n');
  g('commit', '-qam', 'agent-orch: uncommitted changes before merging #3');

  const T = 1790000000; // epoch s, as the DB stores it
  const db = new DatabaseSync(path.join(data, 'orchestrator', 'agent-orch.db'));
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT, name TEXT, status TEXT, created_at REAL);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER, kind TEXT, title TEXT, status TEXT, urgency TEXT, source TEXT, origin TEXT,
      attempts INTEGER, continuations INTEGER, created_at REAL, started_at REAL, finished_at REAL, agent TEXT, model TEXT, ran_agent TEXT,
      ran_model TEXT, commit_sha TEXT, moves TEXT, node_id TEXT, effort TEXT);
    CREATE TABLE runs (id INTEGER PRIMARY KEY, task_id INTEGER, purpose TEXT, outcome TEXT, agent TEXT, node_id TEXT, effort TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, num_turns INTEGER, started_at REAL, finished_at REAL, log_path TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY, ts REAL, level TEXT, project_id INTEGER, task_id INTEGER, message TEXT);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL, os TEXT, arch TEXT, token_hash TEXT UNIQUE, created_at INTEGER NOT NULL,
      last_seen INTEGER, status TEXT NOT NULL DEFAULT 'offline');`);
  db.prepare('INSERT INTO nodes (id, name, os, created_at, last_seen, status) VALUES (?, ?, ?, ?, ?, ?)').run('n1', 'MacBook', 'darwin', T, T + 500, 'online');
  db.prepare('INSERT INTO projects VALUES (1, ?, ?, ?, ?)').run(repo, 'proj', 'active', T);
  const addT = db.prepare('INSERT INTO tasks (id, project_id, kind, title, status, urgency, source, origin, attempts, continuations, created_at, started_at, finished_at, agent, model, ran_agent, ran_model, commit_sha) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)');
  addT.run(2, 'work', 'Add a', 'done', 'normal', 'planner', 'chat', T + 60, T + 70, T + 400, 'claude', null, 'claude', 'opus', 'abc');
  addT.run(3, 'work', 'Polish', 'cancelled', 'background', 'reflection', 'reflection', T + 100, null, T + 200, null, null, null, null, null);
  const log = path.join(data, 'orchestrator', 'runs', 'run-000001.jsonl');
  fs.writeFileSync(log, `${JSON.stringify({ k: 'start', at: T + 70, agent: 'claude', model: 'claude-opus-5-5' })}\n{"k":"text","text":"hi"}\n`);
  db.prepare('INSERT INTO runs VALUES (1, 2, ?, ?, ?, ?, ?, 10, 20, 30, 4, ?, ?, ?)').run('work', 'ok', 'claude', 'controller', 'high', T + 70, T + 400, log);
  const ev = db.prepare('INSERT INTO events (ts, level, project_id, task_id, message) VALUES (?, ?, 1, ?, ?)');
  ev.run(T + 300, 'info', 2, '↻ #2 done-when check failed: npm test');
  ev.run(T + 400, 'info', 2, '✔ #2 done (check passed): Add a (commit abc)');
  ev.run(T + 200, 'info', 3, '■ #3 cancelled');
  db.close();

  fs.writeFileSync(path.join(data, 'logs', 'c1.jsonl'), [
    { t: 'user', text: 'Please add a to the project', ts: (T + 50) * 1000 },
    { t: 'text', text: 'On it', ts: (T + 55) * 1000 },
    { t: 'user', text: 'x'.repeat(2000), ts: (T + 500) * 1000 },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(data, 'metrics', 'usage.jsonl'), [
    { t: (T + 401) * 1000, agent: 'claude', kind: 'tokens', input: 1000, output: 20, cached: 30, source: 'task', ref: 2 },
    { t: (T + 60) * 1000, agent: 'claude', kind: 'tokens', input: 5, output: 6, cached: 7, source: 'chat', ref: null },
    { t: (T + 10) * 1000, agent: 'claude', kind: 'window', window: 'five_hour', pct: 40, resetsAt: T + 1000 },
    { t: (T + 20) * 1000, agent: 'claude', kind: 'limit', status: 'hit', resetsAt: T + 1000, window: 'five_hour' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(data, 'metrics', 'minutes.jsonl'), `${JSON.stringify({ t: T * 1000, cpu: 12, mem: 40 })}\n`);

  let clock = (T + 600) * 1000;
  const stats = createStats({ dataDir: data, convos: () => [{ id: 'c1', cwd: repo }], now: () => clock });
  const d = await stats.collect();
  assert.equal(d.since, T * 1000);
  assert.deepEqual(d.projects, [{ id: 1, name: 'proj', status: 'active', created: T * 1000 }]);
  assert.deepEqual(d.tasks.map((t) => [t.id, t.from, t.agent, t.model, t.finished]), [[2, 'you', 'claude', 'opus', (T + 400) * 1000], [3, 'reflection', null, null, (T + 200) * 1000]]);
  // The run's tokens come from the matching usage record (cache writes included) and its model from its log.
  assert.deepEqual({ ...d.runs[0], start: 0, end: 0 }, { id: 1, task: 2, p: 1, purpose: 'work', outcome: 'ok', agent: 'claude', model: 'claude-opus-5-5',
    node: 'controller', effort: 'high', start: 0, end: 0, turns: 4, in: 1000, out: 20, cached: 30 });
  assert.deepEqual(d.chat, [{ t: (T + 60) * 1000, agent: 'claude', in: 5, out: 6, cached: 7 }]);
  assert.deepEqual(d.you.map((m) => [m.p, m.words, m.text.length]), [[1, 6, 27], [1, 1, 600]]);
  assert.deepEqual(d.checks.map((c) => [c.task, c.ok]), [[2, false], [2, true]]);
  assert.deepEqual(d.owner.map((o) => o.kind), ['cancel']);
  assert.deepEqual(d.windows.map((w) => [w.window, w.peak, w.closed]), [['five_hour', 40, false]]);
  assert.deepEqual(d.limits.map((l) => [l.status, l.window]), [['hit', 'five_hour']]);
  assert.deepEqual(d.commits.map((c) => [c.by, c.task, c.add, c.del, c.files, c.p]), [['task', 2, 3, 0, ['a.js'], 1], ['you', null, 0, 1, ['a.js'], 1]]);
  assert.deepEqual(d.nodes, [{ id: 'n1', name: 'MacBook', os: 'darwin', status: 'online', lastSeen: (T + 500) * 1000 }]);
  assert.deepEqual(d.machine, [{ t: T * 1000 - ((T * 1000) % 3600e3), cpu: 12, mem: 40, peak: 12 }]);

  clock += 1000;
  assert.equal(await stats.collect(), d, 'cached');
  assert.notEqual(await stats.collect({ fresh: true }), d);
  clock += 60e3;
  assert.notEqual(await stats.collect(), d, 'expired');
});

test('createStats: a data dir with nothing in it gives empty lists', async () => {
  const d = await createStats({ dataDir: path.join(tmp, 'nothing') }).collect();
  for (const k of ['projects', 'tasks', 'runs', 'chat', 'you', 'owner', 'checks', 'moves', 'windows', 'limits', 'commits', 'machine', 'nodes']) assert.deepEqual(d[k], [], k);
});
