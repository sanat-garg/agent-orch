#!/usr/bin/env node
// End-to-end check of one REAL orchestrator task on a given agent/model: boots server.mjs on a spare port against a
// throwaway CW_DATA_DIR (never the live data/ or port 3000), registers a scratch git project through Orchestrator Mode
// (its `origin` is a local bare repo whose path contains github.com/…, so pushes stay on disk and no GitHub repo is
// created), queues one small work task routed to the agent, and waits for claim → agent run → "Done when" check → done.
// Prints the task/run ids, the run log's tool events, the usage records and a live-DB isolation check as JSON.
//   node bin/orch-e2e.mjs --agent antigravity --model gemini-3.1-pro-high [--timeout 900] [--keep]
// Exit 0 only when the task ends 'done' with its check passing and every tool event on a file carries a path.
// --parallel instead queues two work tasks with disjoint `files` and no `after`, and checks that they ran at the same
// time, each in its own worktree under ../.agent-orch-worktrees, both merged onto main and pushed, and nothing was left
// behind (worktrees, agent-orch/task-* branches). Prints a summary line block including 'overlap: yes|no'.
//   node bin/orch-e2e.mjs --parallel --agent claude --model haiku

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt } = parseArgs({ options: {
  agent: { type: 'string', default: 'antigravity' }, model: { type: 'string' }, timeout: { type: 'string', default: '900' }, keep: { type: 'boolean' }, parallel: { type: 'boolean' },
} });
const HOME = os.homedir();
// The live service's minimal env (systemd unit), so the agent inherits no shell setup.
const SERVICE_ENV = { HOME, USER: os.userInfo().username, LOGNAME: os.userInfo().username, SHELL: os.userInfo().shell || '/bin/bash',
  LANG: 'C.UTF-8', PATH: `${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin` };
const LIVE_DB = path.join(ROOT, 'data/orchestrator/agent-orch.db');
const sh = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const liveSnapshot = () => {
  if (!fs.existsSync(LIVE_DB)) return null;
  const db = new DatabaseSync(LIVE_DB, { readOnly: true });
  try {
    return { projects: db.prepare('SELECT path FROM projects').all().map((r) => r.path), maxTask: db.prepare('SELECT MAX(id) AS m FROM tasks').get().m };
  } finally { db.close(); }
};

// ---- throwaway data dir, password, scratch project with a bare "github.com" origin
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `orch-e2e-${opt.agent}-`)));
const dataDir = path.join(tmp, 'data');
const proj = path.join(tmp, 'project');
const bare = path.join(tmp, 'github.com/scratch', `orch-e2e-${path.basename(tmp)}.git`);
fs.mkdirSync(dataDir);
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
fs.mkdirSync(path.join(proj, 'test'));
const PASSWORD = crypto.randomBytes(12).toString('hex');
const salt = crypto.randomBytes(16).toString('hex');
fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'orch-e2e', version: '1.0.0', type: 'module', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n');
fs.writeFileSync(path.join(proj, 'src/math.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n');
fs.writeFileSync(path.join(proj, 'test/math.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.mjs';\n\ntest('add', () => assert.equal(add(2, 3), 5));\n");
fs.writeFileSync(path.join(proj, '.gitignore'), 'node_modules/\n.agent-orch/shots/\n');
sh('git', ['init', '-q', '-b', 'main'], proj);
sh('git', ['add', '-A'], proj);
sh('git', ['-c', 'user.name=orch-e2e', '-c', 'user.email=orch-e2e@localhost', 'commit', '-q', '-m', 'scratch'], proj);
fs.mkdirSync(bare, { recursive: true });
sh('git', ['init', '-q', '--bare', bare]);
sh('git', ['remote', 'add', 'origin', bare], proj);
sh('git', ['push', '-q', '-u', 'origin', 'main'], proj);
const cid = crypto.randomUUID();
const t0 = Date.now();
const full = `scratch/${path.basename(bare, '.git')}`;
fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: cid, title: 'project', cwd: proj, createdAt: t0, updatedAt: t0,
  mode: 'bypassPermissions', fullAccess: true, repo: { full, url: `https://github.com/${full}` } }]));

