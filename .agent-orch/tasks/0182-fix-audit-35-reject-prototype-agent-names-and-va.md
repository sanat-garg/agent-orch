# Task #182: Fix AUDIT #35: reject prototype agent names and validate chat modes

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-26 10:52  
- files: server.mjs, orchestrator.mjs, agents.mjs, test/agent-validation.test.mjs

## Prompt

Read .agent-orch/AUDIT.md finding #35. `AGENTS` is a plain object, so `AGENTS['constructor']` / `['toString']` / `['__proto__']` are truthy. Replace every membership check on AGENTS that comes from user input with `Object.hasOwn(AGENTS, x)` (or a small `isAgent(x)` helper exported from where AGENTS is defined): WS `set_model` and `chatAgent` in server.mjs, `delegateTask`, `checkFallbacks` and `agentStatus` in orchestrator.mjs (grep for `AGENTS[` to find any others fed by request data). An invalid agent must be rejected: `set_model` sends `{t:'error'}` and leaves convo.agent unchanged, and `delegateTask` returns `{ok:false, error}` so the HTTP route gives 400. Validate `body.mode` in `POST /api/convos` and `msg.nextMode` in `answerPermission` against `MODES`, falling back to the default mode when a value isn't listed. Add test/agent-validation.test.mjs covering: set_model with agent 'constructor' is refused and convo keeps its agent; delegate with agent '__proto__' → 400 and the task row is unchanged; POST /api/convos with mode 'weird' stores the default mode. Append a `- **Fixed** (task #<this id>): ...` line under #35 in .agent-orch/AUDIT.md.

## Done when

`node --test test/agent-validation.test.mjs test/delegate.test.mjs test/server.test.mjs` passes
