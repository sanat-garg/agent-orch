// Controller side of the cluster (BRIEF goal 11, design: .agent-orch/CLUSTER.md, wire format: cluster-protocol.mjs).
// Node registry in the orchestrator DB, pairing codes (one-time or multi-use), each node's power policy (power.mjs), and
// the worker WebSocket hub at WS_PATH, and the extension bundle at EXT_PATH. The scheduler uses listNodes() /
// send(nodeId, msg) / onMessage(handler) / version() / extHash(), and feeds setBusy() (the update's idle check) and
// setUpNext() (each worker's "up next" count, sent with welcome and every heartbeat); the UI reads listNodes() via
// GET /api/cluster/nodes.
// Health (CLUSTER.md, Health): each worker's telemetry as a 24 h series (node-metrics.mjs), its log tail on demand,
// its last error, auto-drain, and the version check that updates an outdated worker once it is idle.
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import {
  PROTOCOL_VERSION, HEARTBEAT_MS, HEARTBEAT_MISSES, WIP_PUSH_MS, MAX_FRAME, PAIRING_TTL_MS, PAIRING_MULTI_TTL_MS, MAX_PAIRING_USES, OS_KINDS, MSG,
  FEATURE_LIST, WORKER_ACCEPTS, graceMs, newPairingCode, normalizePairingCode, newNodeToken, hashSecret, secretMatches, bearerToken, createSender, decode,
} from './cluster-protocol.mjs';
import { createNodeMetrics, RANGES } from './node-metrics.mjs';
import { checkPolicy, effectivePolicy } from './power.mjs';

export const LOCAL_NODE = 'controller';
const MAX_ERRORS = 5; // invalid frames per connection before the worker is disconnected
// Auto-health: a worker is drained, and the owner told, when the disk holding its repos has under 2 GB free, when it lost
// its connection 3 times in 30 min (missed heartbeats or a dropped socket, not a Mac's sleep), or when 3 different tasks
// failed there in 30 min that no other machine failed (orchestrator.mjs checkNodeFailures). Evidence from before the
// owner last undrained it doesn't count, and low disk doesn't drain it again within the hour after that. A low-disk drain
// lifts itself once 3 frames in a row report at least diskMinBytes + diskRecoverBytes (3 GB) free (it sets health_ack like
// the owner's undrain, with an info notice); an owner drain or any other automatic drain waits for the owner.
export const HEALTH = { diskMinBytes: 2 * 1024 ** 3, diskRecoverBytes: 1024 ** 3, recoverFrames: 3, drops: 3, failures: 3, windowMs: 30 * 60_000, ackQuietMs: 3600e3 };
// A worker whose agent-orch checkout is more commits behind the controller's origin/main than this is outdated; the
// controller then gives it no new work (status 'updating'), sends node.update once it is idle, and it comes back updated
// (bye, service restart, hello with the new sha).
export const OUTDATED_AFTER = 20;
const UPDATE_WAIT_MS = 10 * 60_000; // node.update sent and no hello with a new sha by then: the update failed
// Compute-only workers (BRIEF goal 11): nothing off the worker's allow-list (a chat, a prompt, a setting) is ever sent to
// one; a caller that tries is a bug, so it throws like any other invalid frame.
const forWorker = (t) => { if (!WORKER_ACCEPTS.includes(t)) throw new Error(`${t} is not for a worker: workers are compute-only`); };
const clip = (v, n) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n)}…` : v);
const gb = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const execFileP = promisify(execFile);

// How far a worker's sha lags the controller's origin/main (repoDir: the controller's agent-orch checkout), in commits;
// null while unknown (no sha, a sha this repo doesn't have, or the count still running). Both git reads are async and
// cached: origin/main is re-read at most every mainTtlMs, a count once per (sha, main) pair. onChange: a count landed.
export function createVersionCheck({ repoDir, mainTtlMs = 5 * 60_000, onChange = () => {} }) {
  let main = null, mainAt = 0, reading = false;
  const counts = new Map();
  const git = (args) => execFileP('git', args, { cwd: repoDir, encoding: 'utf8', timeout: 20_000 }).then((r) => r.stdout.trim());
  function refresh() {
    if (reading || Date.now() - mainAt < mainTtlMs) return;
    reading = true;
    git(['rev-parse', '--verify', '-q', 'origin/main^{commit}']).then((s) => { if (s !== main) { main = s; onChange(); } }, () => {})
      .finally(() => { reading = false; mainAt = Date.now(); });
  }
  function behind(sha) {
    refresh();
    if (!sha || !main) return null;
    if (sha === main) return 0;
    const key = `${sha}..${main}`;
    if (!counts.has(key)) {
      counts.set(key, null);
      git(['rev-list', '--count', key]).then((n) => { counts.set(key, Number(n)); onChange(); }, () => {});
    }
    return counts.get(key);
  }
  return { behind, main: () => (refresh(), main) };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, os TEXT, arch TEXT, token_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL, last_seen INTEGER, status TEXT NOT NULL DEFAULT 'offline',
  inventory TEXT, resources TEXT, max_slots INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
  draining INTEGER NOT NULL DEFAULT 0
)`;
// Pairing codes, as hashes: uses = how many machines may pair with it (1 = one-time), nodes = the ids that did (JSON),
// revoked_at = the owner ended it early. Kept a day past expiry so the wizard can still show who paired.
const PAIRINGS = `
CREATE TABLE IF NOT EXISTS pairings (
  code_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 1,
  nodes TEXT NOT NULL DEFAULT '[]', revoked_at INTEGER
)`;
// Added later: grace_ms (the owner's per-node grace before its jobs are reassigned; NULL = graceMs(os)); away (why a
// node is offline: 'bye' after a clean shutdown, 'asleep' when a Mac went silent, 'lost' otherwise); slept_at/slept_ms
// (the last sleep a worker reported on wake). max_slots 0 = Auto (the scheduler sizes it from cores and free RAM).
// drain_reason/drained_at: why and when auto-health drained it (NULL when the owner did); drain_kind: which rule did
// ('disk' | 'drops'; NULL for the owner and for task failures), so only a disk drain lifts itself; health_ack: when the owner last
// undrained it (older evidence no longer counts); last_error: JSON of its last node.error {at, kind, message, stack, stderr}.
// policy: JSON of the owner's power-policy settings (power.mjs; NULL = the defaults for its OS).
const COLUMNS = [['grace_ms', 'INTEGER'], ['away', 'TEXT'], ['slept_at', 'INTEGER'], ['slept_ms', 'INTEGER'],
  ['drain_reason', 'TEXT'], ['drained_at', 'INTEGER'], ['health_ack', 'INTEGER'], ['last_error', 'TEXT'], ['policy', 'TEXT'], ['drain_kind', 'TEXT']];

