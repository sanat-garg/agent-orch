// Cluster wire protocol (BRIEF goal 11, design: .agent-orch/CLUSTER.md). Shared by the controller (server.mjs) and the
// worker daemon, so it has no deps beyond node built-ins. A frame is one JSON text message over the WebSocket:
//   {t, seq, ts, ...fields}   t = a MSG type, seq = per-sender counter (starts at 1 per connection), ts = epoch ms.
// Replies and acks name the frame they answer with `re` (its seq). Job frames carry `job` = the controller's task id.
// Secrets never travel over the wire (the node token rides in the upgrade's Authorization header); the exceptions are
// `git.credential`, sent only to nodes the owner explicitly authorised to push with their GitHub token, and
// `agent.credential`: the head's Claude worker token and Codex sign-in, so no worker needs a sign-in of its own.

import crypto from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const WS_PATH = '/api/cluster/ws';
export const PAIR_PATH = '/api/cluster/pair'; // owner (signed in): POST {uses?} → a pairing code; DELETE …/:code revokes it
export const CLAIM_PATH = '/api/cluster/claim'; // worker: POST {code, name, os, arch} → {node, token} once per machine
// worker: GET with its bearer token → {node, name} while the head still knows this machine, 401 once it was removed.
// The installer asks before pairing again, so re-running it never adds the same machine twice.
export const WHOAMI_PATH = '/api/cluster/me';
export const HEARTBEAT_MS = 10_000;
export const HEARTBEAT_MISSES = 3; // no frame for 3 heartbeats = disconnected (the grace period starts then)
export const GRACE_MS = { mac: 5 * 60_000, vps: 2 * 60_000 };
export const WIP_PUSH_MS = 10 * 60_000;
export const SLEEP_JUMP_MS = 30_000; // a timer firing this much later than due means the machine was asleep
export const MAX_FRAME = 1024 * 1024;
export const MAX_BATCH = 200; // normalised events per job.event frame
export const PAIRING_TTL_MS = 10 * 60_000; // a one-time code
export const PAIRING_MULTI_TTL_MS = 60 * 60_000; // a multi-use code (several machines in one go)
export const MAX_PAIRING_USES = 20;
export const WORKER_HOME = '~/.agent-orch-worker';

export const MSG = {
  HELLO: 'hello', WELCOME: 'welcome', INVENTORY: 'inventory', RESOURCES: 'resources', HEARTBEAT: 'heartbeat',
  ACK: 'ack', ERROR: 'error', BYE: 'bye',
  JOB_OFFER: 'job.offer', JOB_ACCEPT: 'job.accept', JOB_REJECT: 'job.reject', JOB_START: 'job.start',
  JOB_EVENT: 'job.event', JOB_CHECK: 'job.check', JOB_WIP: 'job.wip', JOB_DONE: 'job.done',
  JOB_CANCEL: 'job.cancel', JOB_PAUSE: 'job.pause', JOB_RESUME: 'job.resume', JOB_ATTACH: 'job.attach', WAKE: 'wake',
  GIT_CREDENTIAL: 'git.credential', AGENT_CREDENTIAL: 'agent.credential',
  LOGIN_START: 'login.start', LOGIN_STATE: 'login.state', LOGIN_CODE: 'login.code', LOGIN_CANCEL: 'login.cancel', LOGIN_LOGOUT: 'login.logout',
  MODELS_REFRESH: 'models.refresh', MODELS: 'models', LIMITS_REFRESH: 'limits.refresh', LIMITS: 'limits',
  JOB_PHASE: 'job.phase', JOB_ERROR: 'job.error', NODE_ERROR: 'node.error', LOGS_TAIL: 'logs.tail', LOGS: 'logs', NODE_UPDATE: 'node.update',
  NODE_POLICY: 'node.policy', JOB_APPROVAL: 'job.approval',
  SCREEN_REQ: 'screen.req', SCREEN_RES: 'screen.res', SCREEN_INPUT: 'screen.input', SCREEN_FRAME: 'screen.frame', SCREEN_STATE: 'screen.state',
};

