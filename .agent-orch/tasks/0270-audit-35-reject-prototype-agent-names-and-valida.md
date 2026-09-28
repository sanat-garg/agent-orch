# Task #270: AUDIT #35: reject prototype agent names and validate chat modes

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 05:17  
- files: agents.mjs, server.mjs, orchestrator.mjs, test/agent-names.test.mjs, .agent-orch/AUDIT.md

## Prompt

Fix .agent-orch/AUDIT.md item 35. AGENTS in agents.mjs is a plain object, so names like 'constructor', 'toString' and '__proto__' pass every `AGENTS[x]` truthiness check. Add an exported helper in agents.mjs, e.g. `export const isAgent = (id) => typeof id === 'string' && Object.hasOwn(AGENTS, id)`, and use it everywhere a client-supplied agent name is checked: server.mjs (the set_model WS handler, chatAgent, the /api/limits/:id and /api/agents routes, the model/agent lookups around lines 210, 223, 1882, 2066) and orchestrator.mjs (normalizeAgent/agent family helpers near lines 561-570, listedModel, delegateTask and checkFallbacks near 2065 and 2150, plannerAgent near 2307). Also validate modes: POST /api/convos must only store body.mode when it is in MODES (else the default), and answerPermission must check msg.nextMode against MODES. Add test/agent-names.test.mjs: a server test (spawn server.mjs on a free port with CW_DATA_DIR=temp dir, CW_NO_ORCHESTRATOR=1 is fine for the HTTP parts; copy the login/cookie setup from test/fallbacks-api.test.mjs) asserting that POST /api/convos with mode 'weird' stores the default mode, that a WS set_model with agent 'constructor' is rejected and convo.agent stays unchanged, and a unit assertion that isAgent('constructor') is false and isAgent('claude') is true. Then mark item 35 in .agent-orch/AUDIT.md as **Fixed** with a one-line note. Do not change behaviour for valid agent names.

## Done when

`node --test test/agent-names.test.mjs` and `grep -q 'Object.hasOwn(AGENTS' agents.mjs` and `grep -A1 '^### 35\.' .agent-orch/AUDIT.md | grep -q Fixed`
