# Task #504: Integrate #500: Browser failover: switch to another machine when one can't open the browser

- kind: work  
- source: planner  
- priority: 95 (normal)  
- created: 2026-09-28 18:57  
- files: browser-view.mjs, browser-live.mjs, browser-task.mjs, orchestrator.mjs, public/browser.js, test/browser-failover*.test.mjs

## Prompt

Task #500 ("Browser failover: switch to another machine when one can't open the browser") finished in its own git worktree, but its branch `agent-orch/task-500` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md, orchestrator.mjs). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #500's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #500's instructions were:

If a machine fails to open or stream the browser, switch automatically to one that can. 1) Live view (browser-view.mjs, browser-live.mjs, public/browser.js): when the viewer's chosen machine fails (the browser launch errors, the CDP attach fails, the node goes offline, or no frame arrives within 15 s of opening), the server picks the next browser-capable online machine (chrome-capable first per #496 if available, then Macs, then the head last), starts or attaches the profile's browser there, and the viewer reconnects to it with a notice 'Switched to <machine>: <reason on the previous one>'. Remember the failed machine for 10 min so it isn't retried immediately, and keep the machine picker for manual override. 2) Browser tasks (browser-task.mjs + placement in orchestrator.mjs): if a browser task's run fails because its browser couldn't start or connect (MCP connect failure, a launch error, a Chrome extension that's unavailable), requeue it pinned to another capable machine (up to 2 switches) instead of failing, with an event '#N moved to <machine>: browser unavailable on <machine>'. Note that profiles are per machine (sign-ins don't transfer); show 'Signed-in sites may differ on <machine>' when switching. 3) Tests: a viewer with no frames for 15 s switches to the second machine; a launch error switches immediately; a browser task whose MCP fails to connect is requeued to another capable node; the failed node is skipped for 10 min. Run only the touched test files.

## Done when

`node --test test/browser-failover*.test.mjs` passes (no-frame switch, launch-error switch, task requeued to another node, failed node skipped)

## Result — done (check passed) (2026-09-28 18:58)

AGENT-ORCH-STATUS: done — Merged main with #500 failover; browser-failover, chrome-runner and placement tests pass

## Result — verify failed (1) (2026-09-28 18:58)

Command: merge main again

main changed meanwhile; conflicts in: .agent-orch/CONTEXT.md

## Result — done (check passed) (2026-09-28 18:58)

AGENT-ORCH-STATUS: done — CONTEXT.md conflict resolved; browser-failover tests pass
