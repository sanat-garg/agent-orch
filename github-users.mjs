// Users' own GitHub (owner, 2026-10-15): a non-admin connects their GitHub account (Settings → Account → GitHub), and the
// projects they make from then on get their private repo in that account; they can also import their own repos. The
// admin's GitHub (server-wide `gh` sign-in, github.mjs) stays the default for everyone who hasn't connected one.
//   <DATA>/github-users/<uid>/ (0700) is that user's GH_CONFIG_DIR: gh's hosts.yml with their token (plain text, like the
//   admin's gh sign-in on a server without a keyring) and meta.json {login, linkedAt}.
// Connecting: GitHub's device flow (the code is shown in the app, the user approves it on github.com/login/device) with
// the GitHub CLI's own OAuth app, since the token is then used through gh; or a pasted personal access token. Either way
// `gh auth login --with-token` checks and stores it.
// Pushing: a repo made or cloned through a user's instance (gh(uid), a github.mjs instance) carries their git credential
// helper in its own .git/config (bindConfig: an empty value resets the global gh helper, then theirs), so every push and
// fetch there, from the chat, the orchestrator or a task worktree (they share that config), runs as them. Workers reach
// such repos only through the head's git endpoint (cluster-git.mjs). Disconnecting unbinds their folders (unbind).
//   createGitHubUsers({dataDir, env, log, fetch, onChange(uid)}) → { status(uid), startDevice(uid), cancelDevice(uid),
//   linkToken(uid, token), unlink(uid), gh(uid) → github.mjs instance | null, boundUser(dir), unbind(dir) }
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createGitHub, setRepoConfig } from './github.mjs';

export const CLIENT_ID = '178c6fc778ccc68e1d6a'; // the GitHub CLI's OAuth app (what `gh auth login --web` uses)
// gh's own minimum (repo, read:org, gist), plus pushing workflow files and the Delete sheet's "delete the GitHub repo".
export const SCOPES = 'repo read:org gist workflow delete_repo';
const HELPER_KEY = 'credential.https://github.com.helper', USER_KEY = 'agent-orch.github-user';
const UID_RE = /^[\w-]{1,40}$/;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const lastLine = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';

// gh's absolute path on env's PATH (git runs the helper with its own PATH), else plain 'gh'.
function ghPath(env) {
  for (const d of String(env.PATH || '').split(':')) {
    const f = path.join(d || '.', 'gh');
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch {}
  }
  return 'gh';
}
// The .git/config pairs that make a repo push and fetch as the user whose gh config is `dir`.
export const bindConfig = (dir, uid, gh = 'gh') => [[HELPER_KEY, ''], [HELPER_KEY, `!GH_CONFIG_DIR=${shq(dir)} ${shq(gh)} auth git-credential`], [USER_KEY, uid]];

