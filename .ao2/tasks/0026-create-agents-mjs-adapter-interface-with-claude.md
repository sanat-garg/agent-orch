# Task #26: Create agents.mjs adapter interface with Claude adapter

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 03:21  
- starts after: #25

## Prompt

Create agents.mjs, a pluggable coding-agent layer. Export `AGENTS` (a registry) and `runAgentCli({agent, model, prompt, cwd, resume, systemAppend, autonomous, signal, onEvent})`, which returns {outcome, text, sessionId, usage, resetsAt, errorCode}. Every adapter emits NORMALISED events to onEvent: {k:'text',text}, {k:'tool',name,input}, {k:'tool_result',text,isError}, {k:'result',usage}, {k:'limit',resetsAt}. The first adapter is 'claude', and it wraps the existing SDK query() logic from orchestrator.mjs runAgent (~line 955). Move that logic, don't duplicate it, and keep runAgent's external behaviour identical. Each adapter declares: id, label, available() (binary exists), models[] (a suggested list; free text is allowed), and envFilter (the vars to strip so billing stays on the subscription). Add test/agents.test.mjs covering the registry and the event normalisation using a fake message stream. Read .agent-orch/AGENTS.md first.

## Done when

agents.mjs exports AGENTS with a 'claude' adapter, orchestrator.mjs runAgent calls through it, and `npm test` passes including test/agents.test.mjs
