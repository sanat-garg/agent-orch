// What a task changed, as a per-file stat and a unified diff capped at maxBytes. Read from its live branch
// (agent-orch/task-<id>, plus whatever its worktree holds uncommitted) or, once merged, from its squash commit(s) on
// the main tree's branch. Read-only: nothing here writes to the repo's index, refs or working trees.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { taskBranch, worktreePath } from './worktrees.mjs';

const execFileP = promisify(execFile);
const DIFF = ['--no-color', '--no-ext-diff', '--no-renames'];

async function git(cwd, args, env) {
  return (await execFileP('git', args, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })).stdout;
}
const ok = (cwd, args) => git(cwd, args).then(() => true, () => false);

// Up to `max` bytes of a git command's stdout; the process is killed once it has written more.
// Resolves { buf, over } (over: it had more to say); rejects when git fails on its own.
function gitCapped(cwd, args, max, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0, over = false, stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.stdout.on('data', (c) => {
      if (over) return;
      chunks.push(c); size += c.length;
      if (size > max) { over = true; child.kill(); }
    });
    child.stderr.on('data', (c) => { if (stderr.length < 4096) stderr += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !over) return reject(new Error(`git ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`));
      resolve({ buf: Buffer.concat(chunks), over });
    });
  });
}

// `git diff --numstat -z` output → [{ path, add, del, binary }] (binary files report '-' counts).
function parseNumstat(out) {
  return out.split('\0').filter(Boolean).map((entry) => {
    const [add, del, ...rest] = entry.split('\t');
    const binary = add === '-';
    return { path: rest.join('\t'), add: binary ? 0 : Number(add), del: binary ? 0 : Number(del), binary };
  });
}

// Sum the stats of several diffs by path, keeping first-seen order.
function mergeStats(lists) {
  const byPath = new Map();
  for (const f of lists.flat()) {
    const have = byPath.get(f.path);
    if (!have) byPath.set(f.path, { ...f });
    else { have.add += f.add; have.del += f.del; have.binary ||= f.binary; }
  }
  return [...byPath.values()];
}

// Collect patch pieces up to maxBytes; a cut lands on a line boundary.
function patchBuilder(maxBytes) {
  const parts = [];
  let used = 0, truncated = false;
  return {
    get left() { return maxBytes - used; },
    get truncated() { return truncated; },
    add({ buf, over }) {
      if (truncated) return;
      if (over || used + buf.length > maxBytes) {
        const room = buf.subarray(0, Math.max(0, maxBytes - used));
        buf = room.subarray(0, room.lastIndexOf(0x0a) + 1);
        truncated = true;
      }
      parts.push(buf); used += buf.length;
    },
    done: () => ({ patch: Buffer.concat(parts).toString('utf8'), truncated }),
  };
}

// The branch's work against where it forked from info.branch. With a live worktree on disk the diff runs against its
// working tree through a throwaway index (a copy of the worktree's with everything added), so uncommitted and
// untracked files count too and the real index is untouched.
async function branchChanges(info, id, maxBytes) {
  const branch = taskBranch(id);
  const base = (await git(info.top, ['merge-base', info.branch, branch])).trim();
  const commits = (await git(info.top, ['rev-list', '--reverse', `${base}..${branch}`])).split('\n').filter(Boolean);
  const dir = worktreePath(info.top, id);
  let live = false;
  if (fs.existsSync(dir)) {
    const top = await git(dir, ['rev-parse', '--show-toplevel']).then((s) => fs.realpathSync(s.trim()), () => '');
    live = top === fs.realpathSync(dir);
  }
  const out = patchBuilder(maxBytes);
  if (!live) {
    const files = parseNumstat(await git(info.top, ['diff', ...DIFF, '--numstat', '-z', base, branch]));
    out.add(await gitCapped(info.top, ['diff', ...DIFF, base, branch], maxBytes));
    return { source: 'branch', commits, files, ...out.done() };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orch-changes-'));
  try {
    const index = path.join(tmp, 'index'), real = path.resolve(dir, (await git(dir, ['rev-parse', '--git-path', 'index'])).trim());
    if (fs.existsSync(real)) fs.copyFileSync(real, index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    await git(dir, ['add', '-A'], env);
    const files = parseNumstat(await git(dir, ['diff', ...DIFF, '--cached', '--numstat', '-z', base], env));
    out.add(await gitCapped(dir, ['diff', ...DIFF, '--cached', base], maxBytes, env));
    return { source: 'branch', commits, files, ...out.done() };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Task `id`'s changes: { source: 'branch'|'commit'|'none', commits: [sha], files: [{ path, add, del, binary }],
// patch, truncated }. A missing branch or commit is 'none'; git failing on a broken repo rejects.
export async function taskChanges(info, id, { maxBytes = 200_000 } = {}) {
  if (await ok(info.top, ['rev-parse', '--verify', '-q', `refs/heads/${taskBranch(id)}`])) return branchChanges(info, id, maxBytes);
  // --grep matches any line of the message, so the subject is checked again here.
  const prefix = `agent-orch #${Number(id)}:`;
  const log = await git(info.top, ['log', '--no-merges', '--reverse', '--format=%H %s', '-E', `--grep=^agent-orch #${Number(id)}:`, info.branch, '--']);
  const commits = log.split('\n').map((l) => l.split(' ')).filter(([, ...s]) => s.join(' ').startsWith(prefix)).map(([sha]) => sha);
  if (!commits.length) return { source: 'none', commits: [], files: [], patch: '', truncated: false };
  const stats = [], out = patchBuilder(maxBytes);
  for (const sha of commits) {
    stats.push(parseNumstat(await git(info.top, ['show', ...DIFF, '--format=', '--numstat', '-z', sha])));
    if (!out.truncated) out.add(await gitCapped(info.top, ['show', ...DIFF, '--format=', sha], out.left));
  }
  return { source: 'commit', commits, files: mergeStats(stats), ...out.done() };
}
