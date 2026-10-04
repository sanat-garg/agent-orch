// GitHub protocol: every project is a private GitHub repo, and every finished piece of work is
// committed and pushed. Uses the GitHub CLI (`gh`), signed in once by the owner from a terminal.
// `gh` is only needed to create a repo: a folder that already has an `origin` pushes with plain git
// (whatever credentials this machine has), so a gh/network hiccup or a missing gh never blocks it.
// Every push of a branch (main, a task branch) goes through pushBranch: one per repo+branch at a time, retried, never forced.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { transientGit } from './taskrun.mjs';

const GIT_ID = ['-c', 'user.name=agent-orch', '-c', 'user.email=agent-orch@users.noreply.github.com'];

const SHOTS_RULE = '.agent-orch/shots/';
// Keeps secrets and build output out of every repo this creates.
const GITIGNORE = [
  '# Secrets never leave this machine', '.env', '.env.*', '!.env.example', '*.pem', '*.key',
  '', '# Dependencies and build output', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '*.pyc',
  'dist/', 'build/', '.next/', 'coverage/', '*.log', '.DS_Store',
  '', '# Agent screenshots (shown in chat from agent-orch\'s media store)', SHOTS_RULE,
];

const UNPUSHED_WARN_MS = 10 * 60_000;

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 180000, maxBuffer: 20e6, ...opts }, (err, stdout, stderr) => {
    resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() });
  });
});

