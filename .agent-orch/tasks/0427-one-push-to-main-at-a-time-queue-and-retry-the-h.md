# Task #427: One push to main at a time: queue and retry the head's GitHub pushes, never crash a task

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 14:20  
- files: github.mjs, orchestrator.mjs, worktrees.mjs, test/push-queue*.test.mjs

## Prompt

The head's pushes of main to GitHub race each other: 17 times in 2 h the events show `git push -q origin main:refs/heads/main … ! [remote rejected] main -> main (cannot lock ref 'refs/heads/main': is at <sha> but expected <sha>)`, and each time it CRASHED the task being claimed (e.g. '#418 crashed' at 14:19, right after the 'uncommitted changes before #418' commit, while integrator #364's merge push was in flight). Fix it in github.mjs (and its callers in orchestrator.mjs/worktrees.mjs): 1) All pushes of a project's main go through ONE per-project async queue (coalescing: if several pushes are queued, push once at the latest HEAD). 2) Retry transient failures ('cannot lock ref', 'failed to push some refs' with non-fast-forward because of a concurrent push, HTTP 5xx, network errors) with backoff 2 s → 5 s → 15 s → 60 s, fetching and checking each time that origin/main is an ancestor of the local main; if origin moved ahead with commits we don't have (a genuine divergence), stop and raise an owner-visible alert instead of forcing. Never force-push. 3) Pushing is asynchronous and never part of the critical path of claiming/starting a task: the 'uncommitted changes before #N' commit happens locally, the task starts, and the push catches up in the background. A task never crashes because of a push. Surface a sticky warning only if main has been unpushed for more than 10 min. 4) Task-branch pushes (agent-orch/task-*) use the same retry helper (with per-branch queues). Reuse #421's retryGit if it fits. 5) Tests with a local bare remote: two concurrent pushes are serialized and both commits land; a simulated 'cannot lock ref' is retried and succeeds; a claim proceeds even when a push fails; divergence raises the alert without forcing. Run only the touched test files.

## Done when

`node --test test/push-queue*.test.mjs` passes (serialized concurrent pushes, lock-race retry, claim not blocked by push failure, divergence alert without force)

## Result — done (check passed) (2026-09-28 14:27)

AGENT-ORCH-STATUS: done — main and task-branch pushes queue, retry, never force or crash
