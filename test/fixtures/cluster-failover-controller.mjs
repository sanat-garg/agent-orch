#!/usr/bin/env node
// Controller for test/cluster-failover.test.mjs: the orchestrator plus the cluster hub on a local HTTP server (like
// server.mjs wires them), driven by JSON commands on stdin, one per line; each answer is one JSON line on stdout.
// Started again on the same data dir, it is a restarted controller (remote tasks are re-adopted).
//   node cluster-failover-controller.mjs <dataDir> <project> <graceMs>
// Commands: {cmd:'pair'} → {code} · {cmd:'task', title, prompt, agent, doneWhen, files} → {id} ·
// {cmd:'node', id, body} → cluster.update · {cmd:'get', id} → {task, runs (with their logs), events} · {cmd:'nodes'} ·
// {cmd:'detail', id} → orch.taskDetail · {cmd:'sql', sql, params} → {changes} (test/cluster-reports.test.mjs)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createOrchestrator } from '../../orchestrator.mjs';
import { createCluster } from '../../cluster.mjs';
import { CLAIM_PATH } from '../../cluster-protocol.mjs';

const [dataDir, repo, grace] = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

const o = createOrchestrator({
  config: { pollMs: 100, meminfo: new URL('./meminfo-ample', import.meta.url).pathname, footprint: { claude: 1, codex: 1 }, offerMs: 10_000 },
  query: () => { throw new Error('no Claude runs in this test'); }, dataDir, claudeEnv: { PATH: process.env.PATH }, getLimits: () => [], onSubscription: () => true,
  broadcast() {}, emitChat() {}, convoExists: () => false,
  onCommit: (dir) => { promisify(execFile)('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: dir }).catch((e) => console.error('push failed', e.message)); },
});
// Notices (auto-drain) go to the event log as in server.mjs; test homes may sit on a small /tmp, so no disk rule.
const cluster = createCluster({ dbFile: path.join(dataDir, 'orchestrator', 'agent-orch.db'), heartbeatMs: 300, wipPushMs: 1000, graceMs: Number(grace),
  health: { diskMinBytes: 0 }, onNotice: ({ text, level }) => o.logEvent(text, { level: level === 'warn' ? 'warn' : 'info' }) });
o.attachCluster(cluster);
const server = http.createServer(async (req, res) => {
  if (req.url !== CLAIM_PATH || req.method !== 'POST') { res.writeHead(404); return res.end(); }
  let body = '';
  for await (const c of req) body += c;
  const r = cluster.claim(JSON.parse(body));
  res.writeHead(r.status || 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(r.status ? { error: r.error } : r));
});
server.on('upgrade', (req, socket, head) => cluster.handleUpgrade(req, socket, head));
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
const pid = db.prepare('SELECT id FROM projects WHERE path=?').get(repo)?.id
  ?? Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,created_at) VALUES(?,?,50,'active',0,0)").run(repo, 'demo').lastInsertRowid);
out({ port: server.address().port });

for await (const line of readline.createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  if (c.cmd === 'pair') out(cluster.createPairing());
  else if (c.cmd === 'task') {
    out({ id: Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,priority,urgency,agent,files,done_when,created_at) VALUES(?,?,?,50,?,?,?,?,?)')
      .run(pid, c.title, c.prompt, 'normal', c.agent, JSON.stringify(c.files || null), c.doneWhen || null, Date.now() / 1000).lastInsertRowid) });
  } else if (c.cmd === 'node') out(cluster.update(c.id, c.body));
  else if (c.cmd === 'nodes') out({ nodes: cluster.listNodes() });
  else if (c.cmd === 'detail') out(o.taskDetail(c.id));
  else if (c.cmd === 'sql') out({ changes: Number(db.prepare(c.sql).run(...(c.params || [])).changes) });
  else if (c.cmd === 'get') {
    const runs = db.prepare('SELECT * FROM runs WHERE task_id=? ORDER BY id').all(c.id)
      .map((r) => ({ ...r, log: fs.existsSync(r.log_path) ? fs.readFileSync(r.log_path, 'utf8') : '' }));
    const events = db.prepare('SELECT message FROM events ORDER BY id').all().map((e) => e.message);
    out({ task: { ...db.prepare('SELECT * FROM tasks WHERE id=?').get(c.id), view: o.stateView().lanes.find((l) => l.task === c.id) || null }, runs, events });
  }
}
