import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createOrchestrator } from '../../orchestrator.mjs';
import { validate } from '../../cluster-protocol.mjs';
import { waitFor } from '../helpers/wait.mjs';

const [mode, dataDir] = process.argv.slice(2);
const calls = [], messages = [], frames = [];
let held = false, aborted = false;
const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
async function* query({ prompt, options }) {
  calls.push({ prompt, cwd: options.cwd, system: options.systemPrompt.append });
  if (prompt === 'slow') {
    await new Promise((resolve) => options.abortController.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    return;
  }
  yield { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'a', name: 'mcp__playwright__browser_navigate', input: { url: 'https://example.com' } },
    { type: 'tool_use', id: 'b', name: 'mcp__playwright__browser_click', input: { element: 'Open report', ref: 'e2' } },
    { type: 'tool_use', id: 'c', name: 'mcp__playwright__browser_type', input: { element: 'Search', text: 'report' } },
    { type: 'tool_use', id: 'd', name: 'mcp__playwright__browser_snapshot', input: {} },
    { type: 'tool_use', id: 'e', name: 'mcp__playwright__browser_take_screenshot', input: {} },
  ] } };
  yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }] }] } };
  yield { type: 'result', subtype: 'success', result: prompt === 'blocked' ? "I couldn't finish because the site needs a login." : 'Read the report.', session_id: 'browser-session', usage: {} };
}
const o = createOrchestrator({ query, dataDir, disabled: mode === 'queue', claudeEnv: process.env, getLimits: () => [],
  onSubscription: () => true, broadcast: (m) => messages.push(m), emitChat() {}, convoExists: () => false,
  projectReady: () => false, config: { pollMs: 30, controllerBrowser: true, agentSlots: 4 } });