// Who may send each type: 'w' worker → controller, 'c' controller → worker, 'both'. Only the controller originates jobs.
const C = 'c', W = 'w', B = 'both';
export const DIRECTION = {
  hello: W, welcome: C, inventory: W, resources: W, heartbeat: B, ack: B, error: B, bye: B,
  'job.offer': C, 'job.accept': W, 'job.reject': W, 'job.start': C, 'job.event': W, 'job.check': W, 'job.wip': W,
  'job.done': W, 'job.cancel': C, 'job.pause': C, 'job.resume': C, 'job.attach': C, wake: W, 'git.credential': C, 'agent.credential': B,
  'login.start': C, 'login.state': W, 'login.code': C, 'login.cancel': C, 'login.logout': C,
  'models.refresh': C, models: W, 'limits.refresh': C, limits: W,
  'job.phase': W, 'job.error': W, 'node.error': W, 'logs.tail': C, logs: W, 'node.update': C, 'node.policy': C, 'job.approval': C,
  'screen.req': C, 'screen.res': W, 'screen.input': C, 'screen.frame': W, 'screen.state': W,
};
// Frame types a peer sends only when the other side lists the feature (hello.features: the worker's, welcome.features:
// the controller's), so a worker updated ahead of the controller's running code (or the reverse) never sends a type the
// other can't read. Additive fields need no flag: validators ignore unknown fields.
// Feature 'policy' also covers the job.reject reason 'power'; feature 'cap' (no frame type of its own) is the job.reject
// reason 'cap': the worker's local cap (cap.mjs) is full.
export const FEATURES = { 'job.phase': 'phases', 'job.error': 'errors', 'node.error': 'errors', 'logs.tail': 'logs', logs: 'logs', 'node.update': 'update',
  'node.policy': 'policy', 'agent.credential': 'creds', 'job.approval': 'approvals',
  'screen.req': 'screen', 'screen.res': 'screen', 'screen.input': 'screen', 'screen.frame': 'screen', 'screen.state': 'screen' };
export const FEATURE_LIST = [...new Set([...Object.values(FEATURES), 'cap'])];
// Compute-only workers (BRIEF goal 11): the only frames a worker acts on, all from the head it dialled. Connection
// upkeep; jobs (job.*, plus git.credential for their pushes); remote sign-in driven from the head's Connections (login.*);
// model and limit refreshes; its log tail; self-update; and the node's policy (max tasks, power), which like draining is
// set on the head only; and the owner's live view of a browser profile on it (screen.*). A worker rejects and logs any other type, even one added here later, and the head's hub never
// sends one: there is no chat, prompt, planner, reflection or settings frame for a worker.
export const WORKER_ACCEPTS = Object.freeze([
  MSG.WELCOME, MSG.HEARTBEAT, MSG.ACK, MSG.ERROR, MSG.BYE,
  MSG.JOB_OFFER, MSG.JOB_START, MSG.JOB_CANCEL, MSG.JOB_PAUSE, MSG.JOB_RESUME, MSG.JOB_ATTACH, MSG.GIT_CREDENTIAL, MSG.AGENT_CREDENTIAL,
  MSG.LOGIN_START, MSG.LOGIN_CODE, MSG.LOGIN_CANCEL, MSG.LOGIN_LOGOUT,
  MSG.MODELS_REFRESH, MSG.LIMITS_REFRESH, MSG.LOGS_TAIL, MSG.NODE_UPDATE, MSG.NODE_POLICY, MSG.JOB_APPROVAL, MSG.SCREEN_REQ, MSG.SCREEN_INPUT,
]);

