# Task #397: AUDIT ledger round 8: #68 gate loopholes, #69 ungated http connectors, #70 the head ignored a worker's CPU cap

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 13:14  
- starts after: #388, #389, #393  
- files: .agent-orch/AUDIT.md

## Prompt

Append a 'Round 8 (2026-09-28, reflect #379)' section to .agent-orch/AUDIT.md in the existing format (### N. [severity] title (file:lines), a paragraph on the bug, then **Fixed** + a one-line note naming the task, or **Deferred** with why). Verify each against the current code before writing: #68 [med] gate.mjs `classify`: `browser_file_upload` was draft (local files could be uploaded unasked), `browser_mouse_click_xy`/`_drag_xy` were draft (coordinate clicks skipped the element classifier), `javascript:`/`data:` navigation was draft, and `browser_press_key`'s always key was the key name alone; fixed by the gate.mjs task and tested end to end by the proxy test. #69 [low] extensions.mjs `saveMcp` dropped `outbound` for http/sse servers so such a connector ran ungated in task runs; fixed by withholding it from gated runs with a reason; the lasting fix (gate-proxy speaking http upstream) is in ROADMAP Later. #70 [med] orchestrator.mjs `nodeCap` ignored a worker's CPU cap once the owner set max slots (a #311 regression that failed test/worker-cap.test.mjs on main); fixed by the nodeCap task; the RAM part of the local cap is no longer applied by the head by design (BRIEF goal 9), the worker still enforces it. Keep the round's priority note to one line. Do not change any other section.

## Done when

`grep -q '^### 68\. ' .agent-orch/AUDIT.md` && `grep -q '^### 70\. ' .agent-orch/AUDIT.md` && `grep -q 'Round 8' .agent-orch/AUDIT.md`
