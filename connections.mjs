// Sign-in from the web UI: runs an agent CLI's interactive login inside a detached tmux session on a dedicated
// socket (never the owner's terminals), scrapes the pane for the sign-in URL and one-time code, types back a code the
// owner pastes, and cleans up when the CLI exits, is cancelled, or LOGIN_TIMEOUT passes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const SOCKET = 'agent-orch-login';
export const LOGIN_TIMEOUT = 3 * 60_000;
export const LOGIN_PROMPT_TIMEOUT = 10_000;
const EXIT_RE = /__AO_EXIT:(\d+)/;

// Per-agent login specs. start: argv run in the pane. url/code: regexes (group 1) or functions over the captured pane
// text; url falls back to `defaultUrl`. needsPastedCode: the CLI waits for a code from the browser (POST …/code).
// answers: prompts auto-answered once each with the given keys. pick: [[promptRe, optionRe]] selects that option in a
// clack select menu (see parseMenu). successRe: printed on success (exit 0 counts as
// success too). liveSuccessRe/liveFailRe: end the login while the CLI is still running (a TUI that never exits).
// providers: {id: spec + {label, blurb}} for a harness that signs into one of several accounts (start/logout take a
// provider; logout argv gets the provider id appended). logout: argv, or an async function (home) for a CLI with no logout command; logoutWarning: logout then needs {confirm: true}. Status checks stay with
// their owners (agents.mjs `loggedIn()`; github.mjs `gh.status()`), passed in as each entry's signedIn().
const BIN = path.join(os.homedir(), '.local/bin');
// `opencode auth login` for one provider's subscription method: prints "Go to: <url>", "…enter code: XXXX-XXXX",
// then "Login successful" (exit 0) or "Failed to authorize" (exit 1).
function opencodeLogin(provider, method) {
  return { start: ['opencode', 'auth', 'login', '--provider', provider, '--method', method],
    code: /enter code:\s*([A-Z0-9]+-[A-Z0-9]+)/i, needsPastedCode: false, successRe: /Login successful/ };
}
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
    // agy has no logout subcommand (only the TUI's /logout), so signing out removes its token file.
    logout: agyLogout,
  },
  codex: {
    start: ['codex', 'login', '--device-auth', '-c', 'forced_login_method="chatgpt"'],
    url: /(https:\/\/auth\.openai\.com\/\S+)/,
    code: /one-time code[^\n]*\n\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})/,
    needsPastedCode: false,
    successRe: /successfully logged in/i,
    logout: ['codex', 'logout'],
  },
  // OpenCode has no account of its own: it signs into model providers. Only subscription sign-ins with a headless
  // device flow are offered (agents.mjs OPENCODE_OAUTH); API-key methods, OpenCode Zen and localhost-callback OAuth
  // (GitLab, Poe) are left out. `--provider`/`--method` skip OpenCode's menus; Copilot still asks for GitHub.com.
  opencode: {
    providers: {
      openai: { label: 'ChatGPT', blurb: 'Uses your ChatGPT Plus/Pro plan',
        ...opencodeLogin('openai', 'ChatGPT Pro/Plus (headless)'), url: /Go to:\s*(https:\/\/auth\.openai\.com\/\S+)/ },
      'github-copilot': { label: 'GitHub Copilot', blurb: 'Uses your GitHub Copilot subscription',
        ...opencodeLogin('github-copilot', 'Login with GitHub Copilot'), url: /Go to:\s*(https:\/\/github\.com\/login\/device)/,
        pick: [[/Select GitHub deployment type/, /^GitHub\.com\b/]] },
      xai: { label: 'SuperGrok', blurb: 'Uses your SuperGrok (xAI) subscription',
        ...opencodeLogin('xai', 'SuperGrok Subscription'), url: /Go to:\s*(https:\/\/accounts\.x\.ai\/\S+)/ },
    },
    logout: ['opencode', 'auth', 'logout'],
  },
  kiro: {
    start: [path.join(BIN, 'kiro-cli'), 'login', '--use-device-flow', '--license', 'free'],
    methods: {
      builder: { label: 'Builder ID', args: ['--license', 'free'], menu: 0 },
      google: { label: 'Google', args: ['--license', 'free'], menu: 1 },
      github: { label: 'GitHub', args: ['--license', 'free'], menu: 2 },
      organization: { label: 'Your organization', args: ['--license', 'pro'], menu: 3 },
    },
    url: /(https:\/\/[^\s]+\/\S+)/,
    code: /^Code:\s*([A-Z0-9]+(?:-[A-Z0-9]+)*)/im,
    needsPastedCode: false,
    successRe: /successfully (?:logged in|authenticated)|login successful/i,
    logout: [path.join(BIN, 'kiro-cli'), 'logout'],
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
// Copilot falls back to gh OAuth, so both cards operate on the same credential and account.
SPECS.copilot = { ...SPECS.github, logoutWarning: 'Copilot shares this GitHub login. Disconnecting also signs out GitHub repository access.' };

// agy's TUI breaks the OAuth URL into hard lines; rejoin the lines that are nothing but URL characters.
export function agyUrl(text) {
  const lines = text.split('\n'), i = lines.findIndex((l) => /^\s*https:\/\/accounts\.google\.com\/o\/oauth2\//.test(l));
  if (i < 0) return null;
  let url = lines[i].trim();
  for (let j = i + 1; j < lines.length && /^\s*[\w%&=.+~:/?#-]+\s*$/.test(lines[j]); j++) url += lines[j].trim();
  return url;
}

// A clack select menu (OpenCode's prompts): the open question (◆) and its options, `active` = highlighted (●).
export function parseMenu(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n'), i = lines.findLastIndex((l) => /^\s*◆\s+\S/.test(l));
  if (i < 0) return null;
  const options = [];
  for (const l of lines.slice(i + 1)) {
    const m = l.match(/^\s*│\s+([●○])\s+(.+?)\s*$/);
    if (m) options.push({ label: m[2], active: m[1] === '●' });
    else if (/^\s*└/.test(l)) break;
  }
  return options.length ? { prompt: lines[i].replace(/^\s*◆\s+/, '').trim(), options } : null;
}
// Keys that choose spec.pick[i]'s option in the open menu: [i, keys], or null when no pick applies yet.
export function menuKeys(spec, text) {
  const menu = spec.pick && parseMenu(text);
  if (!menu) return null;
  for (const [i, [promptRe, optionRe]] of spec.pick.entries()) {
    if (!promptRe.test(menu.prompt)) continue;
    const to = menu.options.findIndex((o) => optionRe.test(o.label)), from = menu.options.findIndex((o) => o.active);
    if (to < 0 || from < 0) return null;
    return [i, [...Array(Math.abs(to - from)).fill(to > from ? 'Down' : 'Up'), 'Enter']];
  }
  return null;
}

const grab = (re, text) => (typeof re === 'function' ? re(text) : text.match(re)?.[1]) || null;
const KIRO_METHODS = ['Builder ID', 'Google', 'GitHub', 'Your organization'];
export function kiroMethodPrompt(text) {
  const m = String(text || '').match(/\?\s*Select login method[\s\S]*?(?=\n\s*\n|$)/i);
  if (!m) return null;
  const lines = m[0].split('\n').map((l) => l.trim()).filter(Boolean);
  const highlighted = lines.find((l) => /^[❯>]\s*/.test(l));
  const label = highlighted?.replace(/^[❯>]\s*/, '').replace(/^Use with\s+/i, '').trim();
  const index = KIRO_METHODS.findIndex((x) => label?.toLowerCase().startsWith(x.toLowerCase()));
  return { index, lines: lines.slice(-6).join('\n') };
}
export function kiroMethodKeys(text, target) {
  const p = kiroMethodPrompt(text);
  if (!p || p.index < 0 || !Number.isInteger(target)) return [];
  if (p.index === target) return ['Enter'];
  return ['Down'];
}
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
  const method = spec.methods ? kiroMethodPrompt(text) : null;
  const promptText = genericPrompt(text);
  const ex = text.match(EXIT_RE);
  if (!ex) {
    // A TUI that stays open: its success/failure text ends the login (exitCode stays null).
    const fail = spec.liveFailRe && text.match(spec.liveFailRe);
    if (fail) return { url, code, prompts, exited: true, exitCode: null, ok: false, error: (fail[1] || fail[0]).trim().slice(0, 300) };
    if (spec.liveSuccessRe?.test(text)) return { url, code, prompts, exited: true, exitCode: null, ok: true, error: null };
    return { url, code, prompts, ...(method ? { method } : {}), ...(promptText ? { prompt: promptText } : {}), exited: false, exitCode: null, ok: false, error: null };
  }
  const exitCode = Number(ex[1]);
  const ok = exitCode === 0 || !!spec.successRe?.test(text);
  const before = text.slice(0, ex.index).split('\n').map((l) => l.trim()).filter(Boolean);
  const error = ok ? null : (before.filter((l) => /error|fail|expired|denied|cancel/i.test(l)).pop() || before.pop() || `exited with code ${exitCode}`).slice(0, 300);
  return { url, code, prompts, ...(method ? { method } : {}), ...(promptText ? { prompt: promptText } : {}), exited: true, exitCode, ok, error };
}

export const onPath = (bin, env = process.env) => String(env.PATH || '').split(':').some((d) => {
  try { fs.accessSync(path.join(d || '.', bin), fs.constants.X_OK); return true; } catch { return false; }
});
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const tmuxRunner = (args) => new Promise((resolve) => {
  execFile('tmux', ['-L', SOCKET, ...args], { timeout: 5000 }, (err, out) => resolve({ ok: !err, out: String(out || '') }));
});

// entries: [{id, label, installed(), signedIn(), account?(), detail?(), health?(), probe?(), spec?, envFilter?, afterChange?()}]. detail: extra
// row fields while signed in (OpenCode: {ready, freeModels} for sign-in-free models). health({installed, signedIn, account}):
// the row's `health` (health.mjs healthRow). probe: an
// uncached async sign-in check, run every probeMs while a login waits; true ends it as done (for CLIs whose success
// screen isn't known). onChange(list) fires on every state change (the server broadcasts it). tmux/pollMs/probeMs/
// timeoutMs are injectable for tests.
export function createConnections({ entries, env = process.env, onChange = () => {}, tmux = tmuxRunner, pollMs = 1000, probeMs = 5000, timeoutMs = LOGIN_TIMEOUT, promptTimeoutMs = LOGIN_PROMPT_TIMEOUT }) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const logins = new Map(); // id -> {state, url, code, needsPastedCode, error, startedAt, timer, answered}
  const session = (id) => `login-${id}`;
  // Logins live in memory, so sessions left on the socket by a previous server process are orphans (AUDIT #23).
  const booted = Promise.resolve().then(() => tmux(['kill-server'])).catch(() => {});

  const view = (l) => l && { state: l.state, url: l.url, code: l.code, needsPastedCode: l.needsPastedCode, error: l.error, ...(l.prompt ? { prompt: l.prompt } : {}), startedAt: l.startedAt,
    ...(l.provider ? { provider: l.provider } : {}) };
  const providerSpec = (e, id) => (typeof id === 'string' && Object.hasOwn(e.spec.providers, id) ? e.spec.providers[id] : null);
  // Entries with spec.providers also list them (for the picker) and every signed-in one, from accounts(): [{id, account}].
  function list() {
    return entries.map((e) => {
      let installed = false, signedIn = false, account = null, accounts = [], detail = {};
      try {
        installed = !!e.installed(); signedIn = installed && !!e.signedIn(); account = signedIn ? e.account?.() || null : null;
        if (signedIn && e.spec?.providers) accounts = (e.accounts?.() || []).flatMap((a) => (providerSpec(e, a.id) ? [{ ...a, label: e.spec.providers[a.id].label }] : []));
        if (signedIn) detail = e.detail?.() || {};
        if (e.health) detail.health = e.health({ installed, signedIn, account });
      } catch {}
      return { id: e.id, label: e.label, installed, signedIn, account, canLogin: !!e.spec, canLogout: !!e.spec?.logout,
        ...(e.spec?.providers ? { providers: Object.entries(e.spec.providers).map(([id, p]) => ({ id, label: p.label, blurb: p.blurb })), accounts } : {}),
        ...(e.spec?.logoutWarning ? { logoutWarning: e.spec.logoutWarning } : {}), ...detail, login: view(logins.get(e.id)) || null };
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
      const p = parsePane(l.spec, r.out);
      for (const i of p.prompts) {
        if (l.answered.has(i)) continue;
        l.answered.add(i);
        await tmux(['send-keys', '-t', `=${session(id)}:`, ...l.spec.answers[i][1]]);
      }
      const pick = menuKeys(l.spec, r.out);
      if (pick && !l.answered.has(`pick${pick[0]}`)) {
        l.answered.add(`pick${pick[0]}`);
        await tmux(['send-keys', '-t', `=${session(id)}:`, ...pick[1]]);
      }
      if (p.method && l.methodIndex != null) {
        if (p.method.index === l.methodIndex) {
          if (!l.methodConfirmed) {
            l.methodConfirmed = true;
            await tmux(['send-keys', '-t', `=${session(id)}:`, 'Enter']);
          }
        } else if (p.method.index >= 0) {
          await tmux(['send-keys', '-t', `=${session(id)}:`, 'Down']);
        }
      }
      if (p.exited) return finish(id, p.ok ? 'done' : 'failed', p.error, l);
      if (p.url !== l.url || p.code !== l.code) { l.url = p.url; l.code = p.code; changed(); }
      if (!l.url && !l.code && p.prompt && Date.now() - l.startedAt >= promptTimeoutMs && l.prompt !== p.prompt) {
        l.prompt = p.prompt;
        changed();
      }
      if (e.probe && Date.now() - l.probedAt >= probeMs) {
        l.probedAt = Date.now();
        if (await e.probe().catch(() => false)) return finish(id, 'done', null, l);
      }
    } finally { l.polling = false; }
  }

  // options.provider picks the account for an entry with spec.providers; options.method etc. pick Kiro's login method.
  async function start(id, options = {}) {
    const { provider } = options;
    const e = byId.get(id);
    if (!e) return { status: 404, error: 'No such connection' };
    if (!e.spec) return { status: 400, error: `${e.label} can't be signed in from here yet` };
    const spec = e.spec.providers ? providerSpec(e, provider) : e.spec;
    if (!spec) return { status: 400, error: `Choose what ${e.label} should sign in to: ${Object.keys(e.spec.providers).join(', ')}` };
    if (!e.installed()) return { status: 409, error: `${e.label} is not installed` };
    if (logins.get(id)?.state === 'waiting') return { status: 200, login: view(logins.get(id)) };
    // Strip the API-billing env vars (a login must end on the subscription), and keep the exit status visible.
    const method = e.spec.methods?.[options.method || 'builder'];
    if (e.spec.methods && !method) return { status: 400, error: 'Unknown login method' };
    if (options.method === 'organization' && (!String(options.startUrl || '').startsWith('https://') || !/^[A-Za-z0-9.-]+$/.test(String(options.region || '')))) {
      return { status: 400, error: 'Organization login needs an HTTPS start URL and region' };
    }
    const argv = e.spec.methods ? [path.join(BIN, 'kiro-cli'), 'login', '--use-device-flow', ...method.args,
      ...(options.method === 'organization' ? ['--identity-provider', options.startUrl, '--region', options.region] : [])] : spec.start;
    const unset = e.envFilter ? Object.keys(env).filter((k) => e.envFilter.test(k)) : [];
    const cmd = `${unset.length ? `unset ${unset.join(' ')}; ` : ''}${argv.map(shq).join(' ')}; printf '\\n__AO_EXIT:%s\\n' $?; sleep 3600`;
    // The entry goes in before the first await, so a second start returns it and a cancel can reach it (AUDIT #22).
    const l = { state: 'waiting', url: null, code: null, prompt: null, needsPastedCode: !!spec.needsPastedCode, error: null, startedAt: Date.now(), probedAt: Date.now(),
      answered: new Set(), spec, provider: e.spec.providers ? provider : null, methodIndex: method?.menu, methodConfirmed: false };
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

  async function logout(id, { confirm = false, provider } = {}) {
    const e = byId.get(id);
    if (!e) return { status: 404, error: 'No such connection' };
    if (!e.spec?.logout) return { status: 400, error: `${e.label} can't be signed out from here` };
    if (e.spec.providers && !providerSpec(e, provider)) return { status: 400, error: `Choose which ${e.label} provider to sign out of` };
    const argv = e.spec.providers ? [...e.spec.logout, provider] : e.spec.logout;
    if (e.spec.logoutWarning && confirm !== true) return { status: 409, error: e.spec.logoutWarning, needsConfirm: true };
    const unset = new Set(e.envFilter ? Object.keys(env).filter((k) => e.envFilter.test(k)) : []);
    const r = typeof e.spec.logout === 'function' ? await Promise.resolve().then(() => e.spec.logout()).then(() => ({ ok: true }), (err) => ({ ok: false, err: err.message }))
      : await new Promise((resolve) => execFile(argv[0], argv.slice(1), {
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
// agy's Google login: {token: {access_token, refresh_token, …}, auth_method, id_token} in this one file.
export const agyTokenFile = (home = os.homedir()) => path.join(home, '.gemini/antigravity-cli/antigravity-oauth-token');
export const agyAccount = (home = os.homedir()) => idTokenEmail(agyTokenFile(home), (a) => a.id_token);
export function agyLogout(home = os.homedir()) {
  try { fs.unlinkSync(agyTokenFile(home)); } catch (e) {
    throw new Error(e.code === 'ENOENT' ? 'no Antigravity token file found to remove' : e.message);
  }
}
