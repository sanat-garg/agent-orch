// Cluster wire protocol (cluster-protocol.mjs, design in .agent-orch/CLUSTER.md): frame validation, direction, the
// no-secrets rule, batching, backoff and pairing/token helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MSG, DIRECTION, SCHEMA, MAX_BATCH, MAX_FRAME, GRACE_MS, validate, decode, createSender, batchEvents, backoffMs, graceMs,
  secretKeys, newPairingCode, newNodeToken, hashSecret, secretMatches, bearerToken,
} from '../cluster-protocol.mjs';
import { FEATURES, FEATURE_LIST, PHASES } from '../cluster-protocol.mjs';

const SHA = 'a'.repeat(40);
const frame = (t, fields) => ({ t, seq: 1, ts: Date.now(), ...fields });
const start = (over = {}) => frame(MSG.JOB_START, {
  job: 216, title: 'Cluster', prompt: 'Do it', agent: 'claude', model: 'opus', repo: 'https://github.com/sanat-garg/agent-orch.git',
  baseSha: SHA, branch: 'agent-orch/task-216', doneWhen: '`npm test` passes', timeouts: { taskSec: 7200, verifySec: 600 }, ...over,
});

test('every message type has a schema and a direction', () => {
  for (const t of Object.values(MSG)) {
    assert.ok(SCHEMA[t], `schema for ${t}`);
    assert.ok(['c', 'w', 'both'].includes(DIRECTION[t]), `direction for ${t}`);
  }
  assert.deepEqual(Object.keys(SCHEMA).sort(), Object.values(MSG).sort());
});

test('validate accepts well-formed frames', () => {
  assert.equal(validate(start(), { from: 'c' }), null);
  assert.equal(validate(frame(MSG.HELLO, { node: 'n1', protocol: 1, version: '1.0.0', jobs: [{ job: 5, state: 'running', sha: SHA }] }), { from: 'w' }), null);
  assert.equal(validate(frame(MSG.INVENTORY, {
    node: 'n1', name: 'mac', os: 'darwin', arch: 'arm64', cores: 10, mem: 16e9, versions: { agentOrch: '1.0.0', node: '22' },
    agents: [{ id: 'claude', installed: true, version: '2.1', signedIn: true, account: 'me@example.com', models: ['opus'] }, { id: 'codex', installed: false, signedIn: false }],
  }), { from: 'w' }), null);
  assert.equal(validate(frame(MSG.JOB_DONE, { job: 3, outcome: 'ok', text: 'AGENT-ORCH-STATUS: done', usage: { input_tokens: 10, output_tokens: 2 }, sha: SHA }), { from: 'w' }), null);
  assert.equal(validate(frame(MSG.HEARTBEAT, {}), { from: 'c' }), null);
});

test('validate rejects missing and malformed fields', () => {
  assert.match(validate(null), /not an object/);
  assert.match(validate(frame('job.explode', {})), /unknown type/);
  assert.match(validate({ ...start(), seq: 0 }), /seq/);
  assert.match(validate({ ...start(), ts: 'now' }), /ts/);
  assert.match(validate(start({ prompt: undefined })), /missing prompt/);
  assert.match(validate(start({ agent: 'copilot' })), /bad agent/);
  assert.match(validate(start({ baseSha: 'abc' })), /bad baseSha/);
  assert.match(validate(start({ branch: 'main' })), /bad branch/);
  assert.match(validate(frame(MSG.JOB_DONE, { job: 3, outcome: 'great', text: '' })), /bad outcome/);
  assert.match(validate(frame(MSG.JOB_REJECT, { job: 3, reason: 'meh' })), /bad reason/);
  assert.match(validate(frame(MSG.INVENTORY, { node: 'n', name: 'x', os: 'windows', arch: 'x64', cores: 1, mem: 1, agents: [], versions: {} })), /bad os/);
  assert.match(validate(frame(MSG.INVENTORY, { node: 'n', name: 'x', os: 'linux', arch: 'x64', cores: 1, mem: 1, agents: [{ id: 'claude' }], versions: {} })), /each agent/);
  assert.match(validate(frame(MSG.HELLO, { node: 'n', protocol: 1, version: '1', jobs: [{}] })), /job id/);
});

test('only the controller originates jobs; workers only report', () => {
  assert.match(validate(start(), { from: 'w' }), /may not be sent by the worker/);
  assert.match(validate(frame(MSG.JOB_CANCEL, { job: 1 }), { from: 'w' }), /worker/);
  assert.match(validate(frame(MSG.JOB_DONE, { job: 1, outcome: 'ok', text: '' }), { from: 'c' }), /controller/);
  assert.match(validate(frame(MSG.GIT_CREDENTIAL, { host: 'github.com', token: 'x' }), { from: 'w' }), /worker/);
});

