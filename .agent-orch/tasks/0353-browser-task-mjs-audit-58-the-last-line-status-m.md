# Task #353: browser-task.mjs AUDIT #58: the last-line status marker decides a screen prompt's outcome; phrase matching only as a last resort on the final paragraph

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:31  
- files: browser-task.mjs, test/browser-task.test.mjs

## Prompt

Reliability fix in browser-task.mjs (read the file and .agent-orch/AUDIT.md Round 7 finding #58). browserTaskStatus calls any reply containing "I couldn't / can't / was unable to" failed and everything else done. Verified: "I couldn't find a cheaper fare, so I booked the 9:40 flight as you asked." → failed (the owner may book again); "Blocked by a CAPTCHA on the checkout page." → done. Change: (1) BROWSER_TASK_SYSTEM asks the agent to end EVERY final message with one last line `AGENT-ORCH-STATUS: done — <one-line summary>` or `AGENT-ORCH-STATUS: failed — <blocker>` (keep accepting the old `continue` as failed); (2) browserTaskStatus looks for the marker on the LAST non-empty line first (AGENT-ORCH or AO2 prefix, case-insensitive): done → 'done', failed/continue/blocked → 'failed'; only when no marker exists anywhere does the phrase heuristic run, and then only against the final paragraph, and with blocker phrases added ("blocked by", "could not proceed", "sign-in required", "captcha", "nothing was submitted", "I stopped"); a reply that reports both a blocker and a completion in its last paragraph prefers the marker-less 'done' only when the completion phrase ("booked", "sent", "posted", "submitted", "ordered", "saved", "done") comes AFTER the blocker phrase. Also export a `stripStatusMarker(text)` that removes the marker line for display, so the Browser tab can use it later (do not edit public/ or orchestrator.mjs, other tasks hold them; the orchestrator's `fail()` routing is a later task). Update test/browser-task.test.mjs: the five AUDIT #58 sample replies come out right (flight booked → done; retry worked → done; email sent but unconfirmed → done; sign-in stop → failed; CAPTCHA → failed), marker done/failed/continue each win over contradicting prose, and stripStatusMarker removes only the marker line. AUDIT.md is held by other tasks: do not edit it. Verify with `npm test -- test/browser-task.test.mjs`.

## Done when

`npm test -- test/browser-task.test.mjs` passes and `node -e "import('./browser-task.mjs').then(m=>process.exit(m.browserTaskStatus('Blocked by a CAPTCHA on the checkout page.')==='failed'&&m.browserTaskStatus('Checked out.\nAGENT-ORCH-STATUS: done — order placed')==='done'?0:1))"` exits 0
