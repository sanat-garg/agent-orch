# Task #300: Rapid mode: keep every free slot fed with parallel, file-disjoint work

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 10:50  
- files: orchestrator.mjs, public/app.js, test/rapid*.test.mjs

## Prompt

The owner wants the cluster saturated (BRIEF goal 9). Right now reflection queues 1-2 background tasks at a time, so most slots sit idle. Change orchestrator.mjs reflection/planning: 1) Queue-depth target: when ready work tasks (queued, prerequisites met, not awaiting review) < free slots across the cluster (+2 buffer), trigger reflection immediately instead of waiting for the idle cooldown (keep at most one reflection in flight per project, and a minimum of 3 min between reflections). 2) The reflection prompt gets the live numbers ('14 slots, 3 running, 2 ready: queue about 11 more') and must return that many independent tasks, split into small file-disjoint pieces with declared 'files', spread across areas (bugs from AUDIT, UI-REVIEW items, tests for untested modules, ROADMAP next items, BRIEF goals still open), with integrator tasks only where parts must combine. It should not repeat queued, running or done work (give it the titles of the last 50 tasks). Quality bar unchanged: each task has one deliverable and one check. 3) The planner prompt (chat turns): when the owner asks for a feature and there are free slots, decompose it into parallel parts by default. 4) The rate-limit guard: if every agent in the fallback list is above ~90% of its 5 h window, stop topping up and say so in the status. 5) A setting 'Rapid development mode' (default ON) in the Settings sheet; off restores the old behaviour. Tests: the top-up trigger fires when ready < free slots; the reflection prompt contains the requested count and recent titles; no top-up when all agents are near their limit.

## Done when

Touched tests pass (`node --test test/rapid*.test.mjs`), and the reflection prompt built by the code for a state with 14 slots, 3 running and 2 ready asks for 11 tasks (asserted in the test)

## Result — done (check passed) (2026-09-28 11:06)

AGENT-ORCH-STATUS: done — Rapid mode tops up parallel work with verified quota guards.