test('secrets never travel over the wire except git.credential', () => {
  assert.match(validate(start({ timeouts: { taskSec: 1 }, env: { GITHUB_TOKEN: 'x' } })), /secrets may not travel.*env\.GITHUB_TOKEN/);
  assert.match(validate(start({ repo: 'https://user:pw@github.com/a/b.git' })), /bad repo/);
  assert.match(validate(frame(MSG.INVENTORY, { node: 'n', name: 'x', os: 'linux', arch: 'x64', cores: 1, mem: 1, versions: {},
    agents: [{ id: 'claude', installed: true, signedIn: true, accessToken: 'x' }] })), /agents\.0\.accessToken/);
  assert.equal(validate(frame(MSG.GIT_CREDENTIAL, { host: 'github.com', token: 'ghp_x' }), { from: 'c' }), null);
  assert.deepEqual(secretKeys({ usage: { input_tokens: 1, cache_read_input_tokens: 2 }, password: 'p', a: [{ api_key: 1 }] }), ['password', 'a.0.api_key']);
  // Agent events are the agent's own data and aren't key-scanned.
  assert.equal(validate(frame(MSG.JOB_EVENT, { job: 1, from: 0, events: [{ k: 'tool', name: 'x', input: { token: 't' } }] })), null);
});

test('job.event batches are bounded and carry known kinds', () => {
  const ev = Array.from({ length: MAX_BATCH * 2 + 5 }, (_, i) => ({ k: 'text', text: String(i) }));
  const batches = batchEvents(ev, 10);
  assert.deepEqual(batches.map((b) => [b.from, b.events.length]), [[10, MAX_BATCH], [10 + MAX_BATCH, MAX_BATCH], [10 + 2 * MAX_BATCH, 5]]);
  for (const b of batches) assert.equal(validate(frame(MSG.JOB_EVENT, { job: 1, ...b }), { from: 'w' }), null);
  assert.match(validate(frame(MSG.JOB_EVENT, { job: 1, from: 0, events: [] })), /bad events/);
  assert.match(validate(frame(MSG.JOB_EVENT, { job: 1, from: 0, events: [{ k: 'bogus' }] })), /bad events/);
  assert.match(validate(frame(MSG.JOB_EVENT, { job: 1, from: 0, events: ev })), /bad events/);
});

test('createSender stamps seq/ts and refuses invalid frames; decode round-trips', () => {
  const send = createSender('w');
  const a = JSON.parse(send(MSG.HEARTBEAT));
  const b = send(MSG.JOB_WIP, { job: 7, sha: SHA, branch: 'agent-orch/task-7' });
  assert.equal(a.seq, 1);
  assert.equal(typeof a.ts, 'number');
  assert.throws(() => send(MSG.JOB_START, start()), /may not be sent by the worker/);
  assert.throws(() => send(MSG.JOB_WIP, { job: 7, sha: 'nope', branch: 'agent-orch/task-7' }), /bad sha/);
  const r = decode(b, { from: 'w' });
  assert.equal(r.msg.seq, 2, 'failed sends do not consume a seq');
  assert.equal(r.msg.sha, SHA);
  assert.equal(decode(Buffer.from(b), { from: 'w' }).msg.job, 7);
  assert.match(decode(b, { from: 'c' }).error, /controller/);
  assert.match(decode('{nope').error, /JSON/);
  assert.match(decode(42).error, /text/);
  assert.match(decode('x'.repeat(MAX_FRAME + 1)).error, /exceeds/);
  assert.throws(() => send(MSG.JOB_CHECK, { job: 1, command: 'npm test', output: 'x'.repeat(MAX_FRAME), pass: false }), /exceeds/);
});

test('backoff doubles to a 60 s cap with bounded jitter; grace depends on the OS', () => {
  assert.equal(backoffMs(0, () => 0.5), 1000);
  assert.equal(backoffMs(3, () => 0.5), 8000);
  assert.equal(backoffMs(20, () => 0.5), 60_000);
  assert.equal(backoffMs(20, () => 0), 48_000);
  assert.equal(backoffMs(20, () => 1), 72_000);
  assert.equal(graceMs('darwin'), GRACE_MS.mac);
  assert.equal(graceMs('linux'), GRACE_MS.vps);
  assert.equal(GRACE_MS.mac, 300_000);
  assert.equal(GRACE_MS.vps, 120_000);
});

