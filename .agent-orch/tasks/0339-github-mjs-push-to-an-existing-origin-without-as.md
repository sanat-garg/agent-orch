# Task #339: github.mjs: push to an existing origin without asking gh; tests with a local bare remote

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:52  
- files: github.mjs, test/github.test.mjs

## Prompt

Reliability fix in github.mjs (read its header). Bug: createRepo() throws 'GitHub is not linked' when `gh api user` fails, BEFORE it checks for an existing `origin` remote, so a transient gh/network failure (or gh missing on a machine that pushes with its own credentials) blocks every push() and commitAndPush() of a repo that was created long ago. Fix: in createRepo, run ensureLocalRepo and remoteOf(dir) first and return the existing remote without touching gh; require the gh sign-in only when a repo must be created. Keep ensureRepo's single-flight and everything else as is. Also make repoOf() accept ssh (`git@github.com:o/r.git`), https with and without `.git`, and `ssh://git@github.com/o/r` forms, and return null for non-GitHub urls (document that push() still works for them: it just calls git). Add tests to test/github.test.mjs (keep the existing one): (1) repoOf on those url forms; (2) with `gh` absent from PATH (env PATH = a temp dir with only git symlinked, or a PATH without gh), a temp repo whose origin is a local bare repo: push() returns {ok:true} and the bare repo has the commit, unpushed() is 0 after and 1 after a new commit; (3) commitAndPush() on a dir that no longer exists returns {ok:false, error:'folder is gone'}; (4) a push that fails (make the bare remote unwritable with chmod 555 or use a non-existent origin path) returns {ok:false} with a one-line error taken from git's last stderr line, not a stack. Use CW_DATA_DIR-style temp dirs under os.tmpdir(); never touch the real GitHub. Run only `node --test test/github.test.mjs` while you work.

## Done when

`node --test test/github.test.mjs` and `grep -q 'remoteOf(dir)' github.mjs`

## Result — done (check passed) (2026-09-28 12:27)

AGENT-ORCH-STATUS: done — existing origins push without gh; repoOf handles all URL forms
