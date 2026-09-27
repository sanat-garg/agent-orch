// Sign-in from the web UI: runs an agent CLI's interactive login inside a detached tmux session on a dedicated
// socket (never the owner's terminals), scrapes the pane for the sign-in URL and one-time code, types back a code the
// owner pastes, and cleans up when the CLI exits, is cancelled, or LOGIN_TIMEOUT passes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

export const SOCKET = 'agent-orch-login';
export const LOGIN_TIMEOUT = 3 * 60_000;
export const LOGIN_PROMPT_TIMEOUT = 10_000;
const EXIT_RE = /__AO_EXIT:(\d+)/;

// Per-agent login specs. start: argv run in the pane. url/code: regexes (group 1) or functions over the captured pane
// text; url falls back to `defaultUrl`. needsPastedCode: the CLI waits for a code from the browser (POST …/code).
// answers: prompts auto-answered once each with the given keys. successRe: printed on success (exit 0 counts as
// success too).
// logout: argv; logoutWarning: logout then needs {confirm: true}. Status checks stay with
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
const grab = (re, text) => text.match(re)?.[1] || null;
function genericPrompt(text) {
  const lines = String(text || '').split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const prompt = lines.findIndex((l) => /^\s*\?/.test(l) || /^\s*[❯›>]\s*\S/.test(l) || /\(y\/N\)\s*$/.test(l));
  return prompt < 0 ? null : lines.slice(Math.max(0, lines.length - 12)).join('\n');
}

// What the pane shows so far: {url, code, prompts (indices of `answers` visible), exited, exitCode, ok, error}.
export function parsePane(spec, text) {
  text = String(text || '').replace(/\r/g, '');
  const url = grab(spec.url, text) || spec.defaultUrl || null;
  const code = spec.code ? grab(spec.code, text) : null;
  const prompts = (spec.answers || []).flatMap(([re], i) => (re.test(text) ? [i] : []));
  const promptText = genericPrompt(text);
  const ex = text.match(EXIT_RE);
  if (!ex) return { url, code, prompts, ...(promptText ? { prompt: promptText } : {}), exited: false, exitCode: null, ok: false, error: null };
  const exitCode = Number(ex[1]);
  const ok = exitCode === 0 || !!spec.successRe?.test(text);
  const before = text.slice(0, ex.index).split('\n').map((l) => l.trim()).filter(Boolean);
  const error = ok ? null : (before.filter((l) => /error|fail|expired|denied|cancel/i.test(l)).pop() || before.pop() || `exited with code ${exitCode}`).slice(0, 300);
  return { url, code, prompts, ...(promptText ? { prompt: promptText } : {}), exited: true, exitCode, ok, error };
}

export const onPath = (bin, env = process.env) => String(env.PATH || '').split(':').some((d) => {
  try { fs.accessSync(path.join(d || '.', bin), fs.constants.X_OK); return true; } catch { return false; }
});
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const tmuxRunnerFor = (socket) => (args) => new Promise((resolve) => {
  execFile('tmux', ['-L', socket, ...args], { timeout: 5000 }, (err, out) => resolve({ ok: !err, out: String(out || '') }));
});
export const tmuxRunner = tmuxRunnerFor(SOCKET);

