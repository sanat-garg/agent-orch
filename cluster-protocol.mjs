// Cluster wire protocol (BRIEF goal 11, design: .agent-orch/CLUSTER.md). Shared by the controller (server.mjs) and the
// worker daemon, so it has no deps beyond node built-ins. A frame is one JSON text message over the WebSocket:
//   {t, seq, ts, ...fields}   t = a MSG type, seq = per-sender counter (starts at 1 per connection), ts = epoch ms.
// Replies and acks name the frame they answer with `re` (its seq). Job frames carry `job` = the controller's task id.
// Secrets never travel over the wire (the node token rides in the upgrade's Authorization header); the one exception
// is `git.credential`, sent only to nodes the owner explicitly authorised to push with their GitHub token.

import crypto from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const WS_PATH = '/api/cluster/ws';
export const PAIR_PATH = '/api/cluster/pair'; // owner (signed in): POST → a one-time pairing code
export const CLAIM_PATH = '/api/cluster/claim'; // worker: POST {code, name, os, arch} → {node, token} once
export const HEARTBEAT_MS = 10_000;
export const HEARTBEAT_MISSES = 3; // no frame for 3 heartbeats = disconnected (the grace period starts then)
export const GRACE_MS = { mac: 5 * 60_000, vps: 2 * 60_000 };
export const WIP_PUSH_MS = 10 * 60_000;
export const MAX_FRAME = 1024 * 1024;
export const MAX_BATCH = 200; // normalised events per job.event frame
export const PAIRING_TTL_MS = 10 * 60_000;
export const WORKER_HOME = '~/.agent-orch-worker';

export const MSG = {
  HELLO: 'hello', WELCOME: 'welcome', INVENTORY: 'inventory', RESOURCES: 'resources', HEARTBEAT: 'heartbeat',
  ACK: 'ack', ERROR: 'error', BYE: 'bye',
  JOB_OFFER: 'job.offer', JOB_ACCEPT: 'job.accept', JOB_REJECT: 'job.reject', JOB_START: 'job.start',
  JOB_EVENT: 'job.event', JOB_CHECK: 'job.check', JOB_WIP: 'job.wip', JOB_DONE: 'job.done',
  JOB_CANCEL: 'job.cancel', JOB_PAUSE: 'job.pause', JOB_RESUME: 'job.resume',
  GIT_CREDENTIAL: 'git.credential',
  LOGIN_START: 'login.start', LOGIN_STATE: 'login.state', LOGIN_CODE: 'login.code', LOGIN_CANCEL: 'login.cancel',
  MODELS_REFRESH: 'models.refresh', MODELS: 'models', LIMITS_REFRESH: 'limits.refresh', LIMITS: 'limits',
};

// Who may send each type: 'w' worker → controller, 'c' controller → worker, 'both'. Only the controller originates jobs.
const C = 'c', W = 'w', B = 'both';
export const DIRECTION = {
  hello: W, welcome: C, inventory: W, resources: W, heartbeat: B, ack: B, error: B, bye: B,
  'job.offer': C, 'job.accept': W, 'job.reject': W, 'job.start': C, 'job.event': W, 'job.check': W, 'job.wip': W,
  'job.done': W, 'job.cancel': C, 'job.pause': C, 'job.resume': C, 'git.credential': C,
  'login.start': C, 'login.state': W, 'login.code': C, 'login.cancel': C,
  'models.refresh': C, models: W, 'limits.refresh': C, limits: W,
};

export const AGENT_IDS = ['claude', 'codex'];
export const OS_KINDS = ['linux', 'darwin'];
export const EVENT_KINDS = ['text', 'tool', 'tool_result', 'result', 'limit', 'image', 'windows'];
// runAgentCli outcomes plus the worker's own: setup_failed (clone/worktree/install), lost (controller gave up on it).
export const OUTCOMES = ['ok', 'rate_limited', 'auth_error', 'aborted', 'timeout', 'max_turns', 'error', 'empty_response', 'setup_failed', 'lost'];
export const REJECT_REASONS = ['busy', 'low_memory', 'agent_missing', 'not_signed_in', 'draining', 'version', 'other'];
export const LOGIN_STATES = ['starting', 'url', 'waiting_code', 'done', 'failed', 'cancelled'];

