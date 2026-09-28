// Git worktrees for concurrent work tasks. Each task edits its own checkout at
//   <repo>/../.agent-orch-worktrees/<repo name>-task-<id>   on branch agent-orch/task-<id>
// and lands on the main tree's branch only through `mergeBack`: squash, rebase onto the branch, fast-forward.
// Callers serialise everything that touches the main tree (orchestrator `serialGit`, the per-project merge lock).

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { retryGit, transientGit } from './taskrun.mjs';

const execFileP = promisify(execFile);
export const GIT_ID = ['-c', 'user.name=agent-orch Orchestrator', '-c', 'user.email=orchestrator@agent-orch.local'];
export const taskBranch = (id) => `agent-orch/task-${id}`;
// An integrator's branch on a worker (#435): the main branch with the integrated task's branch merged in and resolved.
export const integrateBranch = (id) => `agent-orch/integrate-${id}`;
const BRANCH_RE = /^agent-orch\/task-(\d+)$/;
// Every task appends to JOURNAL.md; a union merge keeps both sides instead of calling that a conflict (here and in a
// worker's cache, where integrators merge).
export const MERGE_ATTRIBUTES = ['.agent-orch/JOURNAL.md merge=union'];

// Other sessions and auto-commits share the main tree, so a lock race or network blip is retried (retryGit; tests may
// set `retryOptions.sleep`). Anything else fails at once, and the last failure is thrown as git reported it.
export const retryOptions = {};
const run = async (cwd, args) => (await execFileP('git', args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 })).stdout;
// A rebase or merge that stopped partway (its state is on disk) is never rerun: a second one would refuse or tangle it.
const RESUMABLE = new Set(['rebase', 'merge', 'cherry-pick', 'am']);
const subcommand = (args) => args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c');
async function midway(cwd) {
  const gitDir = (await run(cwd, ['rev-parse', '--absolute-git-dir']).catch(() => '')).trim();
  return !!gitDir && ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD'].some((d) => fs.existsSync(path.join(gitDir, d)));
}
async function git(cwd, args) {
  let stuck = null;
  try {
    return await retryGit(async () => {
      try { return await run(cwd, args); } catch (e) {
        if (RESUMABLE.has(subcommand(args)) && !args.includes('--abort') && transientGit(e.stderr || e.message) && await midway(cwd)) stuck = e;
        throw stuck ? new Error('stopped midway') : e;
      }
    }, retryOptions);
  } catch (e) { throw stuck || e; }
}
const ok = (cwd, args) => git(cwd, args).then(() => true, () => false);

