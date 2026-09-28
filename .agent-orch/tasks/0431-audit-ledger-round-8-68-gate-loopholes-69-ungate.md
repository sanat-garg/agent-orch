# Task #431: AUDIT ledger round 8: #68 gate loopholes, #69 ungated http connectors, #70 the head ignored a worker's CPU cap

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 14:20  
- starts after: #428  
- files: .agent-orch/AUDIT.md

## Prompt

Append a 'Round 8 (2026-09-28, reflect #379)' section to .agent-orch/AUDIT.md in the existing format (### N. [severity] title (file:lines), a paragraph on the bug, then **Fixed** + a one-line note naming the task and commit, or **Deferred** with why). Verify each against the current code (`git log --oneline -40` and the modules) before writing: #68 [med] gate.mjs `classify`: `browser_file_upload` was draft (local files could be uploaded unasked), `browser_mouse_click_xy`/`_drag_xy` were draft (coordinate clicks skipped the element classifier), `javascript:`/`data:` navigation was draft, and `browser_press_key`'s Always key was the key name alone; fixed by the gate.mjs re-run task that this task follows (find its commit with `git log --oneline -- gate.mjs`), tested by test/gate-classify.test.mjs; note that an end-to-end proxy test with the fake browser MCP is still to come (ROADMAP Later). #69 [low] extensions.mjs `saveMcp` dropped `outbound` for http/sse servers so such a connector ran ungated in task runs; fixed in three steps: #393 kept the outbound list and withheld the connector from gated runs, #412 taught gate-proxy.mjs a streamable-http upstream, #420 routes http connectors with outbound tools through the proxy (`upstream: {url, headers}`); only sse (a transport the proxy does not speak) is still withheld, which is the deferred remainder. #70 [med] orchestrator.mjs `nodeCap` ignored a worker's CPU cap once the owner set max slots (a #311 regression that failed test/worker-cap.test.mjs on main); fixed by #388; the RAM part of the local cap is no longer applied by the head by design (BRIEF goal 9), the worker still enforces it. Keep the round's priority note to one line. Also mark, in place, round 7's #61 (fixed by the retention task that keeps pending approval screenshots; check `git log --oneline -- retention.mjs approvals.mjs`) and #63 as **Fixed (head half)** by #422 (browser-tasks/ swept by gcRetention; the worker half stays open), each with a one-line note, only where the code confirms it. Do not change any other section.

## Done when

`grep -q '^### 68\. ' .agent-orch/AUDIT.md` && `grep -q '^### 70\. ' .agent-orch/AUDIT.md` && `grep -q 'Round 8' .agent-orch/AUDIT.md`