export function createGitHub({ env, log, alert = () => {}, now = Date.now }) {
  const opts = (cwd) => ({ cwd, env });
  let status = { linked: false, login: null, checkedAt: 0 };

  async function refresh() {
    const r = await run('gh', ['api', 'user', '--jq', '.login'], opts());
    const linked = r.ok && !!r.out;
    if (linked && !status.linked) await run('gh', ['auth', 'setup-git'], opts()); // git push uses the gh sign-in
    status = { linked, login: linked ? r.out : null, checkedAt: Date.now() };
    return status;
  }

  async function ensureLocalRepo(dir) {
    if (!fs.existsSync(path.join(dir, '.git'))) await run('git', ['init', '-q', '-b', 'main'], opts(dir));
    const gi = path.join(dir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, GITIGNORE.join('\n') + '\n');
    else { // older projects: add the screenshots rule before anything commits them
      const cur = fs.readFileSync(gi, 'utf8');
      if (!cur.split('\n').some((l) => l.trim() === SHOTS_RULE)) fs.appendFileSync(gi, `${cur.endsWith('\n') || !cur ? '' : '\n'}${SHOTS_RULE}\n`);
    }
    if (!(await run('git', ['rev-parse', '--verify', 'HEAD'], opts(dir))).ok) {
      await run('git', ['add', '-A'], opts(dir));
      await run('git', [...GIT_ID, 'commit', '-q', '--allow-empty', '-m', 'Project created'], opts(dir));
    }
  }

  async function originUrl(dir) {
    const r = await run('git', ['remote', 'get-url', 'origin'], opts(dir));
    return r.ok && r.out ? r.out : null;
  }
  // The GitHub repo behind an origin, or null when origin isn't on GitHub.
  async function remoteOf(dir) {
    const url = await originUrl(dir);
    return url ? repoOf(url) : null;
  }

  // A private repo named after the folder (with -2, -3… if the name is taken), pushed straight away.
  // Concurrent calls for one dir share a single run, so only one `gh repo create` happens.
  const ensuring = new Map();
  function ensureRepo(dir) {
    if (ensuring.has(dir)) return ensuring.get(dir);
    const p = createRepo(dir).finally(() => ensuring.delete(dir));
    ensuring.set(dir, p);
    return p;
  }
  // An existing origin is returned as is, without asking gh (null when it isn't on GitHub; pushing still works).
  async function createRepo(dir) {
    await ensureLocalRepo(dir);
    const url = await originUrl(dir);
    if (url) return repoOf(url);
    if (!status.linked) await refresh();
    if (!status.linked) throw new Error('GitHub is not linked');
    const base = path.basename(dir).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 90) || 'project';
    let name = base;
    for (let n = 2; (await run('gh', ['repo', 'view', `${status.login}/${name}`, '--json', 'name'], opts())).ok; n++) name = `${base}-${n}`;
    const r = await run('gh', ['repo', 'create', name, '--private', '--source', dir, '--remote', 'origin', '--push'], opts(dir));
    if (!r.ok) throw new Error(r.err.split('\n').pop() || 'could not create the GitHub repo');
    log(`created private GitHub repo ${status.login}/${name}`);
    return { full: `${status.login}/${name}`, url: `https://github.com/${status.login}/${name}` };
  }

  async function unpushed(dir) {
    if (!fs.existsSync(path.join(dir, '.git'))) return 0;
    let r = await run('git', ['rev-list', '--count', '@{u}..HEAD'], opts(dir));
    if (!r.ok) r = await run('git', ['rev-list', '--count', 'HEAD'], opts(dir)); // never pushed yet
    return parseInt(r.out, 10) || 0;
  }

  // Pushes go through pushBranch's per-branch queue (shared with the orchestrator's pushes of main). A failing push sets
  // `warn` only once it has kept failing for UNPUSHED_WARN_MS, or at once when origin diverged (then `alert` is called,
  // once per divergence), so a lock race that the next retry fixes never shows.
  const failingSince = new Map(), diverged = new Set();
  async function push(dir) {
    let repo;
    try { repo = await ensureRepo(dir); } catch (e) { return fail(dir, { error: e.message }); }
    const r = await pushBranch(dir, null, { env, upstream: true });
    if (!r.ok) return fail(dir, { repo, error: r.error, diverged: !!r.diverged });
    failingSince.delete(dir);
    diverged.delete(dir);
    return { ok: true, repo };
  }
  function fail(dir, r) {
    if (!failingSince.has(dir)) failingSince.set(dir, now());
    if (r.diverged && !diverged.has(dir)) { diverged.add(dir); log(`${dir}: ${r.error}`); alert(dir, r.error); }
    return { ok: false, ...r, warn: !!r.diverged || now() - failingSince.get(dir) > UNPUSHED_WARN_MS };
  }

  // Commit whatever changed (if anything) and push.
  async function commitAndPush(dir, message) {
    if (!fs.existsSync(dir)) return { ok: false, error: 'folder is gone' };
    await ensureLocalRepo(dir);
    if ((await run('git', ['status', '--porcelain'], opts(dir))).out) {
      await run('git', ['add', '-A'], opts(dir));
      await run('git', [...GIT_ID, 'commit', '-q', '-m', message.slice(0, 200)], opts(dir));
    }
    return push(dir);
  }

  // The signed-in account's repos (its own and its orgs'), newest push first, for New project → Import from GitHub.
  async function listRepos() {
    if (!status.linked) await refresh();
    if (!status.linked) throw new Error('GitHub is not linked');
    const fields = ['nameWithOwner', 'description', 'isPrivate', 'isFork', 'pushedAt'];
    const r = await run('gh', ['repo', 'list', '--limit', '200', '--json', fields.join(',')], opts());
    if (!r.ok) throw new Error(r.err.split('\n').pop() || 'could not list your GitHub repos');
    const orgs = await run('gh', ['api', 'user/orgs', '--jq', '.[].login'], opts());
    const lists = await Promise.all((orgs.ok ? orgs.out.split('\n').filter(Boolean).slice(0, 10) : []).map((o) =>
      run('gh', ['repo', 'list', o, '--limit', '100', '--json', fields.join(',')], opts()).then((x) => (x.ok ? JSON.parse(x.out) : []))));
    return [JSON.parse(r.out || '[]'), ...lists].flat()
      .map((x) => ({ full: x.nameWithOwner, description: x.description || '', private: !!x.isPrivate, fork: !!x.isFork, pushedAt: x.pushedAt || null }))
      .sort((x, y) => String(y.pushedAt).localeCompare(String(x.pushedAt)));
  }
  // Clones a repo into `dir` (which must not exist): GitHub through gh (private repos use the gh sign-in), any other git url with git.
  async function clone(spec, dir) {
    const full = parseRepoSpec(spec);
    if (!full) throw new Error('Give a GitHub repo as owner/name or its URL');
    const r = full.url
      ? await run('git', ['clone', '-q', full.url, dir], { ...opts(), timeout: 900000 })
      : await run('gh', ['repo', 'clone', full.full, dir, '--', '-q'], { ...opts(), timeout: 900000 });
    if (!r.ok) {
      fs.rmSync(dir, { recursive: true, force: true });
      const why = r.err.split('\n').filter(Boolean).pop() || 'clone failed';
      throw new Error(/not found|could not resolve|repository .* does not exist/i.test(why) ? `Can't find ${full.full || full.url}, or this GitHub account can't see it` : why);
    }
    log(`cloned ${full.full || full.url} into ${dir}`);
    return full.url ? repoOf(full.url) : { full: full.full, url: `https://github.com/${full.full}` };
  }

  return { refresh, status: () => status, ensureRepo, push, commitAndPush, unpushed, remoteOf, listRepos, clone };
}