test('pairing codes, node tokens and hashes', () => {
  const code = newPairingCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.notEqual(newPairingCode(), code);
  const tok = newNodeToken();
  assert.match(tok, /^aon_[\w-]{43}$/);
  const h = hashSecret(tok);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(!h.includes(tok));
  assert.ok(secretMatches(tok, h));
  assert.ok(!secretMatches(tok + 'x', h));
  assert.ok(!secretMatches(tok, 'short'));
  assert.ok(!secretMatches(null, h));
  assert.equal(bearerToken({ authorization: `Bearer ${tok}` }), tok);
  assert.equal(bearerToken({ authorization: 'Basic abc' }), null);
  assert.equal(bearerToken({}), null);
});

test('worker reports: job.phase, job.error, node.error, logs, node.update, and telemetry on resources', () => {
  assert.equal(validate(frame(MSG.JOB_PHASE, { job: 1, phase: 'running', at: Date.now(), ms: 20, progress: { tools: 3, files: 1, last: 'Bash · npm test' } }), { from: 'w' }), null);
  assert.equal(validate(frame(MSG.JOB_PHASE, { job: 1, phase: 'done', at: 1, ms: 5, outcome: 'setup_failed' }), { from: 'w' }), null);
  assert.match(validate(frame(MSG.JOB_PHASE, { job: 1, phase: 'napping', at: 1 })), /bad phase/);
  assert.match(validate(frame(MSG.JOB_PHASE, { job: 1, phase: 'queued', at: 1 }), { from: 'c' }), /controller/);
  assert.deepEqual(PHASES, ['queued', 'cloning', 'fetching', 'installing', 'running', 'checking', 'committing', 'pushing', 'done']);
  assert.equal(validate(frame(MSG.JOB_ERROR, { job: 1, kind: 'install_failed', message: 'npm ci failed', stderr: 'npm ERR! 404', at: 5 }), { from: 'w' }), null);
  assert.match(validate(frame(MSG.JOB_ERROR, { job: 1, kind: 'agent_crash' })), /missing message/);
  assert.equal(validate(frame(MSG.NODE_ERROR, { kind: 'exception', message: 'boom', stack: 'Error: boom\n    at x' }), { from: 'w' }), null);
  assert.equal(validate(frame(MSG.NODE_ERROR, { kind: 'update', message: 'busy: 1 job on this machine', re: 7 }), { from: 'w' }), null);
  assert.equal(validate(frame(MSG.LOGS_TAIL, { req: 'a1', lines: 200 }), { from: 'c' }), null);
  assert.match(validate(frame(MSG.LOGS_TAIL, { req: 'a1', lines: 200 }), { from: 'w' }), /worker/);
  assert.equal(validate(frame(MSG.LOGS, { req: 'a1', lines: ['2026-09-27T10:00:00Z info hi'] }), { from: 'w' }), null);
  assert.equal(validate(frame(MSG.NODE_UPDATE, { sha: SHA }), { from: 'c' }), null);
  assert.equal(validate(frame(MSG.NODE_UPDATE, {}), { from: 'c' }), null);
  assert.match(validate(frame(MSG.NODE_UPDATE, { sha: 'main' })), /bad sha/);
  assert.match(validate(frame(MSG.NODE_UPDATE, {}), { from: 'w' }), /worker/);
  // Telemetry rides the resources frame: additive fields an older controller simply ignores.
  const tele = { memAvailable: 1, load: [0, 0, 0], running: [], cpu: [1, 2], memTotal: 8, swapTotal: 0, swapUsed: 0, disk: { path: '/x', free: 1, total: 2 },
    net: { host: 'github.com', ok: true, ms: 3, at: 1 }, agents: [{ id: 'codex', installed: true, version: '1', signedIn: true }], uptime: 1, procUptime: 1,
    version: '1.0.0', sha: SHA, battery: { pct: 50, charging: false, source: 'battery' }, thermal: { pressure: 'nominal', speedLimit: 100, warning: null } };
  assert.equal(validate(frame(MSG.RESOURCES, tele), { from: 'w' }), null);
  assert.match(validate(frame(MSG.RESOURCES, { ...tele, sha: 'abc' })), /bad sha/);
  assert.match(validate(frame(MSG.RESOURCES, { ...tele, disk: 5 })), /bad disk/);
  // hello and welcome name their features; each newer type is sent only to a peer that lists its feature.
  assert.equal(validate(frame(MSG.HELLO, { node: 'n', protocol: 1, version: '1', jobs: [], sha: SHA, features: FEATURE_LIST }), { from: 'w' }), null);
  assert.equal(validate(frame(MSG.WELCOME, { node: 'n', protocol: 1, heartbeatMs: 1, wipPushMs: 1, graceMs: 1, features: FEATURE_LIST }), { from: 'c' }), null);
  assert.deepEqual(FEATURE_LIST, ['phases', 'errors', 'logs', 'update', 'policy', 'creds', 'screen', 'cap']);
  for (const [t, f] of Object.entries(FEATURES)) assert.ok(SCHEMA[t] && FEATURE_LIST.includes(f), t);
});
