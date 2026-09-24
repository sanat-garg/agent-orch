// GitHub protocol: every project is a private GitHub repo, and every finished piece of work is
// committed and pushed. Uses the GitHub CLI (`gh`), signed in once by the owner from a terminal.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const GIT_ID = ['-c', 'user.name=Claude Web', '-c', 'user.email=claude-web@users.noreply.github.com'];

// Keeps secrets and build output out of every repo this creates.
const GITIGNORE = [
  '# Secrets never leave this machine', '.env', '.env.*', '!.env.example', '*.pem', '*.key',
  '', '# Dependencies and build output', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '*.pyc',
  'dist/', 'build/', '.next/', 'coverage/', '*.log', '.DS_Store',
];

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 180000, maxBuffer: 20e6, ...opts }, (err, stdout, stderr) => {
    resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() });
  });
});

export function createGitHub({ env, log }) {
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
    if (!(await run('git', ['rev-parse', '--verify', 'HEAD'], opts(dir))).ok) {
      await run('git', ['add', '-A'], opts(dir));
      await run('git', [...GIT_ID, 'commit', '-q', '--allow-empty', '-m', 'Project created'], opts(dir));
    }
  }

  function repoOf(url) {
    const m = String(url).match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
    return m ? { full: m[1], url: `https://github.com/${m[1]}` } : null;
  }
  async function remoteOf(dir) {
    const r = await run('git', ['remote', 'get-url', 'origin'], opts(dir));
    return r.ok ? repoOf(r.out) : null;
  }

  // A private repo named after the folder (with -2, -3… if the name is taken), pushed straight away.
  async function ensureRepo(dir) {
    if (!status.linked) await refresh();
    if (!status.linked) throw new Error('GitHub is not linked');
    await ensureLocalRepo(dir);
    const existing = await remoteOf(dir);
    if (existing) return existing;
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

  // One push at a time per repo; callers arriving mid-push share its result.
  const inflight = new Map();
  function push(dir) {
    if (inflight.has(dir)) return inflight.get(dir);
    const p = (async () => {
      try {
        const repo = await ensureRepo(dir);
        const r = await run('git', ['push', '-u', 'origin', 'HEAD'], opts(dir));
        if (!r.ok) return { ok: false, repo, error: r.err.split('\n').filter(Boolean).pop() || 'push failed' };
        return { ok: true, repo };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })().finally(() => inflight.delete(dir));
    inflight.set(dir, p);
    return p;
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

  return { refresh, status: () => status, ensureRepo, push, commitAndPush, unpushed, remoteOf };
}
