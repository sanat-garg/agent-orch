# Task #62: Infer route agent from model family and drop mismatched models (AUDIT #20)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 04:24  
- starts after: #61

## Prompt

Fix AUDIT #20 in .agent-orch/AUDIT.md (read it first). In orchestrator.mjs, `agentForModel` (around line 436) only knows the hard-coded `AGENTS[*].models` lists, so a route like {model:'gemini-2.5-pro'} with no agent resolves to Claude with a Gemini model. When the model isn't listed, infer the agent from its family: /^(gpt|o\d|codex)/i -> codex, /^gemini/i -> antigravity, /^(claude|opus|sonnet|haiku)/i -> claude. In `resolveRoute`/`pick`, if an explicit agent is paired with a model that clearly belongs to another family (e.g. codex + opus), drop the model (use the agent's default), log it, and add it to route_note. Also make `parseTasksBlock` ignore or strip such mismatched routes, with a logged reason. If the inferred agent is unavailable, the normal fallback to Claude must then drop the foreign model rather than pass 'gemini-2.5-pro' to Claude. Add cases to test/routing.test.mjs covering: a model-only gemini route -> antigravity; the same with antigravity unavailable -> claude with no gemini model; codex+opus -> codex with the default model. Mark AUDIT #20 Fixed.

## Done when

`node --test test/routing.test.mjs` passes and `npm test` passes
