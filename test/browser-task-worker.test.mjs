// A real worker with a stub agent: browser execution must never clone, check, commit or push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCluster } from '../cluster.mjs';
import { CLAIM_PATH } from '../cluster-protocol.mjs';
import { isolatedPath } from './helpers/isolated-path.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
test('worker browser execution uses a plain workspace and skips all git and done_when checks', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-task-worker-'));
  const home = path.join(tmp, 'home'), bin = path.join(tmp, 'bin');
  fs.mkdirSync(home); fs.mkdirSync(bin); isolatedPath(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec node ${path.join(ROOT, 'test/fixtures/worker-agent-stub.mjs')} "$@"\n`, { mode: 0o755 });
  const env = { HOME: home, PATH: bin, TMPDIR: tmp, AGENT_ORCH_REAPER: 'off' };
  const frames = [];
  const cluster = createCluster({ dbFile: path.join(tmp, 'hub.db'), heartbeatMs: 300 });
  cluster.onMessage((node, m) => frames.push(m));
  const server = http.createServer(async (req, res) => {
    if (req.url !== CLAIM_PATH) { res.writeHead(404); return res.end(); }
    let body = ''; for await (const c of req) body += c;
    const r = cluster.claim(JSON.parse(body));
    res.writeHead(r.status || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r));
  });
  server.on('upgrade', (req, socket, head) => cluster.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let child, out = '';
  try {
    const { code } = cluster.createPairing();
    await promisify(execFile)(process.execPath, ['worker.mjs', 'pair', '--controller', `http://127.0.0.1:${server.address().port}`, '--code', code, '--name', 'browser-test'], { cwd: ROOT, env });
    child = spawn(process.execPath, ['worker.mjs', 'run'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    const whome = path.join(home, '.agent-orch-worker');
    const { node } = JSON.parse(fs.readFileSync(path.join(whome, 'config.json')));
    await waitFor(() => { if (child.exitCode != null) throw new Error(out); return cluster.node(node)?.inventory?.agents?.some((a) => a.id === 'codex' && a.models?.length); }, { timeout: 15000 });
    assert.ok(cluster.node(node).features.includes('browser-task'));
    const job = 308;
    cluster.send(node, { t: 'job.offer', job, agent: 'codex' });
    await waitFor(() => frames.some((m) => m.t === 'job.accept' && m.job === job));
    cluster.send(node, { t: 'job.start', job, title: 'Read screen', prompt: 'ARGS', agent: 'codex', execution: 'browser', capabilities: ['browser'], identity: 'default',
      doneWhen: '`node -e "process.exit(1)"`', timeouts: { taskSec: 20 } });
    const done = await waitFor(() => frames.find((m) => m.t === 'job.done' && m.job === job), { timeout: 15000 });
    assert.equal(done.outcome, 'ok', JSON.stringify(done)); assert.equal(done.sha, undefined);
    assert.ok(!frames.some((m) => ['job.check', 'job.wip'].includes(m.t)));
    assert.deepEqual(fs.readdirSync(path.join(whome, 'worktrees')), []);
    assert.deepEqual(fs.readdirSync(path.join(whome, 'repos')), []);
    const cwd = path.join(whome, 'browser-tasks', String(job));
    assert.ok(!fs.existsSync(path.join(cwd, '.git')));
    const args = JSON.parse(fs.readFileSync(path.join(cwd, 'args.json')));
    assert.match(args.profile, /playwright/);
  } finally {
    child?.kill('SIGKILL');
    if (child && child.exitCode == null) await new Promise((r) => child.once('exit', r));
    cluster.close(); await new Promise((r) => server.close(r)); fs.rmSync(tmp, { recursive: true, force: true });
  }
});
