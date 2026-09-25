// Sign-in from the web UI: runs an agent CLI's interactive login inside a detached tmux session on a dedicated
// socket (never the owner's terminals), scrapes the pane for the sign-in URL and one-time code, types back a code the
// owner pastes, and cleans up when the CLI exits, is cancelled, or LOGIN_TIMEOUT passes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const SOCKET = 'agent-orch-login';
export const LOGIN_TIMEOUT = 10 * 60_000;
const EXIT_RE = /__AO_EXIT:(\d+)/;

// Per-agent login specs. start: argv run in the pane. url/code: regexes (group 1) or functions over the captured pane
// text; url falls back to `defaultUrl`. needsPastedCode: the CLI waits for a code from the browser (POST …/code).
// answers: prompts auto-answered once each with the given keys. successRe: printed on success (exit 0 counts as
// success too). liveSuccessRe/liveFailRe: end the login while the CLI is still running (a TUI that never exits).
// logout: argv, when the CLI supports it; logoutWarning: logout then needs {confirm: true}. Status checks stay with
// their owners (agents.mjs `loggedIn()`; github.mjs `gh.status()`), passed in as each entry's signedIn().
const BIN = path.join(os.homedir(), '.local/bin');
export const SPECS = {
  // `claude auth login --claudeai` = the Claude subscription (never --console, which bills API usage). It prints an
  // OAuth URL and waits at "Paste code here if prompted >" for the code the callback page shows.
  claude: {
    start: [path.join(BIN, 'claude'), 'auth', 'login', '--claudeai'],
    url: /(https:\/\/claude\.(?:com|ai)\/\S*oauth\/authorize\S+)/,
    needsPastedCode: true,
    successRe: /Login successful/i,
    logout: [path.join(BIN, 'claude'), 'auth', 'logout'],
    logoutWarning: 'Every chat and orchestrator agent in agent-orch runs on this Claude login. Signing out stops them all until you sign in again.',
  },
  // `agy` with no args: a TUI login menu (Google OAuth first), then a Google OAuth URL the TUI wraps over several
  // lines, then a code field. It never exits on its own, so success/failure are read off the screen.
  antigravity: {
    start: [path.join(BIN, 'agy')],
    url: agyUrl,
    needsPastedCode: true,
    answers: [[/Select login method:[\s\S]*> 1\. Google OAuth/, ['Enter']]],
    liveSuccessRe: /Authentication successful/i,
    liveFailRe: /^\s*(Got an error:.*|Error: authentication interrupted.*)$/m,
  },
  codex: {
    start: ['codex', 'login', '--device-auth', '-c', 'forced_login_method="chatgpt"'],
    url: /(https:\/\/auth\.openai\.com\/\S+)/,
    code: /one-time code[^\n]*\n\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})/,
    needsPastedCode: false,
    successRe: /successfully logged in/i,
    logout: ['codex', 'logout'],
  },
  github: {
    start: ['gh', 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'],
    url: /(https:\/\/github\.com\/login\/device)/,
    defaultUrl: 'https://github.com/login/device',
    code: /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/,
    needsPastedCode: false,
    answers: [[/Authenticate Git with your GitHub credentials\?/i, ['Y', 'Enter']], [/Press Enter to open/i, ['Enter']]],
    successRe: /Logged in as (\S+)|Authentication complete/i,
    logout: ['gh', 'auth', 'logout', '--hostname', 'github.com'],
  },
};

