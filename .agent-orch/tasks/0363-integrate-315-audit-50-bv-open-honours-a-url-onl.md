# Task #363: Integrate #315: AUDIT #50: bv_open honours a url only when the socket may drive

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-28 12:44  
- files: browser-view.mjs, test/browser-live.test.mjs, .agent-orch/AUDIT.md

## Prompt

Task #315 ("AUDIT #50: bv_open honours a url only when the socket may drive") finished in its own git worktree, but its branch `agent-orch/task-315` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #315's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #315's instructions were:

Fix AUDIT.md finding #50 in browser-view.mjs. Today `open(ws, {node, identity, url, thumb})` navigates to `url` right away: on a new session it passes `url` to the `open` op, and when joining an existing session it runs a `nav go` after `s.ready` (line ~92). `bv_nav` and `bv_input` check `canDrive(s, ws)` but `bv_open` does not, so any client can navigate a profile a task is using. Change: on a new session, pass `url` only when no task is active on that profile (use the same source `canDrive`/`assign` use for the task state; if the task state is only known after `open`, navigate after `s.ready` and re-check then); on an existing session, run the `nav go` only if `canDrive(s, ws)` is true at that moment (after `assign(s)` has given this socket its role). Send a `bv_state` with `note: 'A task is using this profile: take over to navigate'` when the url was ignored. Keep the header comment's protocol line accurate. Add a test to test/browser-live.test.mjs (copy its stub-op setup): with a task active on the profile, `bv_open {url}` from a plain viewer produces no `nav` op and no `url` in the `open` op; after `bv_take` (or with no task active) the same `bv_open` does navigate. Mark #50 **Fixed** in .agent-orch/AUDIT.md with a one-line note.

## Done when

`node --test test/browser-live.test.mjs` passes and `grep -n 'Fixed' .agent-orch/AUDIT.md` shows a Fixed line under finding 50

## Result — done (check passed) (2026-09-28 14:06)

AGENT-ORCH-STATUS: done — Merge conflict resolved; browser-live tests pass; #50 marked Fixed
