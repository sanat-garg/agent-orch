# Task #778: Rigor levels 1-5 per project for planner and reflection prompts

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 23:18  
- files: orchestrator.mjs, server.mjs, test/rigor*.test.mjs

## Prompt

The owner finds agent-orch's task creation over-engineered ('meant to secure a nasdaq-level enterprise'), when most projects just want working features. Add a per-project RIGOR level 1-5 that shapes how the chat planner and reflection create tasks (orchestrator.mjs PLANNER_SYSTEM/TASKS_FORMAT and reflectPrompt, projects table, server.mjs). Contract (the UI task codes against it; keep it exact): projects.rigor INTEGER 1-5 (migration: existing projects → 3, new projects default → 2); PATCH of the project fields accepts {rigor}; GET /api/orch/rigor-levels → [{level, name, summary, example:{title, prompt, done_when}}] for levels 1-5 (the examples all answer the SAME sample request, 'Add a contact form to the website', so the difference is visible). Levels: 1 'Just make it work': 1-2 broad tasks per request, done_when = the feature runs (e.g. the page loads with the form and a submit shows a thanks message); no tests unless trivial; reflection only fixes things that are visibly broken or asked for. 2 'Working product' (the default for new projects): small feature-sized tasks, one simple check each (a smoke test or a curl), reflection focused on user-visible features, obvious bugs and UX; no audits, security reviews, or edge-case hunting unless the owner asks. 3 'Balanced': plus basic automated tests per feature and obvious edge cases (validation, empty states); an occasional light review. 4 'Thorough': plus error handling, input validation and security basics, broader tests, and small refactors; reflection may queue audits of risky areas. 5 'Enterprise': today's behaviour (audit rounds, security hardening, strict verifier rules, extensive tests, AUDIT ledgers). Implement it as a level-specific guidance block injected into both prompts (and a rigor note in the reflection's priorities: e.g. at levels 1-2, reflection must NOT queue AUDIT or security or edge-case tasks, and should prefer finishing and polishing features the BRIEF asks for). The planner context line shows 'Rigor: 2 · Working product'. Also let the rapid top-up respect the rigor (lower rigor → fewer speculative tasks). Tests: the planner and reflection prompt text differ by level and contain the level's guidance; levels 1-2 contain the no-audit rule; the migration sets existing projects to 3; the endpoint returns 5 levels with examples for the same request. Run only the touched test files.

## Done when

`node --test test/rigor*.test.mjs` passes (prompts vary by level, no-audit rule at levels 1-2, migration to 3, default 2 for new, 5 levels with same-request examples)

## Result — done (check passed) (2026-09-28 23:24)

AGENT-ORCH-STATUS: done — Per-project rigor 1-5 now shapes planner, reflection and top-up prompts