export function createGitHubUsers({ dataDir, env: baseEnv = process.env, log = () => {}, fetch = globalThis.fetch, onChange = () => {}, sleep }) {
  const { GH_TOKEN, GITHUB_TOKEN, ...env } = baseEnv; // a token in the env would win over the user's GH_CONFIG_DIR
  const root = path.join(dataDir, 'github-users');
  const dirOf = (uid) => { if (!UID_RE.test(uid || '')) throw new Error('Bad user id'); return path.join(root, uid); };
  const metaOf = (uid) => { try { return JSON.parse(fs.readFileSync(path.join(dirOf(uid), 'meta.json'), 'utf8')); } catch { return null; } };
  const instances = new Map(); // uid -> github.mjs instance
  const pending = new Map(); // uid -> device flow {code, url, expiresAt, error?, stop}
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));

  function status(uid) {
    const m = metaOf(uid), p = pending.get(uid);
    return { linked: !!m?.login, login: m?.login || null, linkedAt: m?.linkedAt || null,
      ...(p && { pending: { code: p.code, url: p.url, expiresAt: p.expiresAt, error: p.error || null } }) };
  }
  function gh(uid) {
    if (!metaOf(uid)?.login) return null;
    if (!instances.has(uid)) {
      const dir = dirOf(uid), e = { ...env, GH_CONFIG_DIR: dir };
      instances.set(uid, createGitHub({ env: e, log: (m) => log(`${uid}: ${m}`), setupGit: false, repoConfig: bindConfig(dir, uid, ghPath(e)) }));
    }
    return instances.get(uid);
  }

  // Checks and stores a token with gh (it refuses one missing gh's scopes), then reads the account's login.
  async function linkToken(uid, token) {
    token = String(token || '').trim();
    if (!/^[\w-]{20,255}$/.test(token)) throw Object.assign(new Error("That doesn't look like a GitHub token"), { status: 400 });
    const dir = dirOf(uid), tmp = `${dir}.new`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const e = { ...env, GH_CONFIG_DIR: tmp, GH_PROMPT_DISABLED: '1' };
    try {
      const r = await withInput('gh', ['auth', 'login', '--with-token', '--hostname', 'github.com', '--git-protocol', 'https', '--insecure-storage'], token, e);
      if (!r.ok) throw Object.assign(new Error(`GitHub didn't accept that token: ${lastLine(r.err).replace(token, '[token]') || 'unknown error'}`), { status: 400 });
      const who = await execP('gh', ['api', 'user', '--jq', '.login'], e);
      if (!who.ok || !who.out) throw Object.assign(new Error(`Couldn't read the GitHub account: ${lastLine(who.err) || 'no login'}`), { status: 400 });
      fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify({ login: who.out, linkedAt: Date.now() }));
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
    } catch (err) { fs.rmSync(tmp, { recursive: true, force: true }); throw err; }
    instances.delete(uid);
    log(`${uid}: linked GitHub as ${metaOf(uid).login}`);
    onChange(uid);
    return status(uid);
  }

  // GitHub's device flow: returns the code to show; approving it on GitHub links the account in the background.
  async function startDevice(uid) {
    dirOf(uid);
    cancelDevice(uid);
    const r = await post('https://github.com/login/device/code', { client_id: CLIENT_ID, scope: SCOPES });
    if (!r.device_code) throw new Error(r.error_description || r.error || "GitHub didn't start a sign-in");
    const job = { code: r.user_code, url: r.verification_uri || 'https://github.com/login/device', expiresAt: Date.now() + (Number(r.expires_in) || 900) * 1000, stopped: false };
    pending.set(uid, job);
    poll(uid, job, r.device_code, Math.max(Number(r.interval) || 5, 1) * 1000);
    return status(uid);
  }
  async function poll(uid, job, deviceCode, every) {
    const end = (error) => {
      if (pending.get(uid) !== job) return;
      if (error) job.error = error; else pending.delete(uid);
      onChange(uid);
    };
    while (!job.stopped && Date.now() < job.expiresAt) {
      await wait(every);
      if (job.stopped) return;
      let r;
      try { r = await post('https://github.com/login/oauth/access_token', { client_id: CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }); }
      catch { continue; } // offline for a moment: keep asking until the code expires
      if (r.access_token) {
        try { await linkToken(uid, r.access_token); end(); } catch (e) { end(e.message); }
        return;
      }
      if (r.error === 'slow_down') every += 5000;
      else if (r.error && r.error !== 'authorization_pending') return end(r.error === 'access_denied' ? 'The sign-in was cancelled on GitHub' : r.error === 'expired_token' ? 'The code expired: start again' : r.error_description || r.error);
    }
    if (!job.stopped) end('The code expired: start again');
  }
  function cancelDevice(uid) {
    const p = pending.get(uid);
    if (p) { p.stopped = true; pending.delete(uid); }
  }
  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  }

  // Forgets the user's token here (GitHub keeps the authorization until they revoke it in their GitHub settings).
  function unlink(uid) {
    cancelDevice(uid);
    instances.delete(uid);
    fs.rmSync(dirOf(uid), { recursive: true, force: true });
    log(`${uid}: unlinked GitHub`);
    onChange(uid);
  }
  // Which user's GitHub a folder's repo pushes as (null: the admin's).
  async function boundUser(dir) {
    const r = await execP('git', ['config', '--local', '--get', USER_KEY], { ...env }, dir);
    return r.ok && r.out ? r.out : null;
  }
  async function unbind(dir) {
    if (!(await boundUser(dir))) return false;
    await setRepoConfig(dir, [[HELPER_KEY, null], [USER_KEY, null]], env);
    return true;
  }

  return { status, gh, linkToken, startDevice, cancelDevice, unlink, boundUser, unbind };
}

function execP(cmd, args, env, cwd) {
  return new Promise((resolve) => execFile(cmd, args, { env, cwd, timeout: 60000 }, (err, out, stderr) =>
    resolve({ ok: !err, out: String(out || '').trim(), err: String(stderr || err?.message || '') })));
}
function withInput(cmd, args, input, env) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => c.kill('SIGKILL'), 60000);
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', (e) => { clearTimeout(t); resolve({ ok: false, out, err: e.message }); });
    c.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, out, err }); });
    c.stdin.end(input + '\n');
  });
}
