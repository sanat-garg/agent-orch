# Task #251: AUDIT #35: reject prototype agent names and validate chat modes

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 01:13  
- files: agents.mjs, server.mjs, orchestrator.mjs, test/, .agent-orch/AUDIT.md

## Prompt

Fix .agent-orch/AUDIT.md item 35. `AGENTS` (agents.mjs) is a plain object, so `AGENTS['constructor']`, `AGENTS['__proto__']` etc. are truthy: WS `set_model {agent:'constructor'}` is stored on the convo and breaks the chat ('a.run is not a function'); `POST /api/orch/tasks/:id/delegate {agent:'constructor'}` writes it to the task row; `POST /api/convos` stores any `mode` unchecked and `answerPermission` accepts `msg.nextMode` unchecked (WS `set_mode` already checks `MODES`). Add a helper in agents.mjs, e.g. `export const isAgentId = (x) => typeof x === 'string' && Object.hasOwn(AGENTS, x)`, and use it in server.mjs (`set_model`, `chatAgent`, the convo-creation route, `answerPermission` nextMode via `MODES`) and orchestrator.mjs (`delegateTask`, `checkFallbacks`, `agentStatus` and anywhere else `AGENTS[x]` gates input). Invalid agents get a 400 / WS error; invalid modes fall back to the default mode. Add regression tests: in the existing server test that creates convos (test/*.test.mjs with a spawned server), `POST /api/convos {mode:'weird'}` yields the default mode and `set_model {agent:'constructor'}` is refused without changing `convo.agent`; in a `createOrchestrator` child harness, `delegateTask(id, {agent:'constructor'})` returns `{ok:false}` and leaves the row unchanged. Mark item 35 `**Fixed**` in AUDIT.md with a one-line note. Run the touched test files, then `npm test`.

## Done when

`grep -q 'Object.hasOwn(AGENTS' agents.mjs` and `grep -q '^### 35.*' .agent-orch/AUDIT.md` and `npm test` passes
