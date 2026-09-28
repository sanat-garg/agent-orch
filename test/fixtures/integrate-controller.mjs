#!/usr/bin/env node
// Controller for test/integrate-on-worker.test.mjs (#435): the orchestrator, the cluster hub and the project's git endpoint
// on a local HTTP server, like cluster-controller.mjs. Prints {base, code}, waits for a worker with codex (which only the
// worker has), then queues one codex task that rewrites README.md while the main branch changes README.md too, so its
// landing conflicts and integrators follow, all on the worker. Per scenario, while each integrator runs there:
//   land    nothing: main hasn't moved when it lands
//   moved   the first one sees main move on in another file (the landing rebases)
//   chain   every one sees main change README.md again (each landing conflicts)
// It prints the rows, events, runs, the owner's notifications and what the worker could push while each ran.
//   node integrate-controller.mjs <dataDir> <project> <scenario>
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createOrchestrator } from '../../orchestrator.mjs';
import { createCluster } from '../../cluster.mjs';
import { createClusterGit } from '../../cluster-git.mjs';
import { CLAIM_PATH, GIT_PATH } from '../../cluster-protocol.mjs';

const [dataDir, repo, scenario] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const notes = [];

const o = createOrchestrator({
  config: { pollMs: 100, meminfo: new URL('./meminfo-ample', import.meta.url).pathname, footprint: { claude: 1, codex: 1 }, offerMs: 10_000 },
  query: () => (async function* () {})(), dataDir, claudeEnv: { PATH: process.env.PATH }, getLimits: () => [], onSubscription: () => true,
  broadcast() {}, emitChat() {}, convoExists: () => false, notify: (n) => { notes.push(n); },
  // server.mjs pushes every merge to GitHub; here origin is the test's local bare repo.
  onCommit: (dir) => { promisify(execFile)('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: dir }).catch((e) => console.error('push failed', e.message)); },
});
const cluster = createCluster({ dbFile: path.join(dataDir, 'orchestrator', 'agent-orch.db'), heartbeatMs: 500, health: { diskMinBytes: 0 } });
o.attachCluster(cluster);
const git = createClusterGit({ node: cluster.tokenNode, repo: o.gitRepo, pushable: o.pushableTasks, log: (m) => console.error(`[cluster-git] ${m}`) });
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith(`${GIT_PATH}/`)) return git.handle(req, res);
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

const until = async (f, ms, what) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const v = f(); if (v) return v; }
  out({ error: `timed out waiting for ${what}` });
  process.exit(1);
};
const worker = await until(() => cluster.listNodes().find((n) => !n.local && n.status === 'online' && n.inventory?.agents?.some((a) => a.id === 'codex' && a.signedIn)), 30_000, 'the worker');
cluster.update(worker.id, { policy: { reserveGB: 0 } });

// A change on the main branch, committed in the main tree like the owner's own edits (retried past the orchestrator's
// own commits there; one that already took the edit along is fine).
async function commitMain(file, text, message) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text, { flag: file.endsWith('JOURNAL.md') ? 'a' : 'w' });
  for (let i = 0; ; i++) {
    try {
      execFileSync('git', ['add', '--', file], { cwd: repo, stdio: 'pipe' });
      execFileSync('git', ['-c', 'user.name=owner', '-c', 'user.email=owner@test', 'commit', '-qm', message], { cwd: repo, stdio: 'pipe' });
      return;
    } catch (e) {
      if (!execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()) return;
      if (i > 50) throw e;
      await sleep(100);
    }
  }
}

const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,created_at) VALUES(?,?,50,'active',0,0)").run(repo, 'demo').lastInsertRowid);
const owner = Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,priority,urgency,agent,files,done_when,created_at) VALUES(?,?,?,50,'normal','codex',?,?,?)")
  .run(pid, 'Rewrite README.md', 'Rewrite README.md WRITE:README.md TICKS:6', JSON.stringify(['README.md']), '`test -s README.md` passes', Date.now() / 1000).lastInsertRowid);
const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const ran = (id) => db.prepare('SELECT 1 AS x FROM runs WHERE task_id=?').get(id);
const integrators = () => db.prepare('SELECT * FROM tasks WHERE integrates=? ORDER BY id').all(owner);

// The owner's run has its base: README.md (and the journal, which a union merge keeps) change on main meanwhile.
await until(() => ran(owner), 60_000, 'the task to start');
await commitMain('README.md', 'edited on main\n', 'main edit');
await commitMain('.agent-orch/JOURNAL.md', '\n## main: an entry the owner wrote\n', 'journal entry on main');
const pushable = {}, seen = new Set();
await until(() => {
  const cur = integrators().at(-1);
  if (cur?.status === 'running' && ran(cur.id) && !seen.has(cur.id)) { // its job has its base now
    seen.add(cur.id);
    pushable[cur.id] = o.pushableTasks(worker.id, pid);
    const failed = (e) => { out({ error: `commit on main failed: ${e.message}` }); process.exit(1); };
    if (scenario === 'moved' && seen.size === 1) commitMain('other.txt', 'main moved on\n', 'main moved on').catch(failed);
    if (scenario === 'chain') commitMain('README.md', `main round ${seen.size}\n`, `main round ${seen.size}`).catch(failed);
  }
  return ['done', 'failed', 'cancelled'].includes(get(owner).status) && integrators().every((t) => !['queued', 'running'].includes(t.status));
}, 150_000, 'the integration to finish');
await sleep(300); // the landing's onCommit push to origin
const runs = db.prepare('SELECT task_id, node_id, outcome FROM runs ORDER BY id').all();
const events = db.prepare('SELECT message FROM events ORDER BY id').all().map((e) => e.message);
out({ worker: worker.id, owner: get(owner), integrators: integrators(), runs, events, notes, pushable });
cluster.close();
process.exit(0);