// Field specs: type name, '?' suffix = optional. Types: str, int, num, bool, obj, arr, sha, agent, os, plus enums above.
const S = {
  hello: { node: 'str', protocol: 'int', version: 'str', jobs: 'arr' },
  welcome: { node: 'str', protocol: 'int', heartbeatMs: 'int', wipPushMs: 'int', graceMs: 'int' },
  inventory: { node: 'str', name: 'str', os: 'os', arch: 'str', cores: 'int', mem: 'int', agents: 'arr', limits: 'obj?', versions: 'obj' },
  resources: { memAvailable: 'int', load: 'arr', running: 'arr', swapUsedPct: 'num?' },
  heartbeat: {},
  ack: { re: 'int' },
  error: { message: 'str', re: 'int?', job: 'int?' },
  bye: { reason: 'str?' },
  'job.offer': { job: 'int', agent: 'agent', model: 'str?', footprint: 'int?' },
  'job.accept': { job: 'int' },
  'job.reject': { job: 'int', reason: 'reject' },
  'job.start': {
    job: 'int', title: 'str', prompt: 'str', systemAppend: 'str?', agent: 'agent', model: 'str?', account: 'str?',
    repo: 'repo', baseSha: 'sha', branch: 'branch', doneWhen: 'str?', resume: 'str?',
    timeouts: 'obj', autonomous: 'bool?', tools: 'arr?', install: 'arr?',
  },
  'job.event': { job: 'int', from: 'int', events: 'events' },
  'job.check': { job: 'int', command: 'str', output: 'str', pass: 'bool', code: 'int?' },
  'job.wip': { job: 'int', sha: 'sha', branch: 'branch' },
  'job.done': { job: 'int', outcome: 'outcome', text: 'str', usage: 'obj?', limits: 'obj?', sha: 'sha?', sessionId: 'str?' },
  'job.cancel': { job: 'int', reason: 'str?' },
  'job.pause': { job: 'int' },
  'job.resume': { job: 'int', prompt: 'str?' },
  'git.credential': { host: 'str', token: 'str' },
  'login.start': { login: 'str', agent: 'agent' },
  'login.state': { login: 'str', state: 'login', url: 'str?', code: 'str?', account: 'str?', message: 'str?' },
  'login.code': { login: 'str', code: 'str' },
  'login.cancel': { login: 'str' },
  'models.refresh': { agent: 'agent' },
  models: { agent: 'agent', models: 'arr', error: 'str?' },
  'limits.refresh': { agent: 'agent' },
  limits: { agent: 'agent', windows: 'arr', error: 'str?' },
};
export const SCHEMA = S;

const SHA_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^agent-orch\/task-\d+$/;
// Plain https or ssh GitHub-style URLs; never credentials embedded in the URL.
const REPO_RE = /^(https:\/\/[^\s/@:]+(?::\d+)?\/[\w.\-/]+|git@[\w.-]+:[\w.\-/]+)$/;
export const isRepoUrl = (v) => typeof v === 'string' && REPO_RE.test(v);
// Key names ending like a secret (githubToken, api_key, password…); usage counters such as input_tokens don't match.
const SECRET_KEY_RE = /(token|secret|password|passwd|api_?key|apikey|cookie|credentials?|authorization|bearer)$/i;

const TYPES = {
  str: (v) => typeof v === 'string', int: Number.isSafeInteger, num: (v) => typeof v === 'number' && Number.isFinite(v),
  bool: (v) => typeof v === 'boolean', obj: (v) => !!v && typeof v === 'object' && !Array.isArray(v), arr: Array.isArray,
  sha: (v) => typeof v === 'string' && SHA_RE.test(v), branch: (v) => typeof v === 'string' && BRANCH_RE.test(v),
  repo: (v) => typeof v === 'string' && REPO_RE.test(v), agent: (v) => AGENT_IDS.includes(v), os: (v) => OS_KINDS.includes(v),
  outcome: (v) => OUTCOMES.includes(v), reject: (v) => REJECT_REASONS.includes(v), login: (v) => LOGIN_STATES.includes(v),
  events: (v) => Array.isArray(v) && v.length > 0 && v.length <= MAX_BATCH && v.every((e) => e && EVENT_KINDS.includes(e.k)),
};

// Keys anywhere in a frame that look like secrets (paths like "agents.0.token"). git.credential is exempt, and agent
// events are not scanned (tool inputs are the agent's own data, already in the worker's run log).
export function secretKeys(v, at = '') {
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v).flatMap(([k, x]) => {
    const p = at ? `${at}.${k}` : k;
    return [...(!Array.isArray(v) && SECRET_KEY_RE.test(k) ? [p] : []), ...secretKeys(x, p)];
  });
}