// The main tree of a project: repo toplevel, its checked-out branch and the project's path inside the repo.
// null when the project isn't in a git repo or HEAD is detached (such projects keep running in the main tree).
export async function repoInfo(projectPath) {
  try {
    const top = fs.realpathSync((await git(projectPath, ['rev-parse', '--show-toplevel'])).trim());
    const branch = (await git(top, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim();
    if (!branch) return null;
    return { top, branch, rel: path.relative(top, fs.realpathSync(projectPath)) };
  } catch { return null; }
}

// `git worktree add` records a worktree's real path, so every path compared with git's list is realpath'd: the root may
// be a symlink (moved to a bigger disk), and a mismatch would make a live worktree look unlisted and get deleted.
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
export const worktreesRoot = (top) => real(path.join(path.dirname(top), '.agent-orch-worktrees'));
export const worktreePath = (top, id) => path.join(worktreesRoot(top), `${path.basename(top)}-task-${id}`);

// Commit everything in `dir` (a worktree or the main tree). Returns the short sha, or '' if there was nothing.
export async function commitAll(dir, message) {
  if (!(await git(dir, ['status', '--porcelain'])).trim()) return '';
  await git(dir, ['add', '-A']);
  await git(dir, [...GIT_ID, 'commit', '-q', '-m', message]);
  return (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim();
}

// Create task `id`'s worktree from the main tree's HEAD, or reuse the one a previous run (or restart) left behind.
// A branch that survived without its worktree (a failed task being retried) is checked out again.
export async function ensureWorktree(info, id) {
  const dir = worktreePath(info.top, id), branch = taskBranch(id);
  const wt = { dir, cwd: path.join(dir, info.rel), branch, reused: false };
  const listed = (await listWorktrees(info.top)).find((w) => w.dir === dir);
  if (listed && fs.existsSync(dir)) {
    await reattach(dir, branch);
    return { ...wt, reused: true };
  }
  await git(info.top, ['worktree', 'prune']);
  if (fs.existsSync(dir)) {
    // A stray directory git no longer knows; one it still has registered holds work and is never deleted.
    if ((await registered(info.top)).includes(dir)) throw new Error(`${dir} is still a registered worktree`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const exists = await ok(info.top, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]);
  await git(info.top, exists ? ['worktree', 'add', '-q', dir, branch] : ['worktree', 'add', '-q', '-b', branch, dir, 'HEAD']);
  await prepareRepo(info.top);
  // Checks need dependencies; node_modules is never tracked, so share the main tree's.
  const nm = path.join(info.top, info.rel, 'node_modules'), wtNm = path.join(wt.cwd, 'node_modules');
  if (fs.existsSync(nm) && !fs.existsSync(wtNm)) { try { fs.symlinkSync(nm, wtNm, 'dir'); } catch {} }
  return wt;
}

// Put a reused worktree back on its task branch. A rebase killed mid-`mergeBack` is aborted; a detached HEAD (or
// another branch) gets its uncommitted work committed and the task branch moved to include it, so nothing is lost.
async function reattach(dir, branch) {
  const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim();
  if (['rebase-merge', 'rebase-apply'].some((d) => fs.existsSync(path.join(gitDir, d)))) await ok(dir, ['rebase', '--abort']);
  if ((await git(dir, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim() === `refs/heads/${branch}`) return;
  await commitAll(dir, `agent-orch: work left off branch ${branch}`);
  const tip = (await git(dir, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`]).catch(() => '')).trim();
  if (tip && !(await ok(dir, ['merge-base', '--is-ancestor', tip, 'HEAD'])) && !(await ok(dir, [...GIT_ID, 'merge', '-q', '--no-edit', tip]))) {
    // The branch moved on separately and won't merge cleanly: keep its old tip under a side branch.
    await ok(dir, ['merge', '--abort']);
    await git(dir, ['branch', '-f', `${branch}-before-${tip.slice(0, 8)}`, tip]);
  }
  await git(dir, ['switch', '-q', '-C', branch]);
}

// Worktree directories git has registered in this repo (whatever they have checked out).
async function registered(top) {
  const out = await git(top, ['worktree', 'list', '--porcelain']).catch(() => '');
  return out.split('\n\n').map((b) => /^worktree (.+)$/m.exec(b)?.[1]).filter(Boolean).map(real);
}

// Repo-local (untracked) settings shared by every worktree: the union merge for JOURNAL.md, and an exclude for the
// node_modules symlink (a `node_modules/` gitignore pattern only matches directories, not a symlink).
async function prepareRepo(top) {
  const common = path.resolve(top, (await git(top, ['rev-parse', '--git-common-dir'])).trim());
  const add = (file, lines) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const missing = lines.filter((l) => !have.split('\n').includes(l));
    if (missing.length) fs.appendFileSync(file, (have && !have.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
  };
  add(path.join(common, 'info', 'attributes'), MERGE_ATTRIBUTES);
  add(path.join(common, 'info', 'exclude'), ['node_modules']);
}

const CONFLICT_RE = /^<{7}(?: |$)[\s\S]*?^>{7}(?: |$)/m;
const markerFiles = (check) => check.split('\n').map((l) => /^(.+?):\d+: leftover conflict marker/.exec(l)?.[1]).filter(Boolean);
// Files that still hold a conflict block: a `<<<<<<< ` line followed later by a `>>>>>>> ` line, checked in files
// unmerged in the index or flagged by `git diff --check`. An agent resolves a file by editing it, without `git add`, so
// the index alone can't tell; a lone `=======` line (a setext heading underline) never counts.
export async function unresolvedFiles(dir) {
  const files = new Set((await git(dir, ['ls-files', '-u'])).split('\n').map((l) => l.split('\t')[1]).filter(Boolean));
  let check = '';
  try { await git(dir, ['diff', 'HEAD', '--check']); } catch (e) { check = e.stdout || ''; }
  for (const f of markerFiles(check)) files.add(f);
  return [...files].filter((f) => {
    try { return CONFLICT_RE.test(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return false; }
  });
}

// The same test on commits: files still holding a conflict block in `tip` among the lines added since `base`. A worker's
// integrator pushes its resolution committed, so neither the index nor the working tree can tell.
export async function markersIn(top, base, tip) {
  let check = '';
  try { await git(top, ['diff', '--check', base, tip]); } catch (e) { check = e.stdout || ''; }
  const left = [];
  for (const f of new Set(markerFiles(check))) if (CONFLICT_RE.test(await git(top, ['show', `${tip}:${f}`]).catch(() => ''))) left.push(f);
  return left;
}

// An integrator's worktree starts by merging the main branch in; the conflicted files are left for the agent.
export async function startIntegration(info, dir) {
  const merging = await ok(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (merging || await ok(dir, ['merge-base', '--is-ancestor', info.branch, 'HEAD'])) return [];
  await commitAll(dir, 'agent-orch: work before integration');
  await ok(dir, [...GIT_ID, 'merge', '--no-ff', '--no-commit', info.branch]);
  return unresolvedFiles(dir);
}

// Land task `id`'s worktree on the main tree's branch: commit what's left, squash to one commit, rebase onto the
// branch and fast-forward the main tree. Returns { sha } ('' when the task changed nothing) or { conflict: [files] }
// (the rebase is aborted and the worktree kept as it was). The caller holds the merge lock.
// Bring the main tree's branch up to date with origin before a merge (a commit the owner pushed from elsewhere, or a
// worker's merge that landed on GitHub first): fetch it and fast-forward; anything else (no origin, diverged) is left
// alone for the owner's protocol. Returns whether the branch moved.
export async function fetchMain(info) {
  if (!(await ok(info.top, ['fetch', '-q', 'origin', info.branch]))) return false;
  const before = (await git(info.top, ['rev-parse', 'HEAD'])).trim();
  if (!(await ok(info.top, ['merge', '-q', '--ff-only', `origin/${info.branch}`]))) return false;
  return (await git(info.top, ['rev-parse', 'HEAD'])).trim() !== before;
}

export async function mergeBack(info, id, message) {
  const dir = worktreePath(info.top, id);
  await commitAll(dir, message);
  const base = (await git(dir, ['merge-base', 'HEAD', info.branch])).trim();
  const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  let changed = head !== base;
  if (changed) {
    await git(dir, ['reset', '-q', '--soft', base]);
    if ((await git(dir, ['diff', '--cached', '--name-only'])).trim()) await git(dir, [...GIT_ID, 'commit', '-q', '-m', message]);
    else changed = false; // its commits cancelled out
    try {
      await git(dir, [...GIT_ID, 'rebase', '-q', info.branch]);
    } catch (e) {
      const conflict = (await git(dir, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean);
      await ok(dir, ['rebase', '--abort']);
      return { conflict: conflict.length ? conflict : [`(rebase failed: ${String(e.stderr || e.message).trim().split('\n').pop()})`] };
    }
    changed = (await git(dir, ['rev-parse', 'HEAD'])).trim() !== (await git(dir, ['rev-parse', info.branch])).trim();
  }
  if (!changed) return { sha: '' };
  await git(info.top, ['merge', '-q', '--ff-only', taskBranch(id)]);
  return { sha: (await git(info.top, ['rev-parse', '--short', 'HEAD'])).trim() };
}

// Remove a task's worktree; `keepBranch` keeps its commits reachable (failed or cancelled work). The directory goes
// too: `git worktree remove` can succeed yet leave ignored leftovers behind (a tool's node_modules/.cache).
export async function removeWorktree(info, id, { keepBranch = false } = {}) {
  const dir = worktreePath(info.top, id);
  await ok(info.top, ['worktree', 'remove', '--force', dir]);
  await ok(info.top, ['worktree', 'prune']);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  if (!keepBranch) await ok(info.top, ['branch', '-D', taskBranch(id)]);
}

// Delete <repo>-task-<id> directories under the worktrees root that git no longer lists, except those of task ids in
// `keep` (running or awaiting integration). Returns the removed ids.
export async function pruneOrphanWorktrees(info, keep = []) {
  const root = worktreesRoot(info.top), prefix = `${path.basename(info.top)}-task-`, keepIds = new Set([...keep].map(Number));
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  await ok(info.top, ['worktree', 'prune']);
  const listed = new Set(await registered(info.top)), removed = [];
  if (!listed.has(info.top)) return []; // git failed to list even the main tree: delete nothing
  for (const name of names) {
    const id = name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)) ? Number(name.slice(prefix.length)) : null;
    const dir = path.join(root, name);
    if (id === null || keepIds.has(id) || listed.has(dir)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(id);
  }
  return removed;
}

// Commit a task's unfinished work to its branch and drop the checkout (the branch stays for a retry).
export async function parkWorktree(info, id, message) {
  const dir = worktreePath(info.top, id);
  if (fs.existsSync(dir)) {
    await ok(dir, ['merge', '--abort']);
    await reattach(dir, taskBranch(id)).catch(() => {});
    await commitAll(dir, message).catch(() => '');
  }
  await removeWorktree(info, id, { keepBranch: true });
}

// Whether task `id`'s branch is already on the main tree's branch (nothing would be lost by deleting it).
export const isMerged = (info, id) => ok(info.top, ['merge-base', '--is-ancestor', taskBranch(id), info.branch]);

// Task worktrees registered in this repo: [{ dir, id }]. Recognised by their task branch, or by their directory
// (<repo>-task-<id> under the worktrees root) whatever HEAD they have (detached by a killed rebase or an agent).
export async function listWorktrees(top) {
  const out = await git(top, ['worktree', 'list', '--porcelain']).catch(() => '');
  const list = [], prefix = `${path.basename(top)}-task-`;
  for (const block of out.split('\n\n')) {
    const listed = /^worktree (.+)$/m.exec(block)?.[1];
    if (!listed) continue;
    const dir = real(listed);
    const m = BRANCH_RE.exec(/^branch refs\/heads\/(.+)$/m.exec(block)?.[1] || '');
    const name = path.basename(dir), byDir = path.dirname(dir) === worktreesRoot(top) && name.startsWith(prefix);
    const id = m ? m[1] : byDir && /^\d+$/.test(name.slice(prefix.length)) ? name.slice(prefix.length) : null;
    if (id) list.push({ dir, id: Number(id) });
  }
  return list;
}