export const AGENT_IDS = ['claude', 'codex'];
export const OS_KINDS = ['linux', 'darwin'];
// audit / approval (feature 'approvals'): the approval gate's log lines and held calls on a browser run (gate.mjs).
export const EVENT_KINDS = ['text', 'tool', 'tool_result', 'result', 'limit', 'image', 'windows', 'audit', 'approval'];
// runAgentCli outcomes plus the worker's own: setup_failed (clone/worktree/install), lost (controller gave up on it).
export const OUTCOMES = ['ok', 'rate_limited', 'auth_error', 'aborted', 'timeout', 'max_turns', 'error', 'empty_response', 'setup_failed', 'lost'];
// power: its power policy pauses intake (on battery, running hot); sent only to a controller with feature 'policy'.
// cap: taking it would go over the machine's local cap (`node worker.mjs limit`); only to a controller with feature 'cap'.
export const REJECT_REASONS = ['busy', 'low_memory', 'agent_missing', 'not_signed_in', 'draining', 'version', 'other', 'power', 'cap'];
// starting → url (open it; a device code may ride along) or waiting_code (paste the page's code back) → done | failed |
// cancelled; signed_out answers login.logout.
export const LOGIN_STATES = ['starting', 'url', 'waiting_code', 'done', 'failed', 'cancelled', 'signed_out'];
// A job's phases on a worker, in order (job.phase): cloning = a first clone of the repo, fetching = an update of the cached
// clone; installing only when the job installs dependencies, checking only when it has a done-when check.
export const PHASES = ['queued', 'cloning', 'fetching', 'installing', 'running', 'checking', 'committing', 'pushing', 'done'];

