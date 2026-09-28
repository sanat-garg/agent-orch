// Concurrent work tasks run in their own git worktrees and merge back: disjoint edits both land, a same-line edit
// becomes 'needs_integration' with an integrator task, worktrees and branches are removed after a merge, and boot
// cleanup parks orphaned worktrees while keeping the ones of interrupted tasks.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureWorktree, listWorktrees, mergeBack, pruneOrphanWorktrees, removeWorktree, repoInfo, startIntegration, unresolvedFiles, worktreePath } from '../worktrees.mjs';

const ORCH = JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A temp repo on branch main with a.txt and b.txt, inside its own parent dir (worktrees go to <parent>/.agent-orch-worktrees).
function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-wt-'))), repo = path.join(root, 'proj');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bee\n');
  fs.mkdirSync(path.join(repo, 'node_modules'));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  return { root, repo };
}

// createOrchestrator in a child process with a fake SDK query(): a prompt line `EDIT <file> <line> <text>` replaces
// that line of <file> in the session's cwd after HOLD ms (so both tasks run at once). An integrator prompt
// ("conflicts with") instead writes RESOLVE's text over a.txt, removing the conflict markers.
// `pre` runs before the orchestrator boots (a CW_NO_ORCHESTRATOR-style instance creates the DB first).
async function scenario(repo, body, pre = '') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-wt-data-'));
  try {
    const script = `import { createOrchestrator } from ${ORCH};
      import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      import path from 'node:path';
      import { execFileSync } from 'node:child_process';
      const [dataDir, repo] = process.argv.slice(1);
      const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
      globalThis.HOLD = 600;
      const cwds = [];
      const query = ({ prompt, options }) => (async function* () {
        cwds.push(options.cwd);
        await new Promise((r) => setTimeout(r, HOLD));
        if (/conflicts with/.test(prompt)) fs.writeFileSync(path.join(options.cwd, 'a.txt'), 'one\\nRESOLVED\\nthree\\n');
        else for (const [, f, n, text] of prompt.matchAll(/^EDIT (\\S+) (\\d+) (\\S+)$/gm)) {
          const file = path.join(options.cwd, f), lines = fs.readFileSync(file, 'utf8').split('\\n');
          lines[Number(n) - 1] = text;
          fs.writeFileSync(file, lines.join('\\n'));
        }
        yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 's-' + Math.random(), num_turns: 1 };
      })();
      const opts = { config: { parallelTasks: 2, agentSlots: 2, meminfo: ${JSON.stringify(new URL('./fixtures/meminfo-ample', import.meta.url).pathname)} }, query, dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true, broadcast() {}, emitChat() {}, convoExists: () => false };
      createOrchestrator({ ...opts, disabled: true });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,created_at) VALUES(?,?,50,'active',0,0)").run(repo, 'proj').lastInsertRowid);
      let created = 0;
      // files: what the task declares it modifies (JSON); undeclared tasks run alone.
      const task = (title, prompt, doneWhen = null, files = null) => Number(db.prepare('INSERT INTO tasks(project_id,title,prompt,priority,urgency,done_when,files,created_at) VALUES(?,?,?,50,?,?,?,?)')
        .run(pid, title, prompt, 'normal', doneWhen, files && JSON.stringify(files), ++created).lastInsertRowid);
      const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      const all = () => db.prepare('SELECT * FROM tasks ORDER BY id').all();
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const until = async (f) => { for (let i = 0; i < 400 && !f(); i++) await sleep(100); };
      ${pre}
      const o = createOrchestrator(opts);
      const out = await (async () => { ${body} })();
      console.log(JSON.stringify(out));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repo], { encoding: 'utf8', timeout: 90000 });
    return JSON.parse(stdout.trim().split('\n').pop());
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('worktrees', { concurrency: true, timeout: 120000 }, () => {
  test('two concurrent tasks editing different files both merge, and their worktrees are cleaned up', async () => {
    const { root, repo } = makeRepo();
    try {
      const r = await scenario(repo, `
        const t1 = task('edit a', 'EDIT a.txt 1 ALPHA', null, ['a.txt']), t2 = task('edit b', 'EDIT b.txt 1 BETA', '\`test -d node_modules\`', ['b.txt']);
        let overlap = false;
        await until(() => { if (get(t1).status === 'running' && get(t2).status === 'running') overlap = true; return get(t1).status === 'done' && get(t2).status === 'done'; });
        return { overlap, statuses: [get(t1).status, get(t2).status], shas: [get(t1).commit_sha, get(t2).commit_sha], cwds,
          worktree: [get(t1).worktree, get(t2).worktree] };`);
      assert.deepEqual(r.statuses, ['done', 'done']);
      assert.ok(r.overlap, 'both tasks ran at the same time');
      assert.equal(r.cwds.length, 2);
      for (const cwd of r.cwds) assert.ok(cwd.startsWith(path.join(root, '.agent-orch-worktrees', 'proj-task-')), cwd);
      assert.notEqual(r.cwds[0], r.cwds[1]);
      // Both edits are on main, one commit per task, in the main tree.
      assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'ALPHA\ntwo\nthree\n');
      assert.equal(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'BETA\n');
      assert.ok(r.shas.every(Boolean));
      const log = git(repo, 'log', '--format=%s', 'main');
      assert.match(log, /agent-orch #1: edit a/);
      assert.match(log, /agent-orch #2: edit b/);
      assert.equal(git(repo, 'status', '--porcelain'), '');
      // Cleanup: no worktrees, no task branches, no directories left behind.
      assert.deepEqual(r.worktree, [null, null]);
      assert.deepEqual(await listWorktrees(repo), []);
      assert.equal(git(repo, 'branch', '--list', 'agent-orch/*'), '');
      assert.deepEqual(fs.readdirSync(path.join(root, '.agent-orch-worktrees')), []);
      // The journal got both entries (union merge, no conflict).
      const journal = fs.readFileSync(path.join(repo, '.agent-orch', 'JOURNAL.md'), 'utf8');
      assert.match(journal, /#1 edit a \[done\]/);
      assert.match(journal, /#2 edit b \[done \(check passed\)\]/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('two tasks editing the same line: the second needs integration, and its integrator merges it', async () => {
    const { root, repo } = makeRepo();
    try {
      const r = await scenario(repo, `
        // The second under-declares its files, so both run at once and collide on a.txt.
        const t1 = task('first', 'EDIT a.txt 2 FIRST', null, ['a.txt']), t2 = task('second', 'EDIT a.txt 2 SECOND', null, ['c.txt']);
        await until(() => all().some((t) => t.status === 'needs_integration'));
        const stuck = all().find((t) => t.status === 'needs_integration');
        const integrator = all().find((t) => t.integrates === stuck.id);
        const at = { stuck: stuck.id, result: stuck.result, worktree: stuck.worktree, kept: !!stuck.worktree && fs.existsSync(stuck.worktree),
          integrator: integrator && { id: integrator.id, status: integrator.status, title: integrator.title } };
        await until(() => all().every((t) => t.status === 'done'));
        return { at, final: all().map((t) => ({ id: t.id, status: t.status, worktree: t.worktree, integrates: t.integrates, result: t.result, err: t.last_error, v: t.verify_output })) };`);
      const { at } = r;
      assert.ok(at.kept, 'the conflicted worktree is kept');
      assert.match(at.result, /conflicts with main in: a\.txt/);
      assert.ok(at.integrator, 'an integrator task was queued');
      assert.match(at.integrator.title, new RegExp(`^Integrate #${at.stuck}`));
      // The integrator resolved it in the same worktree; the original task is done and everything is cleaned up.
      assert.deepEqual(r.final.map((t) => t.status), ['done', 'done', 'done'], JSON.stringify(r.final));
      assert.ok(r.final.every((t) => t.worktree == null));
      assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'one\nRESOLVED\nthree\n');
      assert.deepEqual(await listWorktrees(repo), []);
      assert.equal(git(repo, 'branch', '--list', 'agent-orch/*'), '');
      assert.equal(git(repo, 'status', '--porcelain'), '');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('boot keeps an interrupted task\'s worktree for reuse and parks an orphaned one on its branch', async () => {
    const { root, repo } = makeRepo();
    try {
      const info = await repoInfo(repo);
      const kept = await ensureWorktree(info, 1), orphan = await ensureWorktree(info, 2);
      fs.writeFileSync(path.join(kept.cwd, 'a.txt'), 'interrupted work\n');
      fs.writeFileSync(path.join(orphan.cwd, 'b.txt'), 'orphaned work\n');
      assert.ok(fs.lstatSync(path.join(kept.cwd, 'node_modules')).isSymbolicLink());
      const r = await scenario(repo, `
        await until(() => get(1).status === 'done');
        return { cwds };`, `
        // #1 was running when the server stopped (requeued at boot); #2 was cancelled.
        const t1 = task('resume me', 'EDIT b.txt 1 RESUMED'), t2 = task('gone', 'gone');
        db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(t1);
        db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(t2);`);
      // #1 resumed in its existing worktree, and its earlier edits merged along with the new one.
      assert.deepEqual(r.cwds, [kept.cwd]);
      assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'interrupted work\n');
      assert.equal(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'RESUMED\n');
      // #2's worktree is gone but its work stays on its branch.
      assert.deepEqual(await listWorktrees(repo), []);
      assert.ok(!fs.existsSync(worktreePath(repo, 2)));
      assert.equal(git(repo, 'show', 'agent-orch/task-2:b.txt'), 'orphaned work');
      assert.equal(git(repo, 'branch', '--list', 'agent-orch/task-1'), '');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('a detached-HEAD worktree is re-attached to its branch with its uncommitted work, not deleted', async () => {
    const { root, repo } = makeRepo();
    try {
      const info = await repoInfo(repo);
      const wt = await ensureWorktree(info, 7);
      fs.writeFileSync(path.join(wt.cwd, 'done.txt'), 'committed\n');
      git(wt.dir, 'add', '-A'); git(wt.dir, 'commit', '-qm', 'work');
      git(wt.dir, 'checkout', '-q', '--detach');
      fs.writeFileSync(path.join(wt.cwd, 'wip.txt'), 'uncommitted\n');
      assert.deepEqual((await listWorktrees(repo)).map((w) => w.id), [7]);
      const again = await ensureWorktree(info, 7);
      assert.equal(again.reused, true);
      assert.equal(fs.readFileSync(path.join(wt.cwd, 'wip.txt'), 'utf8'), 'uncommitted\n');
      assert.equal(fs.readFileSync(path.join(wt.cwd, 'done.txt'), 'utf8'), 'committed\n');
      assert.equal(git(wt.dir, 'symbolic-ref', '--short', 'HEAD'), 'agent-orch/task-7');
      assert.equal(git(repo, 'show', 'agent-orch/task-7:wip.txt'), 'uncommitted');
      // A rebase killed mid-mergeBack is aborted and the worktree reused on its branch.
      fs.writeFileSync(path.join(wt.cwd, 'a.txt'), 'one\nmine\nthree\n');
      git(wt.dir, 'commit', '-qam', 'mine');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntheirs\nthree\n');
      git(repo, 'commit', '-qam', 'main moved');
      assert.throws(() => git(wt.dir, 'rebase', '-q', 'main'));
      assert.equal((await ensureWorktree(info, 7)).reused, true);
      assert.equal(git(wt.dir, 'symbolic-ref', '--short', 'HEAD'), 'agent-orch/task-7');
      assert.equal(fs.readFileSync(path.join(wt.cwd, 'a.txt'), 'utf8'), 'one\nmine\nthree\n');
      assert.equal(git(wt.dir, 'status', '--porcelain'), '');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('mergeBack reports a conflict without touching main', async () => {
    const { root, repo } = makeRepo();
    try {
      const info = await repoInfo(repo);
      const wt = await ensureWorktree(info, 7);
      fs.writeFileSync(path.join(wt.cwd, 'a.txt'), 'one\nmine\nthree\n');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntheirs\nthree\n');
      git(repo, 'commit', '-qam', 'main moved');
      const head = git(repo, 'rev-parse', 'HEAD');
      assert.deepEqual(await mergeBack(info, 7, 'task 7'), { conflict: ['a.txt'] });
      assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
      assert.equal(fs.readFileSync(path.join(wt.cwd, 'a.txt'), 'utf8'), 'one\nmine\nthree\n');
      assert.equal(git(wt.dir, 'status', '--porcelain'), ''); // squashed into one commit, rebase aborted
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('removing a worktree deletes its directory even when ignored files were left in it', async () => {
    const { root, repo } = makeRepo();
    try {
      const info = await repoInfo(repo);
      const wt = await ensureWorktree(info, 10);
      fs.rmSync(path.join(wt.cwd, 'node_modules'));
      fs.mkdirSync(path.join(wt.cwd, 'node_modules', '.cache'), { recursive: true });
      fs.writeFileSync(path.join(wt.cwd, 'node_modules', '.cache', 'x'), 'cached');
      await removeWorktree(info, 10);
      assert.equal(fs.existsSync(wt.dir), false);
      assert.deepEqual(await listWorktrees(repo), []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('the sweep deletes an orphan task dir but keeps a live task\'s and one git still lists', async () => {
    const { root, repo } = makeRepo();
    try {
      const info = await repoInfo(repo);
      const listed = await ensureWorktree(info, 11);
      const orphan = worktreePath(info.top, 12), kept = worktreePath(info.top, 13), other = path.join(path.dirname(orphan), 'elsewhere-task-14');
      for (const d of [orphan, kept, other]) { fs.mkdirSync(path.join(d, 'node_modules', '.cache'), { recursive: true }); fs.writeFileSync(path.join(d, 'node_modules', '.cache', 'x'), '1'); }
      assert.deepEqual(await pruneOrphanWorktrees(info, [13]), [12]);
      assert.equal(fs.existsSync(orphan), false);
      assert.ok(fs.existsSync(kept) && fs.existsSync(other) && fs.existsSync(path.join(listed.cwd, 'a.txt')));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('a symlinked worktrees root: a worktree is reused with its work, and the sweep keeps it', async () => {
    const { root, repo } = makeRepo();
    try {
      fs.mkdirSync(path.join(root, 'other'));
      fs.symlinkSync(path.join(root, 'other'), path.join(root, '.agent-orch-worktrees'), 'dir');
      const info = await repoInfo(repo);
      const wt = await ensureWorktree(info, 7);
      fs.writeFileSync(path.join(wt.cwd, 'work.txt'), 'uncommitted\n');
      const again = await ensureWorktree(info, 7);
      assert.equal(again.reused, true);
      assert.equal(fs.readFileSync(path.join(again.cwd, 'work.txt'), 'utf8'), 'uncommitted\n');
      assert.deepEqual((await listWorktrees(repo)).map((w) => w.id), [7]);
      assert.deepEqual(await pruneOrphanWorktrees(info, []), []);
      assert.equal(fs.readFileSync(path.join(root, 'other', 'proj-task-7', 'work.txt'), 'utf8'), 'uncommitted\n');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('a setext ======= heading merged in from main is not an unresolved conflict', async () => {
    const { root, repo } = makeRepo();
    try {
      const info = await repoInfo(repo);
      const wt = await ensureWorktree(info, 8);
      fs.writeFileSync(path.join(wt.cwd, 'a.txt'), 'one\nmine\nthree\n');
      git(wt.cwd, 'commit', '-qam', 'task work');
      fs.writeFileSync(path.join(repo, 'README.md'), 'x\n\nInstall\n=======\n\nrun it\n');
      git(repo, 'add', 'README.md'); git(repo, 'commit', '-qm', 'readme');
      assert.deepEqual(await startIntegration(info, wt.dir), []);
      assert.deepEqual(await unresolvedFiles(wt.dir), []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('a real integration conflict stays unresolved until its markers are removed', async () => {
    const { root, repo } = makeRepo();
    try {
      const info = await repoInfo(repo);
      const wt = await ensureWorktree(info, 9);
      fs.writeFileSync(path.join(wt.cwd, 'a.txt'), 'one\nmine\nthree\n');
      git(wt.cwd, 'commit', '-qam', 'task work');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntheirs\nthree\n');
      fs.writeFileSync(path.join(repo, 'README.md'), 'Install\n=======\n');
      git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'main moved');
      assert.deepEqual(await startIntegration(info, wt.dir), ['a.txt']);
      assert.deepEqual(await unresolvedFiles(wt.dir), ['a.txt']);
      fs.writeFileSync(path.join(wt.cwd, 'a.txt'), 'one\nmine\ntheirs\nthree\n'); // edited, not `git add`ed
      assert.deepEqual(await unresolvedFiles(wt.dir), []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
