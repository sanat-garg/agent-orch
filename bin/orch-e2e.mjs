#!/usr/bin/env node
// End-to-end check of one REAL orchestrator task on a given agent/model: boots server.mjs on a spare port against a
// throwaway CW_DATA_DIR (never the live data/ or port 3000), registers a scratch git project through Orchestrator Mode
// (its `origin` is a local bare repo whose path contains github.com/…, so pushes stay on disk and no GitHub repo is
// created), queues one small work task routed to the agent, and waits for claim → agent run → "Done when" check → done.
// Prints the task/run ids, the run log's tool events, the usage records and a live-DB isolation check as JSON.
//   node bin/orch-e2e.mjs --agent antigravity --model gemini-3.1-pro-high [--timeout 900] [--keep]
// Exit 0 only when the task ends 'done' with its check passing and every tool event on a file carries a path.

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
  agent: { type: 'string', default: 'antigravity' }, model: { type: 'string' }, timeout: { type: 'string', default: '900' }, keep: { type: 'boolean' },
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
  result.error = e.message;
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  child.kill('SIGKILL');
  result.serverLogTail = fs.readFileSync(serverLog, 'utf8').split('\n').slice(-15).join('\n');
  if (!opt.keep && result.ok) fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
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
