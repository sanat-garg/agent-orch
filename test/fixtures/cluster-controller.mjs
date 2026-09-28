#!/usr/bin/env node
// Controller for the cluster e2e test (test/cluster-e2e.test.mjs): the orchestrator plus the cluster hub on a local HTTP
// server, like server.mjs wires them (with this $HOME's skills and subagents and <dataDir>'s MCP servers as the
// extension bundle, and each project's git endpoint for workers). Prints {base, code} (a pairing code), waits for a worker with codex to come online,
// queues two tasks in the project at argv[3] (one for codex, which only the worker has, and one for Claude, run here by
// a fake SDK query), waits for both to finish and prints the resulting rows as JSON.
//   node cluster-controller.mjs <dataDir> <project>
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createOrchestrator } from '../../orchestrator.mjs';
import { createCluster } from '../../cluster.mjs';
import { createExtensions } from '../../extensions.mjs';
import { createClusterGit } from '../../cluster-git.mjs';
import { CLAIM_PATH, EXT_PATH, GIT_PATH } from '../../cluster-protocol.mjs';

const [dataDir, repo] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

// Claude (local): writes local.txt in its cwd and reports done.
const query = ({ options }) => (async function* () {
  await sleep(300);
  fs.writeFileSync(path.join(options.cwd, 'local.txt'), 'written on the controller\n');
  yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — local.txt added', session_id: `s-${Date.now()}`, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } };
})();

const o = createOrchestrator({
  config: { pollMs: 100, meminfo: new URL('./meminfo-ample', import.meta.url).pathname, footprint: { claude: 1, codex: 1 }, offerMs: 10_000 },
  query, dataDir, claudeEnv: { PATH: process.env.PATH }, getLimits: () => [], onSubscription: () => true,
  broadcast() {}, emitChat() {}, convoExists: () => false,
  // server.mjs pushes every merge to GitHub (syncGit); here origin is the test's bare repo (none in cluster-git-e2e).
  onCommit: (dir) => { promisify(execFile)('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: dir }).catch((e) => console.error('push failed', e.message)); },
});
// Test homes may sit on a small /tmp: no low-disk auto-drain here.
const cluster = createCluster({ dbFile: path.join(dataDir, 'orchestrator', 'agent-orch.db'), heartbeatMs: 500, health: { diskMinBytes: 0 }, ext: createExtensions({ dataDir }) });
o.attachCluster(cluster);
const git = createClusterGit({ node: cluster.tokenNode, repo: o.gitRepo, pushable: o.pushableTasks, log: (m) => console.error(`[cluster-git] ${m}`) });
const server = http.createServer(async (req, res) => {
  if (req.url === EXT_PATH && req.method === 'GET') return cluster.handleExt(req, res);
  // CW_TEST_HEAD_GIT_DOWN: the head's git endpoint is unreachable (the worker falls back to GitHub).
  if (req.url.startsWith(`${GIT_PATH}/`)) return process.env.CW_TEST_HEAD_GIT_DOWN ? (res.writeHead(502), res.end()) : git.handle(req, res);
  if (req.url !== CLAIM_PATH || req.method !== 'POST') { res.writeHead(404); return res.end(); }
  let body = '';
  for await (const c of req) body += c;
  const r = cluster.claim(JSON.parse(body));
  res.writeHead(r.status || 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(r.status ? { error: r.error } : r));
});
server.on('upgrade', (req, socket, head) => cluster.handleUpgrade(req, socket, head));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
out({ base: `http://127.0.0.1:${server.address().port}`, code: cluster.createPairing().code });

const until = async (f, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { const v = f(); if (v) return v; } return null; };
const worker = await until(() => cluster.listNodes().find((n) => !n.local && n.status === 'online' && n.inventory?.agents?.some((a) => a.id === 'codex' && a.signedIn)), 30_000);
if (!worker) { out({ error: 'no worker came online' }); process.exit(1); }
// The worker may be a loaded laptop: no RAM reserve for its owner here (power.mjs reserveGB), only the claim floor.
cluster.update(worker.id, { policy: { reserveGB: 0 } });

const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,created_at) VALUES(?,?,50,'active',0,0)").run(repo, 'demo').lastInsertRowid);
const task = (title, prompt, agent, files, doneWhen) => Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,priority,urgency,agent,files,done_when,created_at) VALUES(?,?,?,50,?,?,?,?,?)')
  .run(pid, title, prompt, 'normal', agent, JSON.stringify(files), doneWhen, Date.now() / 1000).lastInsertRowid);
// ARGS: the worker's stub agent also commits args.json (its arguments, MCP profile and skills).
const remote = task('Add hello.txt', 'Create hello.txt ARGS', 'codex', ['hello.txt'], '`test -s hello.txt` passes');
const local = task('Add local.txt', 'Create local.txt', null, ['local.txt'], null);
const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
await until(() => [remote, local].every((id) => ['done', 'failed', 'cancelled', 'needs_integration'].includes(get(id).status)), 90_000);
const runs = db.prepare('SELECT * FROM runs ORDER BY id').all().map((r) => ({ ...r, log: fs.existsSync(r.log_path) ? fs.readFileSync(r.log_path, 'utf8') : '' }));
const events = db.prepare('SELECT message FROM events ORDER BY id').all().map((e) => e.message);
out({ worker: worker.id, remote: get(remote), local: get(local), runs, events, state: o.stateView() });
cluster.close();
process.exit(0);
