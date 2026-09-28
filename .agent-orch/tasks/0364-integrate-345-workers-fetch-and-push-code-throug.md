# Task #364: Integrate #345: Workers fetch and push code through the head, so no GitHub access is needed

- kind: work  
- source: planner  
- priority: 95 (normal)  
- created: 2026-09-28 12:45  
- files: cluster-git.mjs, server.mjs, worker.mjs, cluster.mjs, test/cluster-git*.test.mjs

## Prompt

Task #345 ("Workers fetch and push code through the head, so no GitHub access is needed") finished in its own git worktree, but its branch `agent-orch/task-345` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md, orchestrator.mjs). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #345's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #345's instructions were:

Soham's MacBook Air fails every task at the end with `push of agent-orch/task-N failed: … The requested URL returned error: 403`: its gh account can't write to the private repo github.com/sanat-garg/agent-orch. Make workers independent of GitHub credentials: 1) The head serves each project's repo to paired workers over its authenticated HTTPS origin (the existing Caddy → :3000), using git's smart HTTP via `git http-backend` (CGI from node:child_process, no new deps) at /api/cluster/git/<projectId>.git/*, authenticated by the node bearer token (git gets it through an extraheader configured per request, `http.extraHeader=Authorization: Bearer …`, set only in the worker's cache clone config, never globally). Allow fetch of any ref, and push ONLY to refs/heads/agent-orch/task-<id> for tasks currently assigned to that node (a pre-receive check in node). 2) worker.mjs clones/fetches from and pushes WIP/final branches to the head's URL instead of GitHub. The head then merges locally with the existing merge-back and pushes to GitHub itself (it already has the owner's gh login). Keep a fallback: if the head git endpoint is unreachable and the worker has working GitHub access, use GitHub as before. 3) The job.start message carries the head git URL, and the base sha is available from the head's repo (no GitHub round-trip needed). 4) After this lands, retry any tasks that failed or were held with push_failed (e.g. #315, #316, #317) so they re-push through the head. 5) Tests: a fake worker clones through the endpoint with a valid token; fetch with a bad token → 401; a push to its assigned task branch succeeds; a push to main or another task's branch is rejected; the e2e path (worker pushes via the head, and the head merges) works without any GitHub remote. Run only the touched test files.

## Done when

`node --test test/cluster-git*.test.mjs` passes (clone with token, 401 without, push allowed only to the node's own task branch, e2e merge with no GitHub remote)

## Result — done (check passed) (2026-09-28 14:16)

AGENT-ORCH-STATUS: done — Merge conflicts resolved; cluster-git, worker and cluster tests pass

## Result — verify failed (1) (2026-09-28 14:16)

Command: merge main again

main changed meanwhile; conflicts in: .agent-orch/CONTEXT.md

## Result — done (check passed) (2026-09-28 14:16)

I resolved the second conflict in `.agent-orch/CONTEXT.md` and the Done-when check now passes. Main had changed again after the first merge, so this was a fresh conflict. The merged file keeps main's updated line about work tasks, which adds that `retryGit` retries lock races, and #345's placement rule: a project without an https/ssh origin runs only on workers with feature `git`. No conflicted files or conflict markers are left, and `node --test test/cluster-git*.test.mjs` passes all 6 tests.

The merge also brought in main's new code changes in `extensions.mjs`, `worktrees.mjs` and their tests, which merged cleanly. I only re-ran the cluster-git tests after this round, not those files' own tests.

AGENT-ORCH-STATUS: done — CONTEXT.md conflict resolved; cluster-git tests pass
