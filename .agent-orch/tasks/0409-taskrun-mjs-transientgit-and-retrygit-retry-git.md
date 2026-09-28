# Task #409: taskrun.mjs: transientGit and retryGit retry git ref-lock and network failures with backoff (root cause of #328/#359/#376)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 14:00  
- files: taskrun.mjs, test/git-retry.test.mjs

## Prompt

Three recent tasks failed on transient git errors, not on their work: a worker's setup fetch got `error: cannot lock ref 'refs/remotes/origin/main': is at <sha> but expected <sha>` (the agent's own `git fetch` in a sibling worktree shares the bare cache's refs, so worker.mjs withCache cannot serialise it), and the head's push of main got `! [remote rejected] main -> main (cannot lock ref 'refs/heads/main')` from GitHub (two pushes to main at once). Nothing retries these. Add to taskrun.mjs (node builtins only: worker.mjs imports it and test/compute-only.test.mjs walks the import graph) two exports with header-comment docs: `transientGit(text)` → true for stderr/messages matching: `cannot lock ref`, `Unable to create '.*index.lock'`, `could not lock config file`, `remote rejected .* cannot lock ref`, `failed to lock`, `early EOF`, `RPC failed`, `Connection reset`, `Could not resolve host`, `Connection timed out`, `the remote end hung up unexpectedly`, `fatal: unable to access .* (503|502|429)`; false for conflicts, auth failures (`Authentication failed`, `Permission denied`), non-fast-forward rejections and `couldn't find remote ref`. And `retryGit(fn, {attempts = 4, backoffMs = 400, jitter = true, sleep} = {})` which awaits fn(attempt) and, when it throws an error whose `stderr || message` is transientGit, waits backoffMs * 2^attempt (plus up to 50% jitter) and tries again up to `attempts` times; any other error is rethrown at once; the last failure is rethrown unchanged. Tests in a NEW file test/git-retry.test.mjs (node:test, copy the style of test/runcheck.test.mjs): the matcher's positives and negatives; retryGit retries a fake fn that fails twice with a lock error then succeeds (with sleep stubbed and the delays asserted to grow); rethrows a merge conflict without retrying; gives up after `attempts`. Do NOT edit worker.mjs or orchestrator.mjs (held); the wiring of their git() helpers is a later task. Run only your test file.

## Done when

`npm test -- test/git-retry.test.mjs` passes and `grep -c 'export function retryGit' taskrun.mjs` prints 1
