// The head's agent sign-ins, shared with its worker machines (agent.credential frames), so no worker needs a sign-in
// of its own (.agent-orch/CLUSTER.md, Security):
//   claude: a long-lived token the owner creates once on the head (Connections → "Claude for your machines" runs
//           `claude setup-token`), kept in <DATA>/agent-share.json (0600). Workers run Claude with
//           CLAUDE_CODE_OAUTH_TOKEN; the head's own login (and its refresh token) never leaves the head.
//   codex:  the head's ~/.codex/auth.json (a ChatGPT login; copying it is how Codex signs in headless machines). Codex
//           refreshes it now and then and the refresh token rotates, so whichever machine refreshes first sends its copy
//           back; the head keeps the newest and re-shares it, so no machine is left holding a used refresh token. A
//           copy is adopted only when its account_id is the head's, its id/access token JWT names that same account,
//           and its last_refresh is newer than ours but not in the future; the replaced file is kept as auth.json.prev
//           (0600) so a bad adoption can be undone by hand.
// Everything here is local file IO; `send(nodeId, frame)` and `targets()` (connected workers that read the frame) come
// from the cluster hub.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A long-lived Claude OAuth token as `claude setup-token` prints it (subscription billing; never an API key).
export const CLAUDE_TOKEN_RE = /\bsk-ant-oat01-[A-Za-z0-9_-]{20,}/;

// A Codex auth.json worth sharing: a ChatGPT login with its tokens (never an API-key login, which bills API credits).
export function parseCodexAuth(text) {
  let j;
  try { j = JSON.parse(String(text || '')); } catch { return null; }
  const t = j?.tokens;
  if (j?.auth_mode !== 'chatgpt' || j.OPENAI_API_KEY || !t?.access_token || !t?.refresh_token || !t?.account_id) return null;
  const at = Date.parse(j.last_refresh || '');
  return { accountId: t.account_id, lastRefresh: Number.isFinite(at) ? at : 0 };
}

// The ChatGPT account a Codex token names: the JWT payload (base64url middle segment; the signature is not checked)
// of tokens.id_token, else tokens.access_token, carries it under "https://api.openai.com/auth".chatgpt_account_id.
function codexTokenAccount(text) {
  let t;
  try { t = JSON.parse(String(text || '')).tokens; } catch { return null; }
  for (const jwt of [t?.id_token, t?.access_token]) {
    try {
      const p = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
      const id = p?.['https://api.openai.com/auth']?.chatgpt_account_id || p?.chatgpt_account_id;
      if (typeof id === 'string' && id) return id;
    } catch {}
  }
  return null;
}

// Atomic write, owner-only.
function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function createAgentShare({ dataDir, home = os.homedir(), send, targets = () => [], log = () => {}, onChange = () => {}, watchMs = 5000 }) {
  const store = path.join(dataDir, 'agent-share.json');
  const codexFile = path.join(home, '.codex', 'auth.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(store, 'utf8')) || {}; } catch {}
  const save = () => writePrivate(store, JSON.stringify(saved));
  const readCodex = () => { try { const text = fs.readFileSync(codexFile, 'utf8'); return parseCodexAuth(text) ? text : null; } catch { return null; } };
  let codexText = readCodex();

  const value = (agent) => (agent === 'claude' ? saved.claude?.token || null : codexText);
  const frame = (agent) => ({ t: 'agent.credential', agent, value: value(agent) });
  // Everything the head shares, to one node (on connect) or to every node (on a change); `except` skips the sender.
  function syncNode(id) { for (const a of ['claude', 'codex']) send(id, frame(a)); }
  function broadcast(agent, except = null) {
    for (const id of targets()) if (id !== except) send(id, frame(agent));
    onChange();
  }

  // Claude: the token `claude setup-token` printed (captured from the Connections session), or null to stop sharing.
  function setClaudeToken(token) {
    if (token != null && !CLAUDE_TOKEN_RE.test(token)) return { status: 400, error: 'That is not a Claude token from `claude setup-token`' };
    if (token == null) delete saved.claude;
    else saved.claude = { token: token.match(CLAUDE_TOKEN_RE)[0], at: Date.now() };
    save();
    log(token == null ? 'stopped sharing Claude with worker machines' : 'sharing Claude with worker machines (long-lived token)');
    broadcast('claude');
    return { ok: true };
  }

  // The head's own Codex login changed (it signed in, out, or refreshed): share the new state.
  function checkCodex() {
    const text = readCodex();
    if (text === codexText) return;
    codexText = text;
    log(text ? 'sharing the Codex sign-in with worker machines' : 'Codex signed out: no longer shared');
    broadcast('codex');
  }
  const timer = setInterval(checkCodex, watchMs);
  timer.unref?.();

  // A worker's Codex copy refreshed itself: keep it if it is the same ChatGPT account (by account_id and by its token)
  // and newer than ours, but not from the future; the file it replaces stays as auth.json.prev.
  function fromWorker(nodeId, msg) {
    if (msg.agent !== 'codex' || !msg.value) return { ignored: 'only a refreshed codex login comes back from a worker' };
    const theirs = parseCodexAuth(msg.value), ours = parseCodexAuth(codexText);
    if (!theirs) return { ignored: 'not a ChatGPT login' };
    if (!ours || theirs.accountId !== ours.accountId) return { ignored: 'a different account than the head\'s' };
    if (theirs.lastRefresh > Date.now() + 5 * 60e3) return { ignored: 'last_refresh is in the future' };
    if (theirs.lastRefresh <= ours.lastRefresh) return { ignored: 'not newer than the head\'s' };
    if (codexTokenAccount(msg.value) !== ours.accountId) return { ignored: 'token does not belong to this account' };
    let prev = null;
    try { prev = fs.readFileSync(codexFile, 'utf8'); } catch {}
    if (prev != null) writePrivate(`${codexFile}.prev`, prev); // auth.json.prev: the login this replaces
    writePrivate(codexFile, msg.value);
    codexText = msg.value;
    log(`adopted the Codex sign-in ${nodeId} refreshed; re-sharing it`);
    broadcast('codex', nodeId);
    return { adopted: true };
  }

  const status = () => ({
    claude: saved.claude ? { shared: true, at: saved.claude.at } : { shared: false },
    codex: { shared: !!codexText },
  });
  return { syncNode, setClaudeToken, fromWorker, checkCodex, status, hasClaude: () => !!saved.claude, close: () => clearInterval(timer) };
}

// The hub side: every enabled worker that reads agent.credential ('creds') gets the shared sign-ins as it connects, and
// a worker's refreshed Codex copy goes to fromWorker. `cluster` is createCluster's hub (which refuses disabled nodes too).
export function wireAgentShare(cluster, share, log = () => {}) {
  return cluster.onMessage((id, msg) => {
    if (msg.t === 'hello' && msg.features?.includes('creds')) { if (cluster.node(id)?.enabled) share.syncNode(id); }
    else if (msg.t === 'agent.credential') {
      const r = share.fromWorker(id, msg);
      if (r.ignored) log(`ignored a codex sign-in from ${id}: ${r.ignored}`);
    }
  });
}
// The enabled workers connected now that read agent.credential.
export const shareTargets = (cluster) => () => cluster.listNodes().filter((n) => !n.local && n.enabled && n.connected && n.features?.includes('creds')).map((n) => n.id);