const statusOf = (row, connected) => (!row.enabled ? 'disabled' : !connected ? 'offline' : row.draining ? 'draining' : 'online');
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64) : '');

// dbFile: the orchestrator DB. local(): {inventory, resources, maxSlots?} for the controller's own node row.
// heartbeatMs: liveness interval (tests shorten it); a node is offline after HEARTBEAT_MISSES silent intervals.
// wipPushMs: how often workers push WIP while an agent runs; graceMs: every node's grace period (tests shorten both).
// metricsDir: where the per-node telemetry series live (<DATA>/metrics/nodes; null = not kept). repoDir: the controller's
// agent-orch checkout for the version check (null = off); outdatedAfter: see OUTDATED_AFTER; autoUpdate: update outdated
// workers on its own. onNotice({node, level, text}): something the owner should hear about (an auto-drain, an update).
// health: HEALTH overrides (tests); logsTimeoutMs: how long a log tail may take. ext: extensions.mjs (syncInfo/syncBundle):
// workers get its bundle (ext.sync, EXT_PATH); null = none is offered.
export function createCluster({ dbFile, local = () => ({}), heartbeatMs = HEARTBEAT_MS, wipPushMs = WIP_PUSH_MS, graceMs: graceAll = null, log = () => {}, onChange = () => {},
  metricsDir = null, repoDir = null, outdatedAfter = OUTDATED_AFTER, autoUpdate = true, mainTtlMs, onNotice = () => {}, health: healthOpts = {}, logsTimeoutMs = 15_000, ext = null }) {
  const health = { ...HEALTH, ...healthOpts };
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(SCHEMA);
  db.exec(PAIRINGS);
  const cols = db.prepare('PRAGMA table_info(nodes)').all().map((c) => c.name);
  for (const [c, type] of COLUMNS) if (!cols.includes(c)) db.exec(`ALTER TABLE nodes ADD COLUMN ${c} ${type}`);
  const conns = new Map(); // node id -> { ws, send, lastFrame, hello, errors, connectedAt }
  const handlers = new Set();
  const get = (id) => db.prepare('SELECT * FROM nodes WHERE id=?').get(id);
  const metrics = metricsDir ? createNodeMetrics({ dir: metricsDir, log }) : null;
  const drops = new Map(); // node id -> when (ms) it lost its connection without a bye, last HEALTH.windowMs
  const recovered = new Map(); // node id -> resources frames in a row with the disk back above the low-disk drain's mark
  const updates = new Map(); // node id -> { state: 'pending' | 'sent' | 'failed', target, from, by, at, error }
  const failedFor = new Map(); // node id -> the origin/main sha an automatic update failed for (not retried on its own)
  const requests = new Map(); // request id -> { node, done(frame) } (log tails)
  let busy = () => false; // setBusy: the scheduler's view (jobs placed or offered there) for the update's idle check
  // setUpNext: how many queued tasks the scheduler could give a worker next; it rides welcome and every heartbeat, for
  // the worker's status view (`node worker.mjs status`). null = unknown.
  let upNext = () => null;
  const queuedFor = (id) => {
    try { const n = upNext(id); return Number.isSafeInteger(n) && n >= 0 ? { queued: n } : {}; } catch (e) { log(`up next for ${id} failed: ${e.message}`); return {}; }
  };
  const notice = (n) => { try { onNotice(n); } catch (e) { log(`onNotice failed: ${e.message}`); } };

  // The controller is a node too; it never connects, so it is online while this process runs.
  const now = Date.now();
  if (!get(LOCAL_NODE)) {
    db.prepare('INSERT INTO nodes (id, name, os, arch, created_at, max_slots) VALUES (?, ?, ?, ?, ?, 1)')
      .run(LOCAL_NODE, os.hostname() || 'controller', process.platform, process.arch, now);
  }
  db.prepare('UPDATE nodes SET os=?, arch=? WHERE id=?').run(process.platform, process.arch, LOCAL_NODE);
  // Nobody is connected at boot.
  for (const row of db.prepare('SELECT * FROM nodes').all()) setStatus(row, row.id === LOCAL_NODE);

  function setStatus(row, connected) {
    const status = statusOf(row, connected);
    if (status !== row.status) db.prepare('UPDATE nodes SET status=? WHERE id=?').run(status, row.id);
    return status;
  }
  // kind 'resources': only a worker's periodic CPU/RAM reading changed (the Machines view refreshes; nothing else needs to).
  // version (read via version()) counts every change, so the scheduler's cached listNodes() is re-read right after one.
  let version = 0;
  const changed = (kind) => { version++; try { onChange(kind); } catch (e) { log(`onChange failed: ${e.message}`); } };
  // A version count that lands may make a worker outdated: mark it for its update right away.
  const versions = repoDir ? createVersionCheck({ repoDir, ...(mainTtlMs != null ? { mainTtlMs } : {}), onChange: () => { changed(); for (const id of conns.keys()) checkUpdate(id); } }) : null;

  let localAt = 0;
  function refreshLocal() {
    let info = {};
    try { info = local() || {}; } catch (e) { log(`local node info failed: ${e.message}`); }
    db.prepare('UPDATE nodes SET last_seen=?, inventory=COALESCE(?, inventory), resources=COALESCE(?, resources) WHERE id=?')
      .run(Date.now(), info.inventory ? JSON.stringify(info.inventory) : null, info.resources ? JSON.stringify(info.resources) : null, LOCAL_NODE);
    // The controller's own series, at the workers' pace.
    if (metrics && info.resources && Date.now() - localAt >= heartbeatMs) { localAt = Date.now(); metrics.record(LOCAL_NODE, info.resources); }
  }

  // A node that went away: why (row.away), and the owner-facing words for it ('Mac asleep').
  const awayLabel = (row) => (row.away === 'asleep' ? 'Mac asleep' : row.away === 'bye' ? 'shut down' : 'offline');
  const nodeGrace = (row) => graceAll ?? row.grace_ms ?? graceMs(row.os);

  // The node's power policy and task cap as its worker enforces them (welcome.policy, node.policy; power.mjs).
  const wirePolicy = (row) => ({ ...effectivePolicy(row.os, parse(row.policy)), maxTasks: row.max_slots || null });

  // Public view: never the token hash. status 'updating': an update is pending (waiting for it to be idle) or sent;
  // 'paused': online, but its power policy holds new jobs back for now (on battery, running hot: the intake its worker
  // reported on this connection), so the scheduler places nothing there meanwhile.
  function view(row) {
    const c = conns.get(row.id), isLocal = row.id === LOCAL_NODE, connected = isLocal || !!c, resources = parse(row.resources);
    const sha = c?.hello?.sha ?? resources?.sha ?? null, behind = !isLocal && versions ? versions.behind(sha) : null, u = updates.get(row.id);
    const updating = connected && row.enabled && !row.draining && (u?.state === 'pending' || u?.state === 'sent');
    const paused = !!c && row.enabled && !row.draining && resources?.intake?.ok === false && resources.at >= c.connectedAt;
    return {
      id: row.id, name: row.name, os: row.os, arch: row.arch, local: isLocal, connected,
      status: updating ? 'updating' : paused ? 'paused' : row.status, createdAt: row.created_at, lastSeen: row.last_seen,
      away: connected ? null : row.away || 'lost', awayLabel: connected ? null : awayLabel(row),
      graceMs: nodeGrace(row), sleptAt: row.slept_at ?? null, sleptMs: row.slept_ms ?? null,
      enabled: !!row.enabled, draining: !!row.draining, maxSlots: row.max_slots || null, // null = Auto
      drainReason: row.draining ? row.drain_reason ?? null : null, drainedAt: row.draining ? row.drained_at ?? null : null, healthAck: row.health_ack ?? null,
      lastError: parse(row.last_error),
      inventory: parse(row.inventory), resources,
      protocol: c?.hello?.protocol ?? null, version: c?.hello?.version ?? null, features: c?.hello?.features ?? null,
      sha, behind, outdated: behind != null && behind > outdatedAfter,
      update: u ? { state: u.state, by: u.by, at: u.at, target: u.target ?? null, error: u.error ?? null } : null,
      policy: isLocal ? null : effectivePolicy(row.os, parse(row.policy)),
    };
  }
  function listNodes() {
    refreshLocal();
    return db.prepare('SELECT * FROM nodes ORDER BY id=? DESC, created_at').all(LOCAL_NODE).map(view);
  }
  const node = (id) => { const r = get(id); return r ? view(r) : null; };

  // ---- pairing
  // uses 1: a one-time code, valid PAIRING_TTL_MS (10 min). uses 2..MAX_PAIRING_USES: one code for that many machines
  // ("Pair 4 Macs in one go"), valid PAIRING_MULTI_TTL_MS (1 h). Stored hashed, so they survive a controller restart.
  function createPairing({ uses = 1 } = {}) {
    const n = uses ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAIRING_USES) return { status: 400, error: `uses must be an integer 1-${MAX_PAIRING_USES}` };
    const t = Date.now();
    db.prepare('DELETE FROM pairings WHERE expires_at < ?').run(t - 86400e3);
    const code = newPairingCode(), expiresAt = t + (n > 1 ? PAIRING_MULTI_TTL_MS : PAIRING_TTL_MS);
    db.prepare('INSERT INTO pairings (code_hash, created_at, expires_at, uses) VALUES (?, ?, ?, ?)').run(hashSecret(code), t, expiresAt, n);
    return { code, expiresAt, ...(n > 1 ? { uses: n, used: 0, nodes: [] } : {}) };
  }
  const pairRow = (code) => { const c = normalizePairingCode(code); return c ? db.prepare('SELECT * FROM pairings WHERE code_hash=?').get(hashSecret(c)) : null; };
  // The "Add machine" wizard's view of its code: waiting → paired once every use is taken (node.connected once it dials
  // in), else expired or revoked. A multi-use code also counts its uses and lists the machines that paired, oldest first.
  function pairing(code) {
    const e = pairRow(code);
    if (!e) return { state: 'unknown' };
    const ids = parse(e.nodes) || [], nodes = ids.map(node).filter(Boolean);
    const state = ids.length >= e.uses ? 'paired' : e.revoked_at ? 'revoked' : e.expires_at < Date.now() ? 'expired' : 'waiting';
    return { state, expiresAt: e.expires_at, ...(e.uses > 1 ? { uses: e.uses, used: ids.length, nodes } : nodes[0] ? { node: nodes[0] } : {}) };
  }
  // The owner ends a code early ("Revoke code"): no more machines can pair with it; the ones that did stay.
  function revokePairing(code) {
    const e = pairRow(code);
    if (!e) return { status: 404, error: 'no such pairing code' };
    if (!e.revoked_at) db.prepare('UPDATE pairings SET revoked_at=? WHERE code_hash=?').run(Date.now(), e.code_hash);
    log('a pairing code was revoked');
    return pairing(code);
  }
  // A new machine's name, unique among the nodes ('MacBook Pro (Sanat-MBP)', then '… 2'), so the list stays unambiguous.
  function uniqueName(label) {
    const taken = new Set(db.prepare('SELECT name FROM nodes').all().map((r) => r.name.toLowerCase()));
    let name = label;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${label.slice(0, 60)} ${i}`;
    return name;
  }
  // Worker side of pairing: a code with a use left, unexpired and not revoked → a new node and its token (returned only
  // here, stored hashed). Each machine gets its own node and token, whichever code it used.
  function claim({ code, name, os: kind, arch } = {}) {
    const e = pairRow(code), ids = (e && parse(e.nodes)) || [];
    const why = !e ? 'invalid or expired pairing code' : ids.length >= e.uses ? `this pairing code was already used${e.uses > 1 ? ` by ${e.uses} machines` : ''}`
      : e.revoked_at ? 'this pairing code was revoked' : e.expires_at < Date.now() ? 'this pairing code expired' : null;
    if (why) return { status: 401, error: e ? `${why}: make a new one with "Add machine"` : why };
    if (!OS_KINDS.includes(kind)) return { status: 400, error: `os must be one of ${OS_KINDS.join(', ')}` };
    if (typeof arch !== 'string' || !/^[\w.-]{1,20}$/.test(arch)) return { status: 400, error: 'arch required' };
    const label = cleanName(name);
    if (!label) return { status: 400, error: 'name required' };
    const id = `n_${crypto.randomBytes(6).toString('hex')}`, token = newNodeToken(), unique = uniqueName(label);
    db.prepare('UPDATE pairings SET nodes=? WHERE code_hash=?').run(JSON.stringify([...ids, id]), e.code_hash);
    // A new Linux node starts at 1 task; a Mac on Auto, which its policy keeps to cores − 1 and 3 GB free for its owner.
    db.prepare('INSERT INTO nodes (id, name, os, arch, token_hash, created_at, status, max_slots) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, unique, kind, arch, hashSecret(token), Date.now(), 'offline', kind === 'darwin' ? 0 : 1);
    log(`paired node ${id} (${unique}, ${kind}/${arch})${e.uses > 1 ? `: use ${ids.length + 1} of ${e.uses}` : ''}`);
    changed();
    return { node: id, name: unique, token };
  }

  // ---- owner edits
  function update(id, body = {}) {
    const row = get(id);
    if (!row) return { status: 404, error: 'no such node' };
    const set = {};
    if (body.name !== undefined) { const n = cleanName(body.name); if (!n) return { status: 400, error: 'name required' }; set.name = n; }
    for (const k of ['enabled', 'draining']) {
      if (body[k] === undefined) continue;
      if (typeof body[k] !== 'boolean') return { status: 400, error: `${k} must be true or false` };
      if (id === LOCAL_NODE && k === 'enabled' && !body[k]) return { status: 400, error: 'the controller node cannot be disabled' };
      set[k] = body[k] ? 1 : 0;
    }
    // The owner drains or undrains by hand: no automatic reason; undraining sets aside the evidence so far.
    if (set.draining !== undefined) Object.assign(set, { drain_reason: null, drain_kind: null, drained_at: set.draining ? Date.now() : null, ...(set.draining ? {} : { health_ack: Date.now() }) });
    const grace = body.graceSec ?? body.grace_sec;
    if (grace !== undefined) {
      if (grace !== null && !(Number.isInteger(grace) && grace >= 10 && grace <= 86400)) return { status: 400, error: 'graceSec must be null or an integer 10-86400' };
      set.grace_ms = grace === null ? null : grace * 1000;
    }
    const slots = 'maxSlots' in body ? body.maxSlots : body.max_slots; // null = Auto
    if (slots !== undefined) {
      if (slots !== null && !(Number.isInteger(slots) && slots >= 1 && slots <= 16)) return { status: 400, error: 'maxSlots must be null (Auto) or an integer 1-16' };
      set.max_slots = slots ?? 0;
    }
    // Power policy (power.mjs): the keys given replace those settings; null goes back to the defaults for its OS.
    if (body.policy !== undefined) {
      if (id === LOCAL_NODE) return { status: 400, error: 'the controller keeps to its own memory guard; it has no power policy' };
      const r = body.policy === null ? { value: null } : checkPolicy(body.policy);
      if (r.error) return { status: 400, error: r.error };
      set.policy = r.value ? JSON.stringify({ ...parse(row.policy), ...r.value }) : null;
    }
    const keys = Object.keys(set);
    if (keys.length) db.prepare(`UPDATE nodes SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`).run(...keys.map((k) => set[k]), id);
    setStatus(get(id), id === LOCAL_NODE || conns.has(id));
    // Its worker enforces the policy and the task cap too: tell it now (one that predates node.policy reads it at its next welcome).
    if ((set.policy !== undefined || set.max_slots !== undefined) && conns.get(id)?.hello?.features?.includes('policy')) {
      send(id, { t: MSG.NODE_POLICY, policy: wirePolicy(get(id)) });
    }
    changed();
    return { node: node(id) };
  }
  function revoke(id) {
    if (id === LOCAL_NODE) return { status: 400, error: 'the controller node cannot be removed' };
    if (!get(id)) return { status: 404, error: 'no such node' };
    db.prepare('DELETE FROM nodes WHERE id=?').run(id);
    const c = conns.get(id);
    if (c) { conns.delete(id); c.ws.close(4003, 'revoked'); }
    metrics?.remove(id);
    for (const m of [drops, recovered, updates, failedFor]) m.delete(id);
    log(`revoked node ${id}`);
    changed();
    return { ok: true };
  }

  // ---- WebSocket hub
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const deny = (socket, code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  // The node row a request's bearer token belongs to (never the session cookie), or null.
  function tokenNode(headers) {
    const token = bearerToken(headers);
    const row = token && db.prepare('SELECT * FROM nodes WHERE token_hash=?').get(hashSecret(token));
    return row && secretMatches(token, row.token_hash) ? row : null;
  }
  // WHOAMI_PATH: which machine a bearer token belongs to, without connecting (a check must not bump the live worker).
  function whoami(headers) {
    const row = tokenNode(headers);
    if (!row) return { status: 401, error: 'this machine is not paired with this head' };
    return { node: row.id, name: row.name };
  }
  // Unknown or revoked tokens are refused before any frame is read.
  function handleUpgrade(req, socket, head) {
    const row = tokenNode(req.headers);
    if (!row) return deny(socket, 401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, row.id));
  }

  // ---- extension bundle: skills, subagents and MCP servers (with their secrets) for paired, enabled nodes only.
  // Workers hear the hash (ext.sync after welcome and on every change, job.start.ext) and GET EXT_PATH when theirs differs.
  // An older worker (no feature 'ext') gets no ext.sync and ignores job.start.ext.
  const extInfo = () => { try { return ext?.syncInfo() || null; } catch (e) { log(`extension bundle failed: ${e.message}`); return null; } };
  function sendExt(c) {
    if (!c.hello?.features?.includes('ext')) return;
    const i = extInfo();
    try { if (i) c.send(MSG.EXT_SYNC, { hash: i.hash, bytes: i.bytes }); } catch (e) { log(`ext.sync failed: ${e.message}`); }
  }
  function syncExt() { for (const c of conns.values()) if (c.hello) sendExt(c); }
  const gzip = promisify(zlib.gzip);
  async function handleExt(req, res) {
    const reply = (status, body = '', headers = {}) => { res.writeHead(status, { 'Cache-Control': 'no-store', ...headers }); res.end(body); };
    const row = tokenNode(req.headers);
    if (!row) return reply(401);
    if (!row.enabled) return reply(403);
    if (!ext) return reply(404);
    let b;
    try { b = ext.syncBundle(); } catch (e) { log(`extension bundle failed: ${e.message}`); return reply(500); }
    const body = await gzip(JSON.stringify(b));
    // Names and counts only: the bundle holds MCP secrets.
    log(`node ${row.id} fetched extensions ${b.hash.slice(0, 12)}: ${b.skills.length} skills, ${b.agents.length} subagents, ${b.mcp.length} MCP servers (${Math.ceil(body.length / 1024)} KB)`);
    reply(200, body, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
  }

  function attach(ws, id) {
    const old = conns.get(id);
    if (old) { conns.delete(id); old.ws.close(4000, 'replaced by a new connection'); }
    const sender = createSender('c');
    const c = { ws, lastFrame: Date.now(), hello: null, errors: 0, connectedAt: Date.now() };
    c.send = (t, fields) => { forWorker(t); if (ws.readyState === 1) ws.send(sender(t, fields)); };
    conns.set(id, c);
    const own = () => conns.get(id) === c;
    const touch = (extra = {}) => {
      const cols = { last_seen: Date.now(), ...extra }, keys = Object.keys(cols);
      db.prepare(`UPDATE nodes SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`).run(...keys.map((k) => cols[k]), id);
    };
    const fail = (message, re) => {
      try { c.send(MSG.ERROR, re ? { message, re } : { message }); } catch {}
      if (++c.errors >= MAX_ERRORS) { c.closing = true; ws.close(1008, 'too many invalid frames'); }
    };
    touch();
    log(`node ${id} connected`);

    ws.on('message', (raw, isBinary) => {
      if (!own()) return;
      c.lastFrame = Date.now();
      if (!get(id)) return ws.close(4003, 'revoked');
      const { msg, error } = decode(isBinary ? null : raw.toString('utf8'), { from: 'w' });
      if (error) return fail(error);
      if (!c.hello && msg.t !== MSG.HELLO) return fail('send hello first', msg.seq);
      switch (msg.t) {
        case MSG.HELLO: {
          if (msg.node !== id) { fail('hello.node does not match this token', msg.seq); c.closing = true; return ws.close(1008, 'wrong node'); }
          if (msg.protocol !== PROTOCOL_VERSION) {
            fail(`protocol ${msg.protocol} is not supported (controller speaks ${PROTOCOL_VERSION}): update the worker`, msg.seq);
            c.send(MSG.BYE, { reason: 'version' });
            c.closing = true;
            return ws.close(1008, 'protocol version');
          }
          c.hello = { protocol: msg.protocol, version: msg.version, jobs: msg.jobs, sha: msg.sha || null, features: Array.isArray(msg.features) ? msg.features : [] };
          const row = get(id);
          touch();
          setStatus(row, true);
          touch({ away: null });
          c.send(MSG.WELCOME, { node: id, protocol: PROTOCOL_VERSION, heartbeatMs, wipPushMs, graceMs: nodeGrace(row), features: FEATURE_LIST, policy: wirePolicy(row), ...queuedFor(id) });
          helloUpdate(id, row, c.hello.sha);
          sendExt(c);
          changed();
          break;
        }
        case MSG.INVENTORY: {
          const { t, seq, ts, ...inv } = msg;
          touch({ inventory: JSON.stringify(inv), ...(OS_KINDS.includes(inv.os) ? { os: inv.os } : {}), arch: inv.arch.slice(0, 20) });
          changed();
          break;
        }
        case MSG.RESOURCES: {
          const { t, seq, ts, ...res } = msg;
          touch({ resources: JSON.stringify({ ...res, at: Date.now() }) });
          metrics?.record(id, res);
          changed('resources');
          checkHealth(id, c, res);
          checkUpdate(id);
          break;
        }
        case MSG.BYE: c.bye = true; touch(); ws.close(1000, 'bye'); break;
        case MSG.WAKE: {
          touch({ slept_at: Math.round(msg.sleptAt), slept_ms: msg.sleptMs });
          // The connection this sleep cost isn't a failing heartbeat (a few minutes' slack for clock skew).
          const slack = 5 * 60_000;
          drops.set(id, (drops.get(id) || []).filter((x) => x < msg.sleptAt - slack || x > msg.sleptAt + msg.sleptMs + slack));
          log(`node ${id} woke after ${Math.round(msg.sleptMs / 60_000)} min asleep`);
          changed();
          break;
        }
        case MSG.NODE_ERROR: {
          const e = { at: Date.now(), kind: clip(msg.kind, 40), message: clip(msg.message, 500),
            ...(msg.stack ? { stack: clip(msg.stack, 4000) } : {}), ...(msg.stderr ? { stderr: clip(msg.stderr, 4000) } : {}) };
          touch({ last_error: JSON.stringify(e) });
          log(`node ${id} error (${e.kind}): ${e.message}`);
          if (e.kind === 'update') updateFailed(id, e.message);
          changed();
          break;
        }
        case MSG.LOGS: case MSG.SCREEN_RES: {
          const r = requests.get(msg.req);
          if (r?.node === id) r.done(msg);
          touch();
          break;
        }
        default: touch();
      }
      for (const h of handlers) { try { h(id, msg); } catch (e) { log(`cluster handler failed: ${e.message}`); } }
    });
    ws.on('close', () => {
      if (!own()) return;
      conns.delete(id);
      gone(id, c.bye);
      if (!c.bye && !c.closing) dropped(id);
      log(`node ${id} disconnected`);
      changed();
    });
    ws.on('error', () => {});
  }

  // A node dropped: offline, and why. A Mac that goes silent without a bye is (almost always) asleep.
  function gone(id, bye) {
    const row = get(id);
    if (!row) return;
    db.prepare('UPDATE nodes SET away=? WHERE id=?').run(bye ? 'bye' : row.os === 'darwin' ? 'asleep' : 'lost', id);
    setStatus(row, false);
  }

  // Liveness: ping every interval (keeps Caddy's proxy connection open); no frame for HEARTBEAT_MISSES intervals → offline.
  const sweep = setInterval(() => {
    const t = Date.now();
    for (const [id, c] of conns) {
      if (t - c.lastFrame > heartbeatMs * HEARTBEAT_MISSES) {
        conns.delete(id);
        gone(id, false);
        dropped(id);
        log(`node ${id} missed ${HEARTBEAT_MISSES} heartbeats; marked offline`);
        c.ws.terminate();
        changed();
      } else if (c.ws.readyState === 1) {
        try { c.send(MSG.HEARTBEAT, c.hello ? queuedFor(id) : {}); c.ws.ping(); } catch {}
        checkUpdate(id);
      }
    }
    for (const [id, u] of updates) if (u.state === 'sent' && t - u.at > UPDATE_WAIT_MS) updateFailed(id, 'it did not come back updated');
  }, heartbeatMs);
  sweep.unref?.();

  // ---- auto-health (HEALTH)
  function dropped(id) {
    const t = Date.now();
    drops.set(id, [...(drops.get(id) || []).filter((x) => x > t - health.windowMs), t]);
  }
  // Drains a worker on its own, with a notice for the owner. False when it is already draining (or disabled). kind: the
  // rule ('disk' lifts itself once the disk recovers; anything else waits for the owner).
  function autoDrain(id, reason, kind = null) {
    const row = get(id);
    if (!row || id === LOCAL_NODE || row.draining || !row.enabled) return false;
    db.prepare('UPDATE nodes SET draining=1, drain_reason=?, drain_kind=?, drained_at=? WHERE id=?').run(reason, kind, Date.now(), id);
    recovered.delete(id);
    setStatus(get(id), conns.has(id));
    log(`node ${id} drained automatically: ${reason}`);
    notice({ node: id, level: 'warn', text: `${row.name} was drained automatically: ${reason}. It finishes what it runs and takes no new tasks until you undrain it (Server details → Machines).` });
    changed();
    return true;
  }
  // Each telemetry frame: low disk now, or too many lost connections lately. A wake report (a Mac's sleep) arrives right
  // after the welcome, so lost connections count only once this one is a heartbeat and a half old.
  function checkHealth(id, c, res) {
    const row = get(id), t = Date.now();
    if (!row || !row.enabled) return;
    const ack = row.health_ack || 0, free = res.disk?.free;
    if (row.draining) return checkRecovered(row, free);
    if (Number.isFinite(free) && free < health.diskMinBytes && t - ack > health.ackQuietMs) {
      return autoDrain(id, `only ${gb(free)} is free on the disk that holds its repos (under ${gb(health.diskMinBytes)})`, 'disk');
    }
    if (t - c.connectedAt < heartbeatMs * 1.5) return;
    const lost = (drops.get(id) || []).filter((x) => x > Math.max(t - health.windowMs, ack));
    if (lost.length >= health.drops) autoDrain(id, `it lost its connection ${lost.length} times in ${Math.round(health.windowMs / 60_000)} min (missed heartbeats)`, 'drops');
  }
  // A low-disk drain lifts itself after recoverFrames frames in a row with diskMinBytes + diskRecoverBytes free. Rows
  // drained before drain_kind existed are known by their reason's text.
  function checkRecovered(row, free) {
    const disk = row.drain_kind === 'disk' || (!row.drain_kind && /is free on the disk that holds its repos/.test(row.drain_reason || ''));
    if (!disk || !Number.isFinite(free) || free < health.diskMinBytes + health.diskRecoverBytes) return void recovered.delete(row.id);
    const n = (recovered.get(row.id) || 0) + 1;
    if (n < health.recoverFrames) return void recovered.set(row.id, n);
    recovered.delete(row.id);
    db.prepare('UPDATE nodes SET draining=0, drain_reason=NULL, drain_kind=NULL, drained_at=NULL, health_ack=? WHERE id=?').run(Date.now(), row.id);
    setStatus(get(row.id), conns.has(row.id));
    log(`node ${row.id} undrained automatically: ${gb(free)} free again`);
    notice({ node: row.id, level: 'info', text: `${row.name} has ${gb(free)} free again and takes tasks again` });
    changed();
  }

  // ---- version check and updates
  const canUpdate = (c) => !!c?.hello?.features?.includes('update');
  function updateFailed(id, error) {
    const u = updates.get(id);
    if (!u || u.state === 'failed') return;
    Object.assign(u, { state: 'failed', error: clip(String(error || 'update failed'), 300), at: Date.now() });
    if (u.target) failedFor.set(id, u.target);
    log(`node ${id} update failed: ${u.error}`);
    notice({ node: id, level: 'warn', text: `${get(id)?.name || id} could not update itself: ${u.error}` });
    changed();
  }
  // A worker (re)connected on another sha: its update landed (or it was updated by hand). On the same sha a sent update
  // is still under way (a reconnect while it pulls); the worker reports a failure itself, else UPDATE_WAIT_MS ends it.
  function helloUpdate(id, row, sha) {
    const u = updates.get(id);
    if (!u || !sha || sha === u.from) return;
    updates.delete(id);
    failedFor.delete(id);
    log(`node ${id} updated to ${sha.slice(0, 8)}`);
    if (u.state === 'sent') notice({ node: id, level: 'info', text: `${row.name} updated itself to ${sha.slice(0, 8)}` });
  }
  // An outdated worker is marked for an update (status 'updating': no new jobs); once idle (its latest telemetry, sent on
  // this connection, lists no running job and the scheduler has nothing placed or offered there) it gets node.update.
  function checkUpdate(id) {
    const c = conns.get(id), row = c?.hello && get(id);
    if (!row?.enabled || !canUpdate(c)) return;
    let u = updates.get(id);
    if (!u && autoUpdate && versions) {
      const behind = versions.behind(c.hello.sha), target = versions.main();
      if (behind != null && behind > outdatedAfter && failedFor.get(id) !== target) {
        u = { state: 'pending', target, from: c.hello.sha, by: 'auto', at: Date.now() };
        updates.set(id, u);
        log(`node ${id} is ${behind} commits behind origin/main; it updates once idle`);
        changed();
      }
    }
    if (u?.state !== 'pending') return;
    const res = parse(row.resources); // idle = a reading from this connection lists no job
    if (!(res?.at >= c.connectedAt) || res.running?.length || busy(id)) return;
    if (!send(id, { t: MSG.NODE_UPDATE, ...(u.target ? { sha: u.target } : {}) })) return;
    Object.assign(u, { state: 'sent', at: Date.now(), from: c.hello.sha });
    log(`node ${id} is idle: sent node.update`);
    changed();
  }
  // The owner's "Update" (POST /api/cluster/nodes/:id/update): update it once idle, outdated or not.
  function requestUpdate(id) {
    const row = get(id), c = conns.get(id);
    if (!row || id === LOCAL_NODE) return { status: 404, error: 'no such worker' };
    if (!c?.hello) return { status: 409, error: `${row.name} is offline` };
    if (!canUpdate(c)) return { status: 409, error: `${row.name} runs a worker too old to update itself: run its install command again` };
    if (versions && versions.behind(c.hello.sha) === 0) return { status: 409, error: `${row.name} is up to date` };
    if (['pending', 'sent'].includes(updates.get(id)?.state)) return { node: node(id) }; // already on its way
    failedFor.delete(id);
    updates.set(id, { state: 'pending', target: versions?.main() || null, from: c.hello.sha, by: 'owner', at: Date.now() });
    checkUpdate(id);
    changed();
    return { node: node(id) };
  }

  // ---- on-demand reads from a worker
  // One request frame and its reply (matched by `req`): the reply, null on timeout, undefined when it couldn't be sent.
  function request(id, t, fields, timeoutMs) {
    const req = crypto.randomBytes(6).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => { requests.delete(req); resolve(null); }, timeoutMs);
      requests.set(req, { node: id, done: (m) => { clearTimeout(timer); requests.delete(req); resolve(m); } });
      if (!send(id, { t, req, ...fields })) { clearTimeout(timer); requests.delete(req); resolve(undefined); }
    });
  }
  // The worker's log, last `lines` lines (GET /api/cluster/nodes/:id/logs?tail=).
  async function logsTail(id, lines = 200) {
    const row = get(id), c = conns.get(id);
    if (!row) return { status: 404, error: 'no such node' };
    if (id === LOCAL_NODE) return { status: 400, error: 'the controller logs to its own journal (journalctl -u agent-orch)' };
    if (!c?.hello) return { status: 409, error: `${row.name} is offline` };
    if (!c.hello.features?.includes('logs')) return { status: 409, error: `${row.name} runs a worker too old to send its log` };
    const n = Math.max(1, Math.min(2000, Math.floor(Number(lines)) || 200));
    const m = await request(id, MSG.LOGS_TAIL, { lines: n }, logsTimeoutMs);
    if (m === undefined) return { status: 409, error: `${row.name} is not connected` };
    if (!m) return { status: 504, error: `${row.name} did not answer` };
    if (m.error) return { status: 500, error: m.error };
    return { node: id, lines: m.lines.slice(-n).map(String), at: Date.now() };
  }
  // A node's telemetry series (GET /api/cluster/nodes/:id/metrics?range=): range '15m', '1h' (default), '6h' or '24h'.
  function metricsOf(id, range) {
    if (!get(id)) return { status: 404, error: 'no such node' };
    const key = RANGES[range] ? range : '1h';
    return { node: id, range: key, samples: metrics ? metrics.series(id, key) : [] };
  }

  // For the scheduler: msg = {t, ...fields}; stamped and validated as a controller frame. False when not connected.
  function send(id, { t, ...fields }) {
    forWorker(t);
    const c = conns.get(id);
    if (!c?.hello || c.ws.readyState !== 1) return false;
    c.send(t, fields);
    return true;
  }
  function onMessage(handler) { handlers.add(handler); return () => handlers.delete(handler); }
  function close() {
    clearInterval(sweep);
    for (const c of conns.values()) c.ws.close(1001, 'controller shutting down');
    conns.clear();
    for (const r of requests.values()) r.done(null);
    db.close();
  }

  return { listNodes, node, createPairing, pairing, revokePairing, claim, whoami, update, revoke, handleUpgrade, send, onMessage, isConnected: (id) => conns.has(id), version: () => version, close,
    autoDrain, requestUpdate, logsTail, request, metrics: metricsOf, setBusy: (fn) => { busy = fn; }, setUpNext: (fn) => { upNext = fn; }, health,
    handleExt, syncExt, extHash: () => extInfo()?.hash || null };
}
