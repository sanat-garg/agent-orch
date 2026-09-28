# Task #383: Bring back 'Keep improving' per project; off means no reflection at all

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 13:00  
- files: orchestrator.mjs, public/app.js, public/index.html, test/keep-improving*.test.mjs

## Prompt

The owner wants the 'Keep improving' toggle back in Settings, per project. When it's off, that project must never reflect again until it's switched back on. Current state: the UI toggle (#obPerpetual) was removed; orchestrator.mjs (~lines 995-998) has a one-time migration 'perpetual_always' that forced projects.perpetual=1 with the comment 'Keep improving was removed…'; the scheduling loops at ~2580/2587 already select only perpetual=1 projects; PATCH of project fields accepts 'perpetual' (~line 3545). Do: 1) UI: in the Settings sheet's 'This project' section, add a 'Keep improving' switch with the hint 'When the queue runs low, look at the project and queue the next most valuable steps', bound to projects.perpetual via the existing project PATCH, with the state shown live over the WebSocket. Update the comment at ~line 995 to say the toggle is back, and leave the one-time migration as-is (it already ran) without re-running it. 2) Off really means off, so audit EVERY path that creates or runs reflect tasks for a project and gate it on perpetual: the empty-queue reflection, the rapid-mode top-up (~2576-2607), post-failure/verdict reflections, finishReflection's quick retry when a reflection returned no task block (#286), review/integration follow-ups that spawn reflections, and any manual 'Reflect now' (that one may stay allowed as an explicit owner action, but label it). 3) When toggled off: cancel the project's queued reflect tasks at once (with the event 'Keep improving off: cancelled reflection #N'); a reflect task already running is allowed to finish, but any tasks it proposes are DISCARDED (not queued) with a note in its result. Toggling it on sets next_reflect_at=0 as today. 4) The planner (chat) is unaffected: owner messages still get planned. 5) Tests: with perpetual=0 no reflect task is created by an empty queue, the rapid top-up or a failed reflection retry; toggling off cancels queued reflections and discards a running reflection's tasks; toggling on schedules one. Run only the touched test files.

## Done when

`node --test test/keep-improving*.test.mjs` passes (no reflection from any path when off, queued ones cancelled, running one's tasks discarded, on re-enables), and the Settings sheet has a Keep improving switch bound to projects.perpetual