// Checks a decoded frame. `from` ('c' | 'w') also enforces the direction. Returns an error string, or null when valid.
export function validate(msg, { from } = {}) {
  if (!TYPES.obj(msg)) return 'frame is not an object';
  const spec = S[msg.t];
  if (!spec) return `unknown type ${JSON.stringify(msg.t)}`;
  if (!Number.isSafeInteger(msg.seq) || msg.seq < 1) return `${msg.t}: seq must be a positive integer`;
  if (!TYPES.num(msg.ts)) return `${msg.t}: ts must be a number`;
  if (from && DIRECTION[msg.t] !== B && DIRECTION[msg.t] !== from) return `${msg.t} may not be sent by the ${from === C ? 'controller' : 'worker'}`;
  for (const [key, type] of Object.entries(spec)) {
    const opt = type.endsWith('?'), base = opt ? type.slice(0, -1) : type, v = msg[key];
    if (v == null) { if (opt) continue; return `${msg.t}: missing ${key}`; }
    if (!TYPES[base](v)) return `${msg.t}: bad ${key}`;
  }
  if (msg.t !== MSG.GIT_CREDENTIAL) {
    const bad = secretKeys({ ...msg, events: undefined });
    if (bad.length) return `${msg.t}: secrets may not travel over the wire (${bad.join(', ')})`;
  }
  if (msg.t === MSG.INVENTORY) {
    const a = msg.agents.find((x) => !TYPES.obj(x) || !AGENT_IDS.includes(x.id) || typeof x.installed !== 'boolean' || typeof x.signedIn !== 'boolean');
    if (a !== undefined) return 'inventory: each agent needs id, installed and signedIn';
  }
  if (msg.t === MSG.HELLO && msg.jobs.some((j) => !TYPES.obj(j) || !Number.isSafeInteger(j.job))) return 'hello: each job needs a job id';
  return null;
}

// A sender: stamps seq/ts, validates, and serialises. Throws on an invalid frame (a programming error on our side).
export function createSender(from) {
  let seq = 0;
  return (t, fields = {}) => {
    const msg = { ...fields, t, seq: ++seq, ts: Date.now() };
    const err = validate(msg, { from });
    if (err) { seq--; throw new Error(err); }
    const s = JSON.stringify(msg);
    if (Buffer.byteLength(s) > MAX_FRAME) { seq--; throw new Error(`${t}: frame exceeds ${MAX_FRAME} bytes`); }
    return s;
  };
}

// Parses and validates an incoming frame from `from`. Returns {msg} or {error}; the caller answers errors with MSG.ERROR.
export function decode(raw, { from } = {}) {
  const s = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : null;
  if (s == null) return { error: 'frame is not text' };
  if (Buffer.byteLength(s) > MAX_FRAME) return { error: `frame exceeds ${MAX_FRAME} bytes` };
  let msg;
  try { msg = JSON.parse(s); } catch { return { error: 'frame is not JSON' }; }
  const error = validate(msg, { from });
  return error ? { error } : { msg };
}

// Splits normalised agent events into job.event batches of at most MAX_BATCH (`from` = index of the first event,
// so the controller can drop duplicates re-sent after a reconnect).
export function batchEvents(events, start = 0) {
  const out = [];
  for (let i = 0; i < events.length; i += MAX_BATCH) out.push({ from: start + i, events: events.slice(i, i + MAX_BATCH) });
  return out;
}

// Reconnect delay: 1 s doubling to 60 s, with ±20% jitter so a fleet doesn't reconnect in lockstep.
export function backoffMs(attempt, rand = Math.random) {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + 0.4 * rand()));
}

// How long the controller waits for a vanished node before reassigning its jobs.
export const graceMs = (os) => (os === 'darwin' ? GRACE_MS.mac : GRACE_MS.vps);

// Pairing: the owner gets a short one-time code in the UI; the worker trades it (POST CLAIM_PATH) for a node id and a
// long bearer token. The controller stores only sha256 hashes of both.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export function newPairingCode(bytes = crypto.randomBytes(8)) {
  const c = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${c.slice(0, 4)}-${c.slice(4, 8)}`;
}
// The code as typed by the owner (any case, with or without the dash) → canonical `XXXX-XXXX`, or null.
export function normalizePairingCode(s) {
  const c = String(s || '').toUpperCase().replace(/[\s-]/g, '');
  return c.length === 8 && [...c].every((x) => CODE_ALPHABET.includes(x)) ? `${c.slice(0, 4)}-${c.slice(4)}` : null;
}
export const newNodeToken = () => `aon_${crypto.randomBytes(32).toString('base64url')}`;
export const hashSecret = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export function secretMatches(secret, hash) {
  if (typeof secret !== 'string' || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return false;
  return crypto.timingSafeEqual(Buffer.from(hashSecret(secret), 'hex'), Buffer.from(hash, 'hex'));
}
// The bearer token from an upgrade request's headers, or null.
export function bearerToken(headers = {}) {
  const m = /^Bearer\s+(\S+)$/i.exec(headers.authorization || '');
  return m ? m[1] : null;
}
