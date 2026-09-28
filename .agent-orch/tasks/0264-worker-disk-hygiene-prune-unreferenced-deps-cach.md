# Task #264: Worker disk hygiene: prune unreferenced deps caches and the npm cache

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-28 04:54  
- files: worker.mjs, test/worker.test.mjs, .agent-orch/CLUSTER.md

## Prompt

worker.mjs keeps one `deps/<lockfile-hash>/node_modules` per lockfile+node version (install()) and an `npm-cache/` dir, and never deletes either; sweepLeftovers() only prunes repos/ caches after 14 idle days. The owner's MacBook Air worker has a nearly full disk (a few GB free of 245 GB) and was auto-drained for it, so this matters. Add a `pruneCaches()` step, called from sweepLeftovers() at start and again after every job finishes (job done/failed/cancelled, once its worktree is removed): 1) delete any deps/<hash> dir that no current worktree's node_modules symlink points at AND whose mtime (touch the dir on every reuse in install()) is older than DEPS_TTL_MS = 3 days; 2) when npm-cache/ is larger than 300 MB (sum file sizes), remove it entirely (npm recreates it). Log one line per removal. Add a test to test/worker.test.mjs: create two fake deps/<hash> dirs (one symlinked from a fake worktree, one stale with an old mtime) and an oversized npm-cache, start the worker, and assert the stale dir and the npm cache are gone while the referenced one stays. Keep worker.mjs compute-only (no new imports of server/orchestrator/cluster). Mention the pruning rule in the worker.mjs header comment and in .agent-orch/CLUSTER.md where the worker home layout is described.

## Done when

`node --test test/worker.test.mjs` passes and `grep -n 'pruneCaches' worker.mjs` prints a match

## Result — done (check passed) (2026-09-28 04:56)

AGENT-ORCH-STATUS: done — Worker now prunes stale deps caches and oversized npm-cache
