# Task #398: Integrate #381: oracle-vm node in the Machines graph opens the full server details

- kind: work  
- source: planner  
- priority: 60 (normal)  
- created: 2026-09-28 13:16  
- files: public/app.js, public/app.css, public/index.html, test/ui-machines*.test.mjs, test/ui-static.test.mjs

## Prompt

Task #381 ("oracle-vm node in the Machines graph opens the full server details") finished in its own git worktree, but its branch `agent-orch/task-381` conflicts with `main`, which changed meanwhile (conflicting files: public/index.html). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #381's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #381's instructions were:

In the Machines view's cluster diagram (public/app.js, from #223/#231), clicking a worker node opens its detail, but clicking the head 'oracle-vm' (the controller node) doesn't show this server's usage, which lives separately in the Server details window (#serverModal: device info, CPU/RAM/disk/network charts, the Processes panel, cleanup). Unify them: clicking oracle-vm opens the SAME node-detail window as workers, and its content is the full server details (move the #serverModal content into a reusable renderServerDetails(container) and mount it in the controller's node detail; the charts and live refresh keep working there). Workers' node details keep their telemetry charts and phases, laid out to match the head's (same section order and chart styles: CPU, memory, disk, network, running tasks, processes if available). Anything that used to open #serverModal (the sidebar card click, links) now opens the oracle-vm node detail; remove the duplicate modal markup once nothing uses it. Update the static UI test ids. Test: clicking the controller node renders the server charts inside the node detail; the old entry points open it. Run only the touched test files.

## Done when

`node --test test/ui-static.test.mjs test/ui-machines*.test.mjs` passes, and a UI test shows that clicking the oracle-vm node renders the server CPU/RAM charts in the node detail

## Result — done (check passed) (2026-09-28 14:28)

I resolved both merge conflicts, and the test files named in the Done-when check pass: 26 of 26.

- **`public/index.html`:** I kept #381's version, where the old modal body is gone and `#ndBody` holds the reusable `#serverDetails`. Main's change was a new "Ping all" button next to "Add machine" in the Machines header, and I carried that over into the moved `#serverDetails` markup. `app.js` merged without conflicts and its `pingAll` handlers still find the button.
- **`.agent-orch/CONTEXT.md`:** I kept main's expanded gate note and its shorter `public/` line, and added #381's note that there is no Server details modal any more.

`test/ui-machines.test.mjs` includes the test showing that clicking the controller node draws live CPU and memory charts inside the node detail. Both files are staged and the merge is left uncommitted.

AGENT-ORCH-STATUS: done — Merge resolved, Ping all kept, machines UI tests pass

## Result — verify failed (1) (2026-09-28 14:28)

Command: merge main again

main changed meanwhile; conflicts in: .agent-orch/CONTEXT.md

## Result — done (check passed) (2026-09-28 14:29)

AGENT-ORCH-STATUS: done — CONTEXT.md conflict resolved; UI and Machines tests pass
