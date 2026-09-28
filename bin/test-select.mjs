// Which test files a change can affect, so `npm test` (bin/test.mjs) runs those and skips the rest.
// A test depends on every local file it imports or names in a string (a spawned server.mjs, a fixture, a
// bin/ script), followed transitively through those files. A test is affected when one of the changed
// files is among its dependencies or is the test itself. Anything the graph can't see runs everything.
// Browser (playwright) tests run only for changes in public/ or test/; other changes defer them to the full suite.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Changes to how tests run at all.
const EVERYTHING = new Set(['package.json', 'package-lock.json', 'bin/test.mjs', 'bin/test-select.mjs']);
// Notes, docs and images outside test/ and public/: no test reads them.
const inert = (f) => f.startsWith('.agent-orch/') || f.startsWith('.claude/') || f === '.gitignore' ||
  (!/^(test|public)\//.test(f) && /\.(md|txt|png|jpe?g|gif|webp|ico|svg)$/i.test(f));
const REF = /[\w@./-]*[\w-]\.(?:mjs|cjs|js|json|jsonl|sh|css|html)\b/g;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|new URL\(\s*)['"`](\.{1,2}\/[^'"`]+)['"`]/g;
export const isTest = (f) => /^test\/.*\.test\.mjs$/.test(f);

// files: every path in the checkout (plus deleted ones, so references to them still resolve);
// read(path) → its text ('' when missing); changed: paths that differ from the base.
// → { all: true, why } | { tests: [...], changed: [...], deferred: [browser tests left to the full suite] }
export function selectTests({ files, read, changed }) {
  const known = new Set([...files, ...changed]);
  const bySuffix = new Map(); // 'fixtures/x.mjs', 'x.mjs' → paths ending in it
  for (const f of known) {
    const parts = f.split('/');
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(i).join('/');
      if (!bySuffix.has(key)) bySuffix.set(key, []);
      bySuffix.get(key).push(f);
    }
  }
  const texts = new Map();
  const text = (f) => { if (!texts.has(f)) texts.set(f, read(f)); return texts.get(f); };
  const refsMemo = new Map();
  const refs = (f) => {
    if (refsMemo.has(f)) return refsMemo.get(f);
    const out = new Set();
    refsMemo.set(f, out);
    // Test code names what it spawns and loads in plain strings; source code is followed through its imports only
    // (its comments and messages name files it doesn't run).
    const tokens = f.startsWith('test/') ? [...text(f).matchAll(REF)].map((m) => m[0]) : [...text(f).matchAll(IMPORT)].map((m) => m[1]);
    for (const token of tokens) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(f), token));
      if (known.has(rel)) { out.add(rel); continue; }
      if (!f.startsWith('test/')) continue;
      for (const hit of bySuffix.get(token.replace(/^(\.\.?\/)+/, '')) || []) out.add(hit);
    }
    out.delete(f);
    return out;
  };
  const closure = (t) => {
    const seen = new Set([t]);
    const stack = [t];
    while (stack.length) for (const r of refs(stack.pop())) if (!seen.has(r)) { seen.add(r); stack.push(r); }
    return seen;
  };

  const tests = files.filter(isTest).sort();
  const relevant = changed.filter((f) => !inert(f));
  const forcing = relevant.find((f) => EVERYTHING.has(f));
  if (forcing) return { all: true, why: `${forcing} changed` };
  const deps = new Map(tests.map((t) => [t, closure(t)]));
  // Browser tests are the slowest; a server-side change leaves them to the full suite (`npm run test:full`, run by reflection).
  const browser = new Set(tests.filter((t) => /playwright/.test(text(t))));
  const picked = new Set();
  const deferred = new Set();
  for (const c of relevant) {
    const hits = tests.filter((t) => deps.get(t).has(c));
    if (!/^(public|test)\//.test(c)) for (const t of hits.filter((h) => browser.has(h))) { deferred.add(t); hits.splice(hits.indexOf(t), 1); }
    // The server serves public/ as a directory, so no string names each file: browser and static-page tests cover it.
    if (c.startsWith('public/')) hits.push(...tests.filter((t) => /playwright|public\//.test(text(t)) || text(t).includes(path.posix.basename(c))));
    // A fixture directory (panes/, empty-events/) is named by its directory, not its files.
    if (c.startsWith('test/fixtures/')) hits.push(...tests.filter((t) => text(t).includes(c.split('/')[2])));
    if (!hits.length && c.startsWith('test/') && !isTest(c)) return { all: true, why: `${c} changed and no test names it` };
    for (const h of hits) picked.add(h);
  }
  return { tests: [...picked].sort(), changed: relevant, deferred: [...deferred].filter((t) => !picked.has(t)).sort() };
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

// The commit this checkout branched from: the nearest merge-base with the main branch (a task worktree's
// base on the controller, origin/main in a worker's checkout). null outside git or with no main branch.
export function baseCommit(root) {
  const candidates = [process.env.AGENT_ORCH_TEST_BASE, 'main', 'origin/main', 'master', 'origin/master', 'origin/HEAD'].filter(Boolean);
  let best = null;
  for (const ref of candidates) {
    try {
      const sha = git(root, ['merge-base', 'HEAD', ref]).trim();
      const ahead = Number(git(root, ['rev-list', '--count', `${sha}..HEAD`]).trim());
      if (!best || ahead < best.ahead) best = { sha, ahead };
    } catch {}
  }
  return best?.sha || null;
}

// Paths (relative to root) that differ between the base and the working tree, untracked files included,
// plus every path in the checkout. null when git can't tell.
export function checkoutChanges(root) {
  const base = baseCommit(root);
  if (!base) return null;
  try {
    const changed = [
      ...lines(git(root, ['diff', '--name-only', '--no-renames', '--relative', base, '--'])),
      ...lines(git(root, ['ls-files', '--others', '--exclude-standard'])),
    ];
    const files = lines(git(root, ['ls-files', '--cached', '--others', '--exclude-standard']))
      .filter((f) => fs.existsSync(path.join(root, f)));
    return { base, changed: [...new Set(changed)], files };
  } catch { return null; }
}

export function readIn(root) {
  return (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
}