// Field specs: type name, '?' suffix = optional. Types: str, int, num, bool, obj, arr, sha, agent, os, plus enums above.
const S = {
  // sha: the worker's agent-orch checkout (the controller compares it with its origin/main); features: see FEATURES.
  hello: { node: 'str', protocol: 'int', version: 'str', jobs: 'arr', sha: 'sha?', features: 'arr?' },
  // policy: the node's power policy and caps (power.mjs: minBattery, keepAwake, thermal, reserveGB, plus maxTasks).
  // queued: work tasks on the head ready to start that this node could take ("up next" in its status view).
  welcome: { node: 'str', protocol: 'int', heartbeatMs: 'int', wipPushMs: 'int', graceMs: 'int', features: 'arr?', policy: 'obj?', queued: 'int?' },
  // cap: the machine's local cap in effect (cap.mjs resolveCap: {cpu: cores, mem: bytes, maxTasks, onlyOnAc}; null = none).
  // browser: {capable, headed, error?}: whether it has a Chromium/Chrome for browser tasks (browser.mjs ensureBrowser).
  inventory: { node: 'str', name: 'str', os: 'os', arch: 'str', cores: 'int', mem: 'int', agents: 'arr', limits: 'obj?', versions: 'obj', cap: 'obj?', browser: 'obj?' },
  // Also the worker's health telemetry (every heartbeat, the controller keeps a 24 h series): cpu (% per core), memTotal,
  // swapTotal/swapUsed (bytes), disk {path, free, total} (the volume holding its repos), net {host, ok, ms, at, error}
  // (reachability of GitHub), agents [{id, installed, version, signedIn}] (as last checked, never polled), uptime (s),
  // procUptime (s), version, sha, and on macOS battery {pct, charging, source} and thermal {pressure, speedLimit, level}.
  // intake: whether its power policy lets it take new jobs ({ok} or {ok: false, reason, text}); awake: caffeinate holds it awake.
  // cap: its local cap in effect (as in inventory; null = none); jobsMem (bytes) / jobsCpu (cores): what its jobs use now.
  resources: {
    memAvailable: 'int', load: 'arr', running: 'arr', swapUsedPct: 'num?', cpu: 'arr?', memTotal: 'int?', swapTotal: 'int?', swapUsed: 'int?',
    disk: 'obj?', net: 'obj?', agents: 'arr?', uptime: 'num?', procUptime: 'num?', version: 'str?', sha: 'sha?', battery: 'obj?', thermal: 'obj?',
    intake: 'obj?', awake: 'bool?', cap: 'obj?', jobsMem: 'int?', jobsCpu: 'num?',
  },
  heartbeat: { queued: 'int?' }, // queued: the controller's, as in welcome
  ack: { re: 'int', job: 'int?' }, // job: the controller acks a job.done (the worker then forgets the job)
  error: { message: 'str', re: 'int?', job: 'int?' },
  bye: { reason: 'str?' },
  'job.offer': { job: 'int', agent: 'agent', model: 'str?', footprint: 'int?' },
  'job.accept': { job: 'int' },
  'job.reject': { job: 'int', reason: 'reject' },
  'job.start': {
    // effort: the reasoning-effort level the controller read at this session boundary (the worker clamps it to the agent).
    // capabilities ["browser"] + identity: the run gets the Playwright MCP on that browser profile (browser.mjs).
    job: 'int', title: 'str', prompt: 'str', systemAppend: 'str?', agent: 'agent', model: 'str?', effort: 'str?', account: 'str?',
    repo: 'repo', baseSha: 'sha', branch: 'branch', doneWhen: 'str?', resume: 'str?',
    timeouts: 'obj', autonomous: 'bool?', tools: 'arr?', install: 'arr?', capabilities: 'arr?', identity: 'str?',
  },
  'job.event': { job: 'int', from: 'int', events: 'events' },
  'job.check': { job: 'int', command: 'str', output: 'str', pass: 'bool', code: 'int?' },
  'job.wip': { job: 'int', sha: 'sha', branch: 'branch' },
  'job.done': { job: 'int', outcome: 'outcome', text: 'str', usage: 'obj?', limits: 'obj?', sha: 'sha?', sessionId: 'str?' },
  'job.cancel': { job: 'int', reason: 'str?' },
  'job.pause': { job: 'int' },
  'job.resume': { job: 'int', prompt: 'str?' },
  // After a (re)connect: the controller still wants this job and holds its events up to `from` (exclusive); the worker
  // replays from there (events and the job's later check/wip/done frames). Until then it holds the job's frames.
  'job.attach': { job: 'int', from: 'int' },
  // A time jump on the worker (a laptop's sleep): it was suspended from sleptAt (epoch ms) for sleptMs.
  wake: { sleptAt: 'num', sleptMs: 'int' },
  'git.credential': { host: 'str', token: 'str' },
  // The head's sign-in for an agent, so workers need none (agent-share.mjs). claude: the long-lived token from
  // `claude setup-token` (the worker runs Claude with CLAUDE_CODE_OAUTH_TOKEN); codex: the text of ~/.codex/auth.json.
  // value null = the head stopped sharing it. Controller → worker to share; worker → controller only for codex, when
  // the worker's copy refreshed itself (the head keeps the newest and re-shares it, so every machine stays signed in).
  'agent.credential': { agent: 'agent', value: 'str?' },
  // Remote sign-in (the worker runs connections.mjs locally): `login` = the controller's id for this attempt.
  // login.state.prompt: a CLI question nobody auto-answers; message: the error on failed.
  'login.start': { login: 'str', agent: 'agent' },
  'login.state': { login: 'str', state: 'login', url: 'str?', code: 'str?', account: 'str?', message: 'str?', prompt: 'str?' },
  'login.code': { login: 'str', code: 'str' },
  'login.cancel': { login: 'str' },
  'login.logout': { login: 'str', agent: 'agent' },
  'models.refresh': { agent: 'agent' },
  models: { agent: 'agent', models: 'arr', error: 'str?' },
  'limits.refresh': { agent: 'agent' },
  limits: { agent: 'agent', windows: 'arr', error: 'str?' },
  // A job moved to `phase` at `at` (worker epoch ms); ms = how long the phase before it took (the worker's own clock, so
  // skew doesn't matter). While running, the same phase and `at` are re-sent with progress {tools, files, last}: tool
  // calls so far, files its edit tools touched, the last tool line. The done phase carries the outcome.
  'job.phase': { job: 'int', phase: 'phase', at: 'num', ms: 'int?', progress: 'obj?', outcome: 'outcome?' },
  // Structured failures, with a stack or stderr tail. job.error kinds: agent_crash, setup_failed, install_failed,
  // push_failed, check_crashed; node.error kinds: exception, update (re: the node.update it answers), inventory.
  // job.error.at: when it happened (worker epoch ms; a replay after a reconnect dedupes by it).
  'job.error': { job: 'int', kind: 'str', message: 'str', stack: 'str?', stderr: 'str?', at: 'num?' },
  'node.error': { kind: 'str', message: 'str', stack: 'str?', stderr: 'str?', re: 'int?' },
  // The owner asked for the worker's log (GET /api/cluster/nodes/:id/logs?tail=): the last `lines` lines, answered by `logs`.
  'logs.tail': { req: 'str', lines: 'int' },
  logs: { req: 'str', lines: 'arr', error: 'str?' },
  // Update agent-orch on the worker (git pull --ff-only, npm ci when the lockfile changed) and restart its service. Sent
  // only while the node is idle; a busy worker refuses (node.error kind update). sha: the controller's origin/main.
  'node.update': { sha: 'sha?' },
  // The owner changed the node's power policy or max tasks (Machines view): the same shape as welcome.policy.
  'node.policy': { policy: 'obj' },
  // The owner's answer to a held call of a job's approval gate (gate.mjs): decision approve | always | auto | deny | expired,
  // reason (fed back to the agent on a denial). Sent again after the job re-attaches; a worker ignores answered ids.
  'job.approval': { job: 'int', id: 'str', decision: 'str', reason: 'str?', by: 'str?' },
  // The owner's live view of a browser profile on the node (browser-live.mjs; AGENTIC.md → Browser). screen.req ops:
  // profiles, open (start streaming, url?), stop, nav (action go|back|forward|reload, url?), takeover (on: hold the
  // profile's task actions), sites (cookie domains, never values), clear; answered by screen.res {req, result|error}.
  // screen.input events (mouse, click, key, text) are never logged. screen.frame: one JPEG (base64) of w×h CSS px, n counts them.
  'screen.req': { req: 'str', op: 'str', identity: 'str?', url: 'str?', action: 'str?', on: 'bool?' },
  'screen.res': { req: 'str', result: 'obj?', error: 'str?' },
  'screen.input': { identity: 'str', events: 'arr' },
  'screen.frame': { identity: 'str', n: 'int', data: 'str', w: 'int', h: 'int' },
  'screen.state': { identity: 'str', url: 'str?', title: 'str?', active: 'bool?', takeover: 'bool?', closed: 'bool?', error: 'str?', note: 'str?' },
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
  phase: (v) => PHASES.includes(v),
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
  if (msg.t !== MSG.GIT_CREDENTIAL && msg.t !== MSG.AGENT_CREDENTIAL) {
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
// accept: the only types this side acts on (a worker passes WORKER_ACCEPTS); any other is refused before it is validated,
// as {error, refused: its type}.
export function decode(raw, { from, accept } = {}) {
  const s = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : null;
  if (s == null) return { error: 'frame is not text' };
  if (Buffer.byteLength(s) > MAX_FRAME) return { error: `frame exceeds ${MAX_FRAME} bytes` };
  let msg;
  try { msg = JSON.parse(s); } catch { return { error: 'frame is not JSON' }; }
  if (accept && !accept.includes(msg?.t)) {
    const t = String(msg?.t ?? '(no type)').slice(0, 80);
    return { error: `${JSON.stringify(t)} is not accepted here`, refused: t };
  }
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

// Pairing: the owner gets a short code in the UI (one-time, or for up to MAX_PAIRING_USES machines in one go); each
// worker trades it (POST CLAIM_PATH) for its own node id and a long bearer token. The controller stores only sha256
// hashes of both.
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