const liveBefore = liveSnapshot();
const port = await freePort();
if (port === 3000) throw new Error('refusing port 3000');
const base = `http://127.0.0.1:${port}`;
const serverLog = path.join(tmp, 'server.log');
const out = fs.openSync(serverLog, 'a');
const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...SERVICE_ENV, PORT: String(port), CW_DATA_DIR: dataDir }, stdio: ['ignore', out, out] });
let result = { ok: false };
try {
  await waitFor(() => fs.readFileSync(serverLog, 'utf8').includes(`127.0.0.1:${port}`), 30e3, 'server start');
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = async (p, body) => {
    const r = await fetch(base + p, body ? { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: { cookie } });
    return r.json();
  };
  // The model has to be in the agent's discovered list or routing drops it.
  await waitFor(async () => (await api('/api/agents')).agents?.find((a) => a.id === opt.agent)?.models?.some((m) => m.id === opt.model), 120e3, `${opt.model} in the ${opt.agent} catalog`);
  // Orchestrator Mode on the chat registers the project; no reflection afterwards (it would run a planner on Claude).
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.send(JSON.stringify({ t: 'set_mode', cid, mode: 'orchestrator' }));
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator/agent-orch.db'));
  const project = await waitFor(() => db.prepare('SELECT * FROM projects WHERE path=?').get(proj), 15e3, 'project registered');
  ws.close();
  await api(`/api/orch/project/${project.id}`, { perpetual: false });
  if (opt.parallel) {
    result = await parallelRun(db, api, project);
    db.close();
    throw null; // skip the single-task path; `finally` still stops the server
  }
  // No HTTP route queues an owner task directly (the planner does), so insert it the way addTask does.
  const now = Date.now() / 1000;
  const taskId = Number(db.prepare(`INSERT INTO tasks(project_id,kind,title,prompt,priority,urgency,done_when,source,agent,model,position,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(project.id, 'work', 'Add a clamp function and its test',
    'Add an exported function `clamp(x, lo, hi)` to src/math.mjs that returns x limited to the range [lo, hi], and add tests for it in ' +
    'test/math.test.mjs (below, inside and above the range). Keep the existing add() test. Make `npm test` pass.',
    80, 'normal', '`npm test` passes with the new clamp tests', 'user', opt.agent, opt.model, 0, now).lastInsertRowid);
  await api(`/api/orch/task/${taskId}/action`, { action: 'next' }); // wakes the tick loop
  const seen = new Set();
  const task = await waitFor(async () => {
    const d = await api(`/api/orch/task/${taskId}`);
    const s = d.task?.status ?? d.status;
    if (!seen.has(s)) { seen.add(s); console.error(`[orch-e2e] #${taskId} ${s} (${Math.round((Date.now() - t0) / 1000)}s)`); }
    return ['done', 'failed', 'cancelled', 'blocked'].includes(s) ? d : null;
  }, Number(opt.timeout) * 1000, 'task to finish', 5000);
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  const runs = db.prepare('SELECT id,purpose,outcome,session_id,input_tokens,output_tokens,log_path FROM runs WHERE task_id=? ORDER BY id').all(taskId);
  const kv = db.prepare("SELECT key,value FROM kv WHERE key LIKE 'blocked%' OR key LIKE 'agent_auth%'").all();
  const events = db.prepare('SELECT message FROM events WHERE task_id=? ORDER BY id').all(taskId).map((e) => e.message);
  db.close();
  const tools = [];
  for (const r of runs) {
    if (!r.log_path || !fs.existsSync(r.log_path)) continue;
    for (const l of fs.readFileSync(r.log_path, 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(l);
      if (e.k === 'tool') tools.push({ run: r.id, id: e.id, tool: e.tool ?? e.name, input: e.input });
      if (e.k === 'result') { const x = tools.find((t) => t.run === r.id && t.id === e.id); if (x) Object.assign(x, { isError: e.isError, output: String(e.text).slice(0, 160) }); }
    }
  }
  const usageFile = path.join(dataDir, 'metrics/usage.jsonl');
  const usage = fs.existsSync(usageFile) ? fs.readFileSync(usageFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((u) => u.agent === opt.agent) : [];
  const npmTest = spawnSync('npm', ['test'], { cwd: proj, encoding: 'utf8', env: SERVICE_ENV });
  const fileTools = tools.filter((x) => /view_file|write_to_file|replace_file_content|Read|Write|Edit/.test(x.tool));
  const liveAfter = liveSnapshot();
  result = {
    agent: opt.agent, model: opt.model, taskId, status: t.status, runs_on: `${t.agent}/${t.model}`, route_note: t.route_note, delegated_from: t.delegated_from,
    check: task.task.check, verify: String(t.verify_output || '').slice(-600), result: String(t.result || '').slice(0, 400), runs, events, tools, kv, usage,
    npmTestExit: npmTest.status, npmTestTail: (npmTest.stdout || '').trim().split('\n').slice(-8).join('\n'),
    commits: sh('git', ['log', '--oneline', '-5'], proj), pushed: sh('git', ['--git-dir', bare, 'log', '--oneline', '-1', 'main']),
    live: { before: liveBefore?.maxTask, projectsHaveScratch: !!liveAfter?.projects.some((p) => p.startsWith(tmp)) },
    tmp,
  };
  result.ok = t.status === 'done' && npmTest.status === 0 && fileTools.length > 0 && fileTools.every((x) => x.input?.file_path || x.input?.path)
    && !/Antigravity denied/.test(t.result || '') && !result.live.projectsHaveScratch && !result.delegated_from && !result.route_note;
} catch (e) {
  if (e) result.error = e.message;
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  child.kill('SIGKILL');
  result.serverLogTail = fs.readFileSync(serverLog, 'utf8').split('\n').slice(-15).join('\n');
  if (!opt.keep && result.ok) fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
if (opt.parallel) console.log(result.summary || `parallel e2e failed: ${result.error}`);
process.exit(result.ok ? 0 : 1);

async function waitFor(fn, ms, what, every = 500) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

// Two file-disjoint tasks queued together; their worktrees are sampled from the DB while they run (tasks.worktree is
// cleared once merged).
async function parallelRun(db, api, project) {
  const now = Date.now() / 1000;
  const spec = (n, fn, body) => ({ n, title: `Add ${n}.mjs with ${fn}() and its test`, files: [`src/${n}.mjs`, `test/${n}.test.mjs`],
    prompt: `Create src/${n}.mjs exporting ${body}, and test/${n}.test.mjs with node:test tests for it (at least three cases). ` +
      `Touch no other files. Make \`npm test\` pass.`,
    doneWhen: `\`node --test test/${n}.test.mjs\` passes` });
  const specs = [spec('a', 'double', '`double(x)` that returns 2 * x'), spec('b', 'reverse', '`reverse(s)` that returns the string s reversed')];
  const ids = specs.map((t) => Number(db.prepare(`INSERT INTO tasks(project_id,kind,title,prompt,priority,urgency,done_when,source,agent,model,files,position,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(project.id, 'work', t.title, t.prompt, 80, 'normal', t.doneWhen, 'user', opt.agent, opt.model,
    JSON.stringify(t.files), 0, now).lastInsertRowid));
  await api(`/api/orch/task/${ids[0]}/action`, { action: 'next' }); // wakes the tick loop
  const wts = Object.fromEntries(ids.map((id) => [id, new Set()]));
  const seen = new Set();
  let bothRunning = false;
  const views = await waitFor(async () => {
    const vs = [];
    for (const id of ids) {
      const d = await api(`/api/orch/task/${id}`);
      const s = d.task?.status ?? d.status;
      if (!seen.has(`${id}:${s}`)) { seen.add(`${id}:${s}`); console.error(`[orch-e2e] #${id} ${s} (${Math.round((Date.now() - t0) / 1000)}s)`); }
      const w = db.prepare('SELECT worktree FROM tasks WHERE id=?').get(id)?.worktree;
      if (w) wts[id].add(w);
      vs.push({ id, s, d });
    }
    if (vs.every((v) => v.s === 'running')) bothRunning = true;
    return vs.every((v) => ['done', 'failed', 'cancelled', 'blocked', 'needs_integration'].includes(v.s)) ? vs : null;
  }, Number(opt.timeout) * 1000, 'both tasks to finish', 2000);
  // Let the merge/cleanup that follows 'done' settle before looking at the repo.
  await new Promise((r) => setTimeout(r, 3000));
  const rows = ids.map((id) => db.prepare('SELECT id,status,started_at,finished_at,worktree,commit_sha,agent,model,route_note,delegated_from,result FROM tasks WHERE id=?').get(id));
  const runs = ids.map((id) => db.prepare('SELECT id,task_id,purpose,outcome,started_at,finished_at FROM runs WHERE task_id=? ORDER BY id').all(id));
  const events = db.prepare(`SELECT task_id,message FROM events WHERE task_id IN (${ids.join(',')}) ORDER BY id`).all().map((e) => `#${e.task_id} ${e.message}`);
  const [x, y] = rows;
  // Task intervals (started → finished, which includes the merge), and the agent runs themselves.
  const overlap = x.started_at < y.finished_at && y.started_at < x.finished_at;
  const workRuns = runs.map((rs) => rs.filter((r) => r.purpose === 'work'));
  const runOverlap = workRuns[0].some((r) => workRuns[1].some((q) => r.started_at < (q.finished_at ?? Infinity) && q.started_at < (r.finished_at ?? Infinity)));
  const wtRoot = path.join(tmp, '.agent-orch-worktrees');
  const wtList = ids.map((id) => [...wts[id]]);
  const ownWorktrees = ids.every((id, i) => wtList[i].length === 1 && wtList[i][0] === path.join(wtRoot, `project-task-${id}`))
    && wtList[0][0] !== wtList[1][0];
  const mainLog = sh('git', ['log', '--format=%h %s', 'main'], proj).split('\n');
  const originLog = sh('git', ['--git-dir', bare, 'log', '--format=%h %s', 'main']).split('\n');
  const onMain = ids.every((id) => mainLog.some((l) => l.includes(`#${id}:`)));
  const pushed = sh('git', ['rev-parse', 'main'], proj) === sh('git', ['--git-dir', bare, 'rev-parse', 'main']);
  const filesOnMain = specs.every((t) => t.files.every((f) => fs.existsSync(path.join(proj, f))));
  const leftWorktrees = sh('git', ['worktree', 'list', '--porcelain'], proj).split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).filter((d) => d !== proj);
  const leftDirs = fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [];
  const leftBranches = sh('git', ['branch', '--list', 'agent-orch/task-*', '--format=%(refname:short)'], proj).split('\n').filter(Boolean);
  const npmTest = spawnSync('npm', ['test'], { cwd: proj, encoding: 'utf8', env: SERVICE_ENV });
  const allDone = rows.every((r) => r.status === 'done');
  const clean = !leftWorktrees.length && !leftDirs.length && !leftBranches.length;
  const iso = (t) => (t ? new Date(t * 1000).toISOString().slice(11, 19) : '-');
  const summary = [
    `parallel e2e (${opt.agent}/${opt.model})`,
    ...rows.map((r, i) => `  #${r.id} ${r.status}  ${iso(r.started_at)} → ${iso(r.finished_at)}  worktree: ${wtList[i].join(', ') || '(none seen)'}  commit: ${r.commit_sha || '-'}`),
    `overlap: ${overlap ? 'yes' : 'no'} (task intervals; agent runs overlap: ${runOverlap ? 'yes' : 'no'}; both seen running at once: ${bothRunning ? 'yes' : 'no'})`,
    `own worktrees under ../.agent-orch-worktrees: ${ownWorktrees ? 'yes' : 'no'}`,
    `both done: ${allDone ? 'yes' : 'no'}; both on main: ${onMain && filesOnMain ? 'yes' : 'no'}; pushed to origin: ${pushed ? 'yes' : 'no'}; npm test on main: ${npmTest.status === 0 ? 'pass' : 'FAIL'}`,
    `leftovers: worktrees ${leftWorktrees.length + leftDirs.length}, agent-orch/task-* branches ${leftBranches.length}${clean ? ' (clean)' : `: ${[...leftWorktrees, ...leftDirs, ...leftBranches].join(', ')}`}`,
  ].join('\n');
  const liveAfter = liveSnapshot();
  const projectsHaveScratch = !!liveAfter?.projects.some((p) => p.startsWith(tmp));
  const ok = overlap && ownWorktrees && allDone && onMain && filesOnMain && pushed && clean && npmTest.status === 0 && !projectsHaveScratch
    && rows.every((r) => !r.route_note && !r.delegated_from);
  return {
    ok, parallel: true, agent: opt.agent, model: opt.model, ids, overlap, runOverlap, bothRunning, ownWorktrees, worktrees: wtList, allDone, onMain, filesOnMain, pushed,
    leftWorktrees, leftDirs, leftBranches, tasks: rows.map((r) => ({ ...r, result: String(r.result || '').slice(0, 300) })), runs, events,
    mainLog: mainLog.slice(0, 6), originLog: originLog.slice(0, 6), npmTestExit: npmTest.status,
    live: { before: liveBefore?.maxTask, projectsHaveScratch }, tmp, summary,
  };
}
