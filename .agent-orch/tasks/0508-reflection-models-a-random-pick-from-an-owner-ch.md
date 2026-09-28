# Task #508: Reflection models: a random pick from an owner-chosen pool, no fallbacks

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 19:05  
- files: orchestrator.mjs, server.mjs, public/app.js, public/index.html, test/reflect-pool*.test.mjs

## Prompt

Change how reflection tasks choose their model (orchestrator.mjs reflection spawning and the reflect-task agent/model resolution, the per-project reflection settings from #142 reflect_fallbacks / reflect_agent/reflect_model, server.mjs routes, and the Settings UI in public/app.js). 1) Settings → This project gets 'Reflection models': a multi-select of discovered models across the signed-in agents (Claude, Codex; grouped by agent) with the hint 'Each reflection runs on a random model from this list, so you get different views. If one fails or hits its limit, another from the list is used.' It needs at least 1 selected; the default is the chat's current model. Stored per project (projects.reflect_pool JSON; migrate the existing reflect_fallbacks/reflect_agent into the pool once, then retire those settings in the UI). 2) Selection: when a reflection task starts, pick uniformly at random from the pool's models whose agent is signed in and not rate-limited for that model's group, and record the pick on the task/run ('Reflection on gpt-6-astra (random from 3)'). Owner fallback lists do NOT apply to reflection tasks. 3) Failure: if the run fails for a model-side reason (a rate limit, auth, the model unavailable, a crash before producing a verdict), retry the reflection on a DIFFERENT random model from the remaining pool (no repeats) until the pool is exhausted; then it waits for the earliest reset, with a clear status. 4) Work tasks produced by a reflection keep using the normal routing/fallbacks (this change is only for the reflection run itself). 5) Tests: random choice over the pool (a seeded RNG); a limited model is excluded; a failure retries a different pool model; the pool exhausted → it waits; fallbacks are ignored for reflect tasks; the migration from reflect_fallbacks works. Run only the touched test files.

## Done when

`node --test test/reflect-pool*.test.mjs` passes (random pick, limited excluded, retry on a different model, exhausted waits, fallbacks ignored, migration), and Settings shows Reflection models

## Result — done (check passed) (2026-09-28 19:16)

AGENT-ORCH-STATUS: done — reflections use random pool models; Settings shows Reflection models
