// A project's commit history: its branch's first-parent log, newest first and paged by `before`, with per-commit
// add/del/file totals, and one commit's message, per-file stat and unified diff capped at maxBytes (on a line boundary,
// like changes.mjs). Read-only: nothing here writes to the repo's index, refs or working tree.
//   projectCommits(top, { branch, before, limit, q }) → { branch, commits: [{ sha, subject, author, at, task, add, del, files }], more }
// `q` (trimmed, ≤ 200 chars) keeps only commits whose message contains it, case-insensitively and literally (--fixed-strings).
//   commitDetail(top, sha, { maxBytes }) → { sha, subject, body, author, at, task, files: [{ path, add, del, binary }], patch, truncated }
// `at` is epoch ms; `task` is N for an 'agent-orch #N:' subject, else null. A bad sha throws with code 400, an unknown
// one with code 404. Served by server.mjs GET /api/orch/projects/:id/commits and /commit; public/commits.js shows it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitCapped, parseNumstat, patchBuilder } from './changes.mjs';

const execFileP = promisify(execFile);
// Merges show their changes against the first parent, matching the --first-parent log.
const DIFF = ['--no-color', '--no-ext-diff', '--no-renames', '--diff-merges=first-parent'];
const SHA = /^[0-9a-f]{4,40}$/i;

async function git(cwd, args) {
  return (await execFileP('git', args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })).stdout;
}
const fail = (code, message) => Object.assign(new Error(message), { code });
const taskOf = (subject) => { const m = /^agent-orch #(\d+):/.exec(subject); return m ? Number(m[1]) : null; };

// A 4–40 hex sha → its full commit sha; 400 when malformed, 404 when no commit (or an ambiguous prefix) matches.
async function resolveSha(top, sha) {
  if (typeof sha !== 'string' || !SHA.test(sha)) throw fail(400, `Not a commit sha: ${String(sha ?? '').slice(0, 64)}`);
  const full = await git(top, ['rev-parse', '--verify', '-q', `${sha}^{commit}`]).then((s) => s.trim(), () => '');
  if (!full) throw fail(404, `No such commit: ${sha}`);
  return full;
}

export async function projectCommits(top, { branch, before, limit = 50, q } = {}) {
  limit = Math.min(200, Math.max(1, Math.floor(Number(limit)) || 50));
  q = typeof q === 'string' ? q.trim().slice(0, 200) : '';
  if (!branch) branch = (await git(top, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
  const empty = { branch, commits: [], more: false };
  let start;
  if (before) {
    // Its first parent onward; a root commit has nothing older.
    start = (await git(top, ['rev-parse', '--verify', '-q', `${await resolveSha(top, before)}^1`]).catch(() => '')).trim();
  } else {
    start = (await git(top, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]).catch(() => '')).trim();
  }
  if (!start) return empty; // no commits yet, or paged past the first one
  const out = await git(top, ['log', '--first-parent', ...DIFF, '--numstat', `-n${limit + 1}`, ...(q ? [`--grep=${q}`, '-i', '--fixed-strings'] : []),
    '--format=%x1e%H%x1f%an%x1f%at%x1f%s', start, '--']);
  const commits = out.split('\x1e').filter(Boolean).map((chunk) => {
    const [head, ...lines] = chunk.split('\n');
    const [sha, author, at, subject = ''] = head.split('\x1f');
    let add = 0, del = 0, files = 0;
    for (const l of lines) {
      const [a, d] = l.split('\t');
      if (d === undefined) continue;
      files++;
      if (a !== '-') { add += Number(a); del += Number(d); }
    }
    return { sha, subject, author, at: Number(at) * 1000, task: taskOf(subject), add, del, files };
  });
  return { branch, commits: commits.slice(0, limit), more: commits.length > limit };
}

export async function commitDetail(top, sha, { maxBytes = 200_000 } = {}) {
  const full = await resolveSha(top, sha);
  const meta = await git(top, ['show', '-s', '--format=%H%x1f%an%x1f%at%x1f%s%x1f%b', full]);
  const [, author, at, subject = '', ...body] = meta.split('\x1f');
  const files = parseNumstat(await git(top, ['show', ...DIFF, '--format=', '--numstat', '-z', full]));
  const out = patchBuilder(maxBytes);
  out.add(await gitCapped(top, ['show', ...DIFF, '--format=', full], maxBytes));
  return { sha: full, subject, body: body.join('\x1f').trim(), author, at: Number(at) * 1000, task: taskOf(subject), files, ...out.done() };
}
