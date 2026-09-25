# Task #98: Model selectors: fetch real model lists from each CLI, no hardcoded guesses

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 13:22  
- starts after: #97

## Prompt

The owner wants the model selector to show only real models, never assumed data. agents.mjs currently hardcodes models: claude ~line 180, codex ~line 351 (['gpt-5-codex','gpt-5']) and antigravity ~line 474 (['gemini-3.8-flash-high']). Replace these with discovery from each CLI: Claude Code (look for a models listing via the CLI or Agent SDK, e.g. `claude` supportedModels() on the SDK Query object, or the /model options; aliases like opus/sonnet/haiku are fine if the CLI reports them); codex (e.g. `codex` model listing via its app-server/`debug models`/config, or whatever this version supports; check `codex --help`); agy (`agy models`, per .agent-orch/AGENTS.md). Cache the results in <DATA>/models.json with a timestamp, refresh on startup, every 6 h and right after a successful sign-in, and expose {id, label, description?, default?} per model through the existing agents endpoint. Show friendly display names from the CLI if it provides them. If discovery fails or the agent is signed out, return an EMPTY list with an error reason; the UI then shows 'Sign in to load models' or 'Couldn't load models: <reason>' instead of placeholders. Routing/model validation (AUDIT #20 infer-from-family) must use the discovered lists. Document the discovery command for each CLI in .agent-orch/AGENTS.md. Tests use stub binaries.

## Done when

`! grep -nE "models: \[" agents.mjs` (no hardcoded model arrays), and `npm test` passes with discovery tests using stub CLIs