// The tmux subset createConnections uses (new-session, capture-pane, send-keys, kill-session, kill-server), backed by
// `script` (a pty from util-linux or BSD) for machines without tmux (a Mac without Homebrew's tmux). Each session is
// its own process group; the pane is the last 64 KB of output with ANSI escapes stripped.
const KEYS = { Enter: '\r', Escape: '\x1b', Space: ' ', Tab: '\t', BSpace: '\x7f' };
const ANSI_RE = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-B]|[=>78])/g;
export function ptyRunner({ platform = process.platform, script = 'script' } = {}) {
  const sessions = new Map(); // name -> {child, out}
  const target = (args) => String(args[args.indexOf('-t') + 1] || '').replace(/^=/, '').replace(/:.*$/, '');
  const kill = (s) => { try { process.kill(-s.child.pid, 'SIGKILL'); } catch {} };
  return async (args) => {
    const [cmd, ...rest] = args;
    if (cmd === 'kill-server') { for (const s of sessions.values()) kill(s); sessions.clear(); return { ok: true, out: '' }; }
    if (cmd === 'new-session') {
      const name = rest[rest.indexOf('-s') + 1], cwd = rest.includes('-c') ? rest[rest.indexOf('-c') + 1] : os.homedir();
      const x = rest.includes('-x') ? rest[rest.indexOf('-x') + 1] : '250', y = rest.includes('-y') ? rest[rest.indexOf('-y') + 1] : '50';
      const line = `stty cols ${x} rows ${y} 2>/dev/null; ${rest[rest.length - 1]}`;
      const argv = platform === 'darwin' ? ['-q', '/dev/null', 'sh', '-c', line] : ['-qfc', `sh -c ${shq(line)}`, '/dev/null'];
      let child;
      try { child = spawn(script, argv, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch { return { ok: false, out: '' }; }
      const s = { child, out: '', exited: false };
      const add = (d) => { s.out = (s.out + d).slice(-65536); };
      child.stdout.on('data', add); child.stderr.on('data', add);
      child.on('error', () => { s.exited = true; });
      child.on('exit', () => { s.exited = true; });
      child.stdin.on('error', () => {});
      await new Promise((r) => setTimeout(r, 50));
      if (s.exited && !s.out) return { ok: false, out: '' };
      sessions.set(name, s);
      return { ok: true, out: '' };
    }
    const name = target(rest), s = sessions.get(name);
    if (cmd === 'kill-session') { if (s) { kill(s); sessions.delete(name); } return { ok: !!s, out: '' }; }
    if (!s) return { ok: false, out: '' };
    if (cmd === 'capture-pane') return { ok: true, out: s.out.replace(ANSI_RE, '') };
    if (cmd === 'send-keys') {
      const i = rest.indexOf('-t'), keys = rest.filter((_, j) => j !== i && j !== i + 1);
      const literal = keys[0] === '-l';
      const words = literal ? keys.slice(keys[1] === '--' ? 2 : 1) : keys;
      const text = literal ? words.join(' ') : words.map((k) => KEYS[k] ?? k).join('');
      if (s.exited || !s.child.stdin.writable) return { ok: false, out: '' };
      s.child.stdin.write(text);
      return { ok: true, out: '' };
    }
    return { ok: false, out: '' };
  };
}

// entries: [{id, label, installed(), signedIn(), account?(), detail?(), health?(), spec?, envFilter?, afterChange?()}]. detail: extra
// row fields while signed in. health({installed, signedIn, account}):
// the row's `health` (health.mjs healthRow). onChange(list) fires on every state change (the server broadcasts it).
// tmux/pollMs/timeoutMs are injectable for tests.
export function createConnections({ entries, env = process.env, onChange = () => {}, tmux = tmuxRunner, pollMs = 1000, timeoutMs = LOGIN_TIMEOUT, promptTimeoutMs = LOGIN_PROMPT_TIMEOUT }) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const logins = new Map(); // id -> {state, url, code, needsPastedCode, error, startedAt, timer, answered}
  const session = (id) => `login-${id}`;
  // Logins live in memory, so sessions left on the socket by a previous server process are orphans (AUDIT #23).
  const booted = Promise.resolve().then(() => tmux(['kill-server'])).catch(() => {});

  const view = (l) => l && { state: l.state, url: l.url, code: l.code, needsPastedCode: l.needsPastedCode, error: l.error, ...(l.prompt ? { prompt: l.prompt } : {}), startedAt: l.startedAt };
  function list() {
    return entries.map((e) => {
      let installed = false, signedIn = false, account = null, detail = {};
      try {
        installed = !!e.installed(); signedIn = installed && !!e.signedIn(); account = signedIn ? e.account?.() || null : null;
        if (signedIn) detail = e.detail?.() || {};
        if (e.health) detail.health = e.health({ installed, signedIn, account });
      } catch {}
      return { id: e.id, label: e.label, installed, signedIn, account, canLogin: !!e.spec, canLogout: !!e.spec?.logout,
        ...(e.spec?.logoutWarning ? { logoutWarning: e.spec.logoutWarning } : {}), ...detail, login: view(logins.get(e.id)) || null };
    });
  }
  const changed = () => { try { onChange(list()); } catch {} };

  // Acts only on login `l` while it is still the current one, so an orphaned timer can't end a newer login.
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
      const p = parsePane(l.spec, r.out);
      for (const i of p.prompts) {
        if (l.answered.has(i)) continue;
        l.answered.add(i);
        await tmux(['send-keys', '-t', `=${session(id)}:`, ...l.spec.answers[i][1]]);
      }
      if (p.exited) return finish(id, p.ok ? 'done' : 'failed', p.error, l);
      if (p.url !== l.url || p.code !== l.code) { l.url = p.url; l.code = p.code; changed(); }
      if (!l.url && !l.code && p.prompt && Date.now() - l.startedAt >= promptTimeoutMs && l.prompt !== p.prompt) {
        l.prompt = p.prompt;
        changed();
      }
    } finally { l.polling = false; }
  }

  async function start(id) {
    const e = byId.get(id);
    if (!e) return { status: 404, error: 'No such connection' };
    if (!e.spec) return { status: 400, error: `${e.label} can't be signed in from here yet` };
    const spec = e.spec;
    if (!e.installed()) return { status: 409, error: `${e.label} is not installed` };
    if (logins.get(id)?.state === 'waiting') return { status: 200, login: view(logins.get(id)) };
    // Strip the API-billing env vars (a login must end on the subscription), and keep the exit status visible.
    const argv = spec.start;
    const unset = e.envFilter ? Object.keys(env).filter((k) => e.envFilter.test(k)) : [];
    const cmd = `${unset.length ? `unset ${unset.join(' ')}; ` : ''}${argv.map(shq).join(' ')}; printf '\\n__AO_EXIT:%s\\n' $?; sleep 3600`;
    // The entry goes in before the first await, so a second start returns it and a cancel can reach it (AUDIT #22).
    const l = { state: 'waiting', url: null, code: null, prompt: null, needsPastedCode: !!spec.needsPastedCode, error: null, startedAt: Date.now(),
      answered: new Set(), spec };
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
    if (!l.spec.needsPastedCode) return { status: 400, error: `${e.label} doesn't take a pasted code` };
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
    const argv = e.spec.logout;
    if (e.spec.logoutWarning && confirm !== true) return { status: 409, error: e.spec.logoutWarning, needsConfirm: true };
    const unset = new Set(e.envFilter ? Object.keys(env).filter((k) => e.envFilter.test(k)) : []);
    const r = await new Promise((resolve) => execFile(argv[0], argv.slice(1), {
      timeout: 15000, env: Object.fromEntries(Object.entries(env).filter(([k]) => !unset.has(k))),
    }, (err, out, stderr) => resolve({ ok: !err, err: String(stderr || err?.message || '').trim() })));
    try { await e.afterChange?.(); } catch {}
    changed();
    return r.ok ? { status: 200, ok: true } : { status: 500, error: r.err.split('\n').pop() || 'sign-out failed' };
  }

  // A login is in progress (its tmux session on SOCKET must not be reaped).
  const active = () => [...logins.values()].some((l) => l.state === 'waiting');
  return { list, start, submitCode, cancel, logout, active };
}

// The `email` claim of a JSON credential file's id_token (payload decoded locally, never verified or sent anywhere).
function idTokenEmail(file, pick) {
  try {
    const jwt = pick(JSON.parse(fs.readFileSync(file, 'utf8')));
    const claims = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString());
    return typeof claims.email === 'string' && claims.email || null;
  } catch { return null; }
}
// The ChatGPT account email from ~/.codex/auth.json's id_token, when there is one.
export const codexAccount = (home = os.homedir()) => idTokenEmail(path.join(home, '.codex/auth.json'), (a) => a.tokens?.id_token);