await o.drain();
o.attachBrowserViews({ isTakenOver: () => held });
const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
const profile = { identity: 'default', node: 'controller' };
const create = (prompt, extra = {}) => o.createBrowserTask({ prompt, ...profile, ...extra }).taskId;
const row = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const done = (id) => waitFor(() => ['done', 'failed', 'cancelled'].includes(row(id).status), { timeout: 10000 });
if (mode === 'queue') {
  const remote = create('wait for Mac', { node: 'mac', identity: 'other' });
  assert.equal(o.claimNext(null), null, 'a worker pin never falls back locally without a cluster');
  o.stopBrowserTask(remote);
  const first = create('old'), id = create('Read the report '.repeat(8));
  const t = row(id);
  assert.equal(t.title.length, 60);
  assert.deepEqual(JSON.parse(t.capabilities), ['browser']);
  assert.equal(t.browser_identity, 'default'); assert.equal(t.run_on, 'controller');
  assert.equal(t.urgency, 'urgent'); assert.equal(t.done_when, null);
  assert.ok(t.position < row(first).position);
  held = true; assert.equal(o.claimNext(null), null);
  held = false; assert.equal(o.claimNext(null).task.id, id);
  assert.equal(o.claimNext(null), null, 'profile is locked');
  assert.deepEqual(o.stopBrowserTask(id), { ok: true });
  assert.equal(row(id).status, 'cancelled');
  assert.equal(o.claimNext(null).task.id, first);
  assert.equal(o.stopBrowserTask(9999).status, 404);
} else if (mode === 'local') {
  const id = create('read');
  o.watchTask({ readyState: 1, send: (m) => frames.push(JSON.parse(m)) }, id, true);
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(row(id).project_id);
  execFileSync('git', ['init', '-q', '-b', 'main', project.path]);
  fs.writeFileSync(path.join(project.path, 'untouched'), 'keep');
  execFileSync('git', ['add', '.'], { cwd: project.path });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed'], { cwd: project.path });
  const git = (...args) => execFileSync('git', args, { cwd: project.path, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD');
  db.prepare('UPDATE tasks SET done_when=? WHERE id=?').run('`node -e "process.exit(1)"`', id);
  held = true; o.undrain();
  await new Promise((r) => setTimeout(r, 200)); assert.equal(calls.length, 0);
  held = false; await done(id);
  assert.equal(row(id).status, 'done'); assert.equal(row(id).result, 'Read the report.');
  assert.equal(row(id).worktree, null); assert.equal(row(id).commit_sha, null);
  assert.notEqual(calls[0].cwd, project.path); assert.ok(!fs.existsSync(path.join(calls[0].cwd, '.git')));
  assert.equal(git('rev-parse', 'HEAD'), head); assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  assert.match(calls[0].system, /live browser screen/);
  await waitFor(() => o.listBrowserTasks(profile)[0]?.steps.length >= 5);
  const listed = o.listBrowserTasks(profile).find((t) => t.id === id);
  assert.deepEqual(listed.steps.slice(0, 5).map((s) => s.kind), ['nav', 'click', 'type', 'read', 'shot']);
  assert.match(listed.steps[4].mediaId, /^[a-f0-9]{64}\.png$/);
  assert.equal(listed.steps[1].label, 'Open report'); assert.ok(listed.steps.every((s) => s.ts > 0));
  assert.ok(listed.startedAt && listed.finishedAt); assert.equal(listed.resultText, 'Read the report.');
  const fail = create('blocked'); await done(fail); assert.equal(row(fail).status, 'failed');
  const slow = create('slow'); await waitFor(() => calls.some((c) => c.prompt === 'slow'));
  o.stopBrowserTask(slow); await waitFor(() => aborted && !o.isRunning(slow)); assert.equal(row(slow).status, 'cancelled');
  assert.ok(messages.some((m) => m.t === 'otask' && m.task.id === id));
  assert.ok(frames.some((m) => m.t === 'orun' && m.taskId === id && m.e.k === 'tool'));
  assert.ok(frames.some((m) => m.t === 'orun' && m.taskId === id && m.e.k === 'image'));
} else if (mode === 'remote') {
  let receive;
  const node = { id: 'mac', name: 'Mac', os: 'darwin', connected: true, status: 'online', maxSlots: 4,
    features: ['approvals', 'browser-task'], inventory: { cores: 8, browser: { capable: true }, agents: [{ id: 'claude', installed: true, signedIn: true }] }, resources: { memAvailable: 32 * 2 ** 30, at: Date.now() } };
  o.attachCluster({ listNodes: () => [node], version: () => 1, onMessage: (fn) => { receive = fn; },
    send: (nodeId, m) => {
      frames.push(m);
      if (m.t === 'job.offer') setImmediate(() => receive('mac', { t: 'job.accept', job: m.job }));
      if (m.t === 'job.start') setImmediate(() => {
        assert.equal(validate({ ...m, seq: 1, ts: Date.now() }, { from: 'c' }), null);
        assert.equal(m.execution, 'browser'); assert.equal(m.repo, undefined); assert.equal(m.baseSha, undefined);
        receive('mac', { t: 'job.event', job: m.job, from: 0, events: [
          { k: 'tool', name: 'mcp__playwright__browser_click', input: { element: 'Send' } },
          { k: 'approval', approval: { id: 'approval-test', action: 'Send report', server: 'playwright', tool: 'browser_click' } },
        ] });
        receive('mac', { t: 'job.done', job: m.job, outcome: 'ok', text: 'Sent report.', usage: {} });
      });
      return true;
    } });
  const id = create('Send report', { node: 'mac' });
  o.undrain(); await done(id);
  assert.equal(row(id).node_id, 'mac'); assert.equal(row(id).status, 'done'); assert.equal(row(id).worktree, null);
  await waitFor(() => o.listBrowserTasks({ ...profile, node: 'mac' })[0]?.steps.some((s) => s.kind === 'click'));
  const result = o.listBrowserTasks({ ...profile, node: 'mac' })[0];
  assert.ok(result.steps.some((s) => s.kind === 'approval' && s.label.includes('Send report')));
  assert.equal(result.resultText, 'Sent report.'); assert.equal(calls.length, 0);
}
await o.drain();
console.log('PASS');
process.exit(0);