// What the owner typed to import: owner/name or a GitHub url → {full}; another https/ssh git url → {url, full: null}; else null.
export function parseRepoSpec(spec) {
  const t = String(spec || '').trim().replace(/\/+$/, '');
  const gh = repoOf(t) || repoOf(t.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, 'https://github.com/').replace(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/.*$/, '$1'));
  if (gh) return { full: gh.full };
  if (/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(t) && !/^\.+$/.test(t.split('/')[1])) return { full: t.replace(/\.git$/, '') };
  if (/^(?:https:\/\/|ssh:\/\/|git@)[^\s'"]+$/.test(t) && !t.startsWith('-')) return { url: t, full: null };
  return null;
}
// owner/name of a GitHub remote url: git@github.com:o/r.git, https://github.com/o/r(.git), ssh://git@github.com/o/r.
// Any other host gives null; push() still works for those remotes, it just runs git.
export function repoOf(url) {
  const m = String(url).trim().match(/^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?|[^@/:]+@)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? { full: `${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/${m[2]}` } : null;
}

// ---- Pushes of a branch to origin: one at a time per repo and branch, retried, never forced (task #427).
// Every push of a project's main (a merge's sync, a worker's base) and of a task branch goes through pushBranch: pushes
// of one repo+branch run one at a time, and calls arriving while one runs share ONE follow-up push that takes the
// branch's tip when it starts (so a burst of commits pushes once, at the latest). A lock race ('cannot lock ref'), a
// push rejected because a concurrent push moved origin, a 5xx or a network blip is retried after pushOptions.delays,
// each time after fetching origin's branch: if it is not an ancestor of ours (origin has commits we don't), the push
// stops with { diverged: true } and nothing is forced. Anything else (auth, a missing remote) fails at once.
// Resolves { ok, sha, error?, diverged? } and never rejects. retryGit (taskrun.mjs) doesn't fit: the delays are fixed
// and every retry must re-check origin first.
export const pushOptions = { delays: [2000, 5000, 15000, 60000], sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
const PUSH_RETRY = /\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)|returned error: 5\d\d\b/i;
const pushRetryable = (t) => transientGit(t) || (PUSH_RETRY.test(t) && !/Authentication failed|Permission denied/i.test(t));
const lastLine = (t) => String(t || '').split('\n').filter(Boolean).pop() || 'push failed';
// git's line that says why a push failed (a lock race, a rejection), else its last one.
const pushError = (t) => {
  const lines = String(t || '').split('\n');
  return lines.find((l) => /cannot lock ref/.test(l)) || lines.find((l) => /\[(?:remote )?rejected\]/.test(l))?.trim() || lastLine(t);
};
const queues = new Map(); // `<git common dir>\0<branch>` -> { running, next }

export async function pushBranch(dir, branch = null, { env, force = false, upstream = false } = {}) {
  const g = (args) => run('git', args, { cwd: dir, env });
  const common = await g(['rev-parse', '--git-common-dir']);
  if (!common.ok) return { ok: false, error: lastLine(common.err) };
  branch ||= (await g(['symbolic-ref', '--short', '-q', 'HEAD'])).out;
  if (!branch) return { ok: false, error: 'HEAD is detached: no branch to push' };
  const gitDir = path.resolve(dir, common.out);
  let key;
  try { key = `${fs.realpathSync(gitDir)}\0${branch}`; } catch { key = `${gitDir}\0${branch}`; }
  return enqueue(key, () => pushWithRetry(g, branch, { force, upstream }));
}

function enqueue(key, job) {
  const q = queues.get(key) || { running: null, next: null };
  queues.set(key, q);
  if (q.next) return q.next; // coalesced: the queued push reads the branch's tip only when it starts
  const go = () => {
    const p = job().catch((e) => ({ ok: false, error: lastLine(e?.message) })).finally(() => {
      if (q.running !== p) return;
      q.running = null;
      if (!q.next) queues.delete(key);
    });
    q.running = p;
    return p;
  };
  if (!q.running) return go();
  q.next = q.running.then(() => { q.next = null; return go(); });
  return q.next;
}

async function pushWithRetry(g, branch, { force, upstream }) {
  const local = `refs/heads/${branch}`, tracking = `refs/remotes/origin/${branch}`;
  for (let attempt = 0; ; attempt++) {
    const sha = (await g(['rev-parse', '--verify', '-q', local])).out;
    if (!sha) return { ok: false, error: `no branch ${branch}` };
    const r = await g(['push', '-q', ...(upstream ? ['-u'] : []), 'origin', `${force ? '+' : ''}${local}:refs/heads/${branch}`]);
    if (r.ok) return { ok: true, sha };
    const error = pushError(r.err);
    if (!pushRetryable(r.err) || attempt >= pushOptions.delays.length) return { ok: false, sha, error };
    if (!force && (await g(['fetch', '-q', 'origin', `+refs/heads/${branch}:${tracking}`])).ok
      && !(await g(['merge-base', '--is-ancestor', tracking, local])).ok) {
      const theirs = (await g(['rev-parse', '--short', tracking])).out;
      return { ok: false, sha, diverged: true, error: `origin's ${branch} (${theirs}) has commits this machine doesn't: not pushing (never forced); merge it by hand` };
    }
    await pushOptions.sleep(pushOptions.delays[attempt]);
  }
}

// The newest commit of `branch` a worker cloning from GitHub can start from: `sha` (pushed now through pushBranch) when
// origin has it or the push lands within waitMs, else origin's last known tip when that is an ancestor of `sha` (the
// push catches up in the background; onResult gets its outcome), so starting a task never waits on a push race.
// null when origin has nothing usable.
export async function pushedBase(dir, branch, sha, { env, waitMs = 10_000, onResult = () => {} } = {}) {
  const g = (args) => run('git', args, { cwd: dir, env });
  const tracking = `refs/remotes/origin/${branch}`;
  if ((await g(['merge-base', '--is-ancestor', sha, tracking])).ok) return sha;
  const pushed = pushBranch(dir, branch, { env }).then((r) => { onResult(r); return r; });
  let timer;
  const r = await Promise.race([pushed, new Promise((res) => { timer = setTimeout(res, waitMs, null); })]);
  clearTimeout(timer);
  if (r?.ok && (await g(['merge-base', '--is-ancestor', sha, r.sha])).ok) return sha;
  const known = (await g(['rev-parse', '--verify', '-q', tracking])).out;
  return known && (await g(['merge-base', '--is-ancestor', known, sha])).ok ? known : null;
}
