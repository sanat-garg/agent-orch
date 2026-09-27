// Controller side of the cluster (BRIEF goal 11, design: .agent-orch/CLUSTER.md, wire format: cluster-protocol.mjs).
// Node registry in the orchestrator DB, one-time pairing codes, and the worker WebSocket hub at WS_PATH. The scheduler
// uses listNodes() / send(nodeId, msg) / onMessage(handler) / version(); the UI reads listNodes() via GET /api/cluster/nodes.
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import {
  PROTOCOL_VERSION, HEARTBEAT_MS, HEARTBEAT_MISSES, WIP_PUSH_MS, MAX_FRAME, PAIRING_TTL_MS, OS_KINDS, MSG,
  graceMs, newPairingCode, normalizePairingCode, newNodeToken, hashSecret, secretMatches, bearerToken, createSender, decode,
} from './cluster-protocol.mjs';

export const LOCAL_NODE = 'controller';
const MAX_ERRORS = 5; // invalid frames per connection before the worker is disconnected

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, os TEXT, arch TEXT, token_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL, last_seen INTEGER, status TEXT NOT NULL DEFAULT 'offline',
  inventory TEXT, resources TEXT, max_slots INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
  draining INTEGER NOT NULL DEFAULT 0
)`;
// Added later: grace_ms (the owner's per-node grace before its jobs are reassigned; NULL = graceMs(os)); away (why a
// node is offline: 'bye' after a clean shutdown, 'asleep' when a Mac went silent, 'lost' otherwise); slept_at/slept_ms
// (the last sleep a worker reported on wake). max_slots 0 = Auto (the scheduler sizes it from cores and free RAM).
const COLUMNS = [['grace_ms', 'INTEGER'], ['away', 'TEXT'], ['slept_at', 'INTEGER'], ['slept_ms', 'INTEGER']];

const statusOf = (row, connected) => (!row.enabled ? 'disabled' : !connected ? 'offline' : row.draining ? 'draining' : 'online');
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64) : '');

// dbFile: the orchestrator DB. local(): {inventory, resources, maxSlots?} for the controller's own node row.
// heartbeatMs: liveness interval (tests shorten it); a node is offline after HEARTBEAT_MISSES silent intervals.
// wipPushMs: how often workers push WIP while an agent runs; graceMs: every node's grace period (tests shorten both).
export function createCluster({ dbFile, local = () => ({}), heartbeatMs = HEARTBEAT_MS, wipPushMs = WIP_PUSH_MS, graceMs: graceAll = null, log = () => {}, onChange = () => {} }) {
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(SCHEMA);
  const cols = db.prepare('PRAGMA table_info(nodes)').all().map((c) => c.name);
  for (const [c, type] of COLUMNS) if (!cols.includes(c)) db.exec(`ALTER TABLE nodes ADD COLUMN ${c} ${type}`);
  const conns = new Map(); // node id -> { ws, send, lastFrame, hello, errors }
  const codes = new Map(); // hashSecret(code) -> { expiresAt, node }; single use (node = the id that claimed it)
  const handlers = new Set();
  const get = (id) => db.prepare('SELECT * FROM nodes WHERE id=?').get(id);

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

  function refreshLocal() {
    let info = {};
    try { info = local() || {}; } catch (e) { log(`local node info failed: ${e.message}`); }
    db.prepare('UPDATE nodes SET last_seen=?, inventory=COALESCE(?, inventory), resources=COALESCE(?, resources) WHERE id=?')
      .run(Date.now(), info.inventory ? JSON.stringify(info.inventory) : null, info.resources ? JSON.stringify(info.resources) : null, LOCAL_NODE);
  }

  // A node that went away: why (row.away), and the owner-facing words for it ('Mac asleep').
  const awayLabel = (row) => (row.away === 'asleep' ? 'Mac asleep' : row.away === 'bye' ? 'shut down' : 'offline');
  const nodeGrace = (row) => graceAll ?? row.grace_ms ?? graceMs(row.os);

  // Public view: never the token hash.
  function view(row) {
    const c = conns.get(row.id), isLocal = row.id === LOCAL_NODE, connected = isLocal || !!c;
    return {
      id: row.id, name: row.name, os: row.os, arch: row.arch, local: isLocal, connected,
      status: row.status, createdAt: row.created_at, lastSeen: row.last_seen,
      away: connected ? null : row.away || 'lost', awayLabel: connected ? null : awayLabel(row),
      graceMs: nodeGrace(row), sleptAt: row.slept_at ?? null, sleptMs: row.slept_ms ?? null,
      enabled: !!row.enabled, draining: !!row.draining, maxSlots: row.max_slots || null, // null = Auto
      inventory: parse(row.inventory), resources: parse(row.resources),
      protocol: c?.hello?.protocol ?? null, version: c?.hello?.version ?? null,
    };
  }
  function listNodes() {
    refreshLocal();
    return db.prepare('SELECT * FROM nodes ORDER BY id=? DESC, created_at').all(LOCAL_NODE).map(view);
  }
  const node = (id) => { const r = get(id); return r ? view(r) : null; };

  // ---- pairing
  function createPairing() {
    const t = Date.now();
    for (const [h, c] of codes) if (c.expiresAt < t) codes.delete(h);
    const code = newPairingCode(), expiresAt = t + PAIRING_TTL_MS;
    codes.set(hashSecret(code), { expiresAt, node: null });
    return { code, expiresAt };
  }
  // The "Add machine" wizard's view of its code: waiting → paired (node claimed it; node.connected once it dials in),
  // or expired. Claimed codes are remembered until their original expiry so the wizard can see who took them.
  function pairing(code) {
    const c = normalizePairingCode(code), e = c && codes.get(hashSecret(c));
    if (!e) return { state: 'unknown' };
    const n = e.node && node(e.node);
    if (n) return { state: 'paired', expiresAt: e.expiresAt, node: n };
    return { state: e.expiresAt < Date.now() ? 'expired' : 'waiting', expiresAt: e.expiresAt };
  }
  // Worker side of pairing: a valid unexpired code → a new node and its token (returned only here, stored hashed).
  function claim({ code, name, os: kind, arch } = {}) {
    const c = normalizePairingCode(code), h = c && hashSecret(c), e = h && codes.get(h);
    if (!e || e.node || e.expiresAt < Date.now()) { if (e && !e.node) codes.delete(h); return { status: 401, error: 'invalid or expired pairing code' }; }
    if (!OS_KINDS.includes(kind)) return { status: 400, error: `os must be one of ${OS_KINDS.join(', ')}` };
    if (typeof arch !== 'string' || !/^[\w.-]{1,20}$/.test(arch)) return { status: 400, error: 'arch required' };
    const label = cleanName(name);
    if (!label) return { status: 400, error: 'name required' };
    const id = `n_${crypto.randomBytes(6).toString('hex')}`, token = newNodeToken();
    e.node = id;
    db.prepare('INSERT INTO nodes (id, name, os, arch, token_hash, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, label, kind, arch, hashSecret(token), Date.now(), 'offline');
    log(`paired node ${id} (${label}, ${kind}/${arch})`);
    changed();
    return { node: id, name: label, token };
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
    const keys = Object.keys(set);
    if (keys.length) db.prepare(`UPDATE nodes SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`).run(...keys.map((k) => set[k]), id);
    setStatus(get(id), id === LOCAL_NODE || conns.has(id));
    changed();
    return { node: node(id) };
  }
  function revoke(id) {
    if (id === LOCAL_NODE) return { status: 400, error: 'the controller node cannot be removed' };
    if (!get(id)) return { status: 404, error: 'no such node' };
    db.prepare('DELETE FROM nodes WHERE id=?').run(id);
    const c = conns.get(id);
    if (c) { conns.delete(id); c.ws.close(4003, 'revoked'); }
    log(`revoked node ${id}`);
    changed();
    return { ok: true };
  }

  // ---- WebSocket hub
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const deny = (socket, code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  // Bearer token only (no session cookie): unknown or revoked tokens are refused before any frame is read.
  function handleUpgrade(req, socket, head) {
    const token = bearerToken(req.headers);
    const row = token && db.prepare('SELECT * FROM nodes WHERE token_hash=?').get(hashSecret(token));
    if (!row || !secretMatches(token, row.token_hash)) return deny(socket, 401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, row.id));
  }

  function attach(ws, id) {
    const old = conns.get(id);
    if (old) { conns.delete(id); old.ws.close(4000, 'replaced by a new connection'); }
    const sender = createSender('c');
    const c = { ws, lastFrame: Date.now(), hello: null, errors: 0 };
    c.send = (t, fields) => { if (ws.readyState === 1) ws.send(sender(t, fields)); };
    conns.set(id, c);
    const own = () => conns.get(id) === c;
    const touch = (extra = {}) => {
      const cols = { last_seen: Date.now(), ...extra }, keys = Object.keys(cols);
      db.prepare(`UPDATE nodes SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`).run(...keys.map((k) => cols[k]), id);
    };
    const fail = (message, re) => {
      try { c.send(MSG.ERROR, re ? { message, re } : { message }); } catch {}
      if (++c.errors >= MAX_ERRORS) ws.close(1008, 'too many invalid frames');
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
          if (msg.node !== id) { fail('hello.node does not match this token', msg.seq); return ws.close(1008, 'wrong node'); }
          if (msg.protocol !== PROTOCOL_VERSION) {
            fail(`protocol ${msg.protocol} is not supported (controller speaks ${PROTOCOL_VERSION}): update the worker`, msg.seq);
            c.send(MSG.BYE, { reason: 'version' });
            return ws.close(1008, 'protocol version');
          }
          c.hello = { protocol: msg.protocol, version: msg.version, jobs: msg.jobs };
          const row = get(id);
          touch();
          setStatus(row, true);
          touch({ away: null });
          c.send(MSG.WELCOME, { node: id, protocol: PROTOCOL_VERSION, heartbeatMs, wipPushMs, graceMs: nodeGrace(row) });
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
          changed('resources');
          break;
        }
        case MSG.BYE: c.bye = true; touch(); ws.close(1000, 'bye'); break;
        case MSG.WAKE:
          touch({ slept_at: Math.round(msg.sleptAt), slept_ms: msg.sleptMs });
          log(`node ${id} woke after ${Math.round(msg.sleptMs / 60_000)} min asleep`);
          changed();
          break;
        default: touch();
      }
      for (const h of handlers) { try { h(id, msg); } catch (e) { log(`cluster handler failed: ${e.message}`); } }
    });
    ws.on('close', () => {
      if (!own()) return;
      conns.delete(id);
      gone(id, c.bye);
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
        log(`node ${id} missed ${HEARTBEAT_MISSES} heartbeats; marked offline`);
        c.ws.terminate();
        changed();
      } else if (c.ws.readyState === 1) {
        try { c.send(MSG.HEARTBEAT); c.ws.ping(); } catch {}
      }
    }
  }, heartbeatMs);
  sweep.unref?.();

  // For the scheduler: msg = {t, ...fields}; stamped and validated as a controller frame. False when not connected.
  function send(id, { t, ...fields }) {
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
    db.close();
  }

  return { listNodes, node, createPairing, pairing, claim, update, revoke, handleUpgrade, send, onMessage, isConnected: (id) => conns.has(id), version: () => version, close };
}