// agy's TUI breaks the OAuth URL into hard lines; rejoin the lines that are nothing but URL characters.
export function agyUrl(text) {
  const lines = text.split('\n'), i = lines.findIndex((l) => /^\s*https:\/\/accounts\.google\.com\/o\/oauth2\//.test(l));
  if (i < 0) return null;
  let url = lines[i].trim();
  for (let j = i + 1; j < lines.length && /^\s*[\w%&=.+~:/?#-]+\s*$/.test(lines[j]); j++) url += lines[j].trim();
  return url;
}

const grab = (re, text) => (typeof re === 'function' ? re(text) : text.match(re)?.[1]) || null;

// What the pane shows so far: {url, code, prompts (indices of `answers` visible), exited, exitCode, ok, error}.
export function parsePane(spec, text) {
  text = String(text || '').replace(/\r/g, '');
  const url = grab(spec.url, text) || spec.defaultUrl || null;
  const code = spec.code ? grab(spec.code, text) : null;
  const prompts = (spec.answers || []).flatMap(([re], i) => (re.test(text) ? [i] : []));
  const ex = text.match(EXIT_RE);
  if (!ex) {
    // A TUI that stays open: its success/failure text ends the login (exitCode stays null).
    const fail = spec.liveFailRe && text.match(spec.liveFailRe);
    if (fail) return { url, code, prompts, exited: true, exitCode: null, ok: false, error: (fail[1] || fail[0]).trim().slice(0, 300) };
    if (spec.liveSuccessRe?.test(text)) return { url, code, prompts, exited: true, exitCode: null, ok: true, error: null };
    return { url, code, prompts, exited: false, exitCode: null, ok: false, error: null };
  }
  const exitCode = Number(ex[1]);
  const ok = exitCode === 0 || !!spec.successRe?.test(text);
  const before = text.slice(0, ex.index).split('\n').map((l) => l.trim()).filter(Boolean);
  const error = ok ? null : (before.filter((l) => /error|fail|expired|denied|cancel/i.test(l)).pop() || before.pop() || `exited with code ${exitCode}`).slice(0, 300);
  return { url, code, prompts, exited: true, exitCode, ok, error };
}

export const onPath = (bin, env = process.env) => String(env.PATH || '').split(':').some((d) => {
  try { fs.accessSync(path.join(d || '.', bin), fs.constants.X_OK); return true; } catch { return false; }
});
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const tmuxRunner = (args) => new Promise((resolve) => {
  execFile('tmux', ['-L', SOCKET, ...args], { timeout: 5000 }, (err, out) => resolve({ ok: !err, out: String(out || '') }));
});

// entries: [{id, label, installed(), signedIn(), account?(), probe?(), spec?, envFilter?, afterChange?()}]. probe: an
// uncached async sign-in check, run every probeMs while a login waits; true ends it as done (for CLIs whose success
// screen isn't known). onChange(list) fires on every state change (the server broadcasts it). tmux/pollMs/probeMs/
// timeoutMs are injectable for tests.
export function createConnections({ entries, env = process.env, onChange = () => {}, tmux = tmuxRunner, pollMs = 1000, probeMs = 5000, timeoutMs = LOGIN_TIMEOUT }) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const logins = new Map(); // id -> {state, url, code, needsPastedCode, error, startedAt, timer, answered}
  const session = (id) => `login-${id}`;
  // Logins live in memory, so sessions left on the socket by a previous server process are orphans (AUDIT #23).
  const booted = Promise.resolve().then(() => tmux(['kill-server'])).catch(() => {});

  const view = (l) => l && { state: l.state, url: l.url, code: l.code, needsPastedCode: l.needsPastedCode, error: l.error, startedAt: l.startedAt };
  function list() {
    return entries.map((e) => {
      let installed = false, signedIn = false, account = null;
      try { installed = !!e.installed(); signedIn = installed && !!e.signedIn(); account = signedIn ? e.account?.() || null : null; } catch {}
      return { id: e.id, label: e.label, installed, signedIn, account, canLogin: !!e.spec, canLogout: !!e.spec?.logout,
        ...(e.spec?.logoutWarning ? { logoutWarning: e.spec.logoutWarning } : {}), login: view(logins.get(e.id)) || null };
    });
  }
  const changed = () => { try { onChange(list()); } catch {} };

  // Acts only on login `l` while it is still the current one, so an orphaned timer or probe can't end a newer login.
  async function finish(id, state, error = null, l = logins.get(id)) {
    if (!l || logins.get(id) !== l || l.state !== 'waiting') return;
    clearInterval(l.timer);
    clearTimeout(l.deadline);
    Object.assign(l, { state, error });
    await tmux(['kill-session', '-t', `=${session(id)}`]);
    try { await byId.get(id).afterChange?.(); } catch {}
    changed();
  }

  async function poll(id, l) {
    const e = byId.get(id);
    if (logins.get(id) !== l || l.state !== 'waiting' || l.polling) return;
    l.polling = true;
    try {
      const r = await tmux(['capture-pane', '-p', '-J', '-S', '-200', '-t', `=${session(id)}:`]);
      if (logins.get(id) !== l || l.state !== 'waiting') return;
      if (!r.ok) return finish(id, 'failed', 'the sign-in session ended unexpectedly', l);
      const p = parsePane(e.spec, r.out);
      for (const i of p.prompts) {
        if (l.answered.has(i)) continue;
        l.answered.add(i);
        await tmux(['send-keys', '-t', `=${session(id)}:`, ...e.spec.answers[i][1]]);
      }
      if (p.exited) return finish(id, p.ok ? 'done' : 'failed', p.error, l);
      if (p.url !== l.url || p.code !== l.code) { l.url = p.url; l.code = p.code; changed(); }
      if (e.probe && Date.now() - l.probedAt >= probeMs) {
        l.probedAt = Date.now();
        if (await e.probe().catch(() => false)) return finish(id, 'done', null, l);
      }
    } finally { l.polling = false; }
  }

  async function start(id) {
    const e = byId.get(id);
    if (!e) return { status: 404, error: 'No such connection' };
    if (!e.spec) return { status: 400, error: `${e.label} can't be signed in from here yet` };
    if (!e.installed()) return { status: 409, error: `${e.label} is not installed` };
    if (logins.get(id)?.state === 'waiting') return { status: 200, login: view(logins.get(id)) };
    // Strip the API-billing env vars (a login must end on the subscription), and keep the exit status visible.
    const unset = e.envFilter ? Object.keys(env).filter((k) => e.envFilter.test(k)) : [];
    const cmd = `${unset.length ? `unset ${unset.join(' ')}; ` : ''}${e.spec.start.map(shq).join(' ')}; printf '\\n__AO_EXIT:%s\\n' $?; sleep 3600`;
    // The entry goes in before the first await, so a second start returns it and a cancel can reach it (AUDIT #22).
    const l = { state: 'waiting', url: null, code: null, needsPastedCode: !!e.spec.needsPastedCode, error: null, startedAt: Date.now(), probedAt: Date.now(), answered: new Set() };
    logins.set(id, l);
    await booted;
    await tmux(['kill-session', '-t', `=${session(id)}`]);
    const r = await tmux(['new-session', '-d', '-s', session(id), '-x', '250', '-y', '50', '-c', os.homedir(), cmd]);
    if (l.state !== 'waiting') { // cancelled while starting: don't leave the new session behind
      if (r.ok) await tmux(['kill-session', '-t', `=${session(id)}`]);
      return { status: 200, login: view(l) };
    }
    if (!r.ok) { logins.delete(id); return { status: 500, error: 'could not start tmux' }; }
    l.timer = setInterval(() => poll(id, l).catch(() => {}), pollMs);
    l.deadline = setTimeout(() => finish(id, 'failed', 'timed out after 10 minutes', l), timeoutMs);
    changed();
    poll(id, l).catch(() => {});
    return { status: 200, login: view(l) };
  }

  async function submitCode(id, code) {
    const l = logins.get(id), e = byId.get(id);
    if (!l || l.state !== 'waiting') return { status: 409, error: 'No sign-in in progress' };
    if (!e.spec.needsPastedCode) return { status: 400, error: `${e.label} doesn't take a pasted code` };
    code = String(code || '').trim();
    if (!code || code.length > 4096 || /[\r\n]/.test(code)) return { status: 400, error: 'Invalid code' };
    // `--` so a code starting with '-' isn't read as tmux flags; no Enter when the code didn't get typed.
    const r = await tmux(['send-keys', '-t', `=${session(id)}:`, '-l', '--', code]);
    if (!r.ok) return { status: 500, error: 'could not send the code to the sign-in session' };
    await tmux(['send-keys', '-t', `=${session(id)}:`, 'Enter']);
    return { status: 200, login: view(l) };
  }

  async function cancel(id) {
    if (!byId.has(id)) return { status: 404, error: 'No such connection' };
    await finish(id, 'cancelled');
    return { status: 200, ok: true, login: view(logins.get(id)) || null };
  }

  async function logout(id, { confirm = false } = {}) {
    const e = byId.get(id);
    if (!e) return { status: 404, error: 'No such connection' };
    if (!e.spec?.logout) return { status: 400, error: `${e.label} can't be signed out from here` };
    if (e.spec.logoutWarning && confirm !== true) return { status: 409, error: e.spec.logoutWarning, needsConfirm: true };
    const unset = new Set(e.envFilter ? Object.keys(env).filter((k) => e.envFilter.test(k)) : []);
    const r = await new Promise((resolve) => execFile(e.spec.logout[0], e.spec.logout.slice(1), {
      timeout: 15000, env: Object.fromEntries(Object.entries(env).filter(([k]) => !unset.has(k))),
    }, (err, out, stderr) => resolve({ ok: !err, err: String(stderr || err?.message || '').trim() })));
    try { await e.afterChange?.(); } catch {}
    changed();
    return r.ok ? { status: 200, ok: true } : { status: 500, error: r.err.split('\n').pop() || 'sign-out failed' };
  }

  return { list, start, submitCode, cancel, logout };
}

// The ChatGPT account email from ~/.codex/auth.json's id_token, when there is one.
export function codexAccount(home = os.homedir()) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(home, '.codex/auth.json'), 'utf8'));
    const jwt = auth.tokens?.id_token;
    const claims = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString());
    return claims.email || null;
  } catch { return null; }
}
