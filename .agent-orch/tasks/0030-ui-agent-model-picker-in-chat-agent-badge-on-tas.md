# Task #30: UI: agent/model picker in chat, agent badge on tasks, routes list

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 03:21  
- starts after: #29

## Prompt

Expose the multi-agent support in the web UI (public/app.js, app.css, server.mjs). 1) Chat: the model picker becomes an agent + model picker populated from the server's AGENTS registry (a new GET endpoint that returns id, label, available and models). Unavailable agents are shown disabled with the hint 'sign in: <login command>'. Non-Claude chats run through runAgentCli in server.mjs, streaming the normalised events into the existing chat rendering. 2) Task cards and the task drawer show a small badge with the agent and model the task ran on. 3) The project view lists the saved routes, with a delete button for each. Test on a separate port with CW_DATA_DIR=$(mktemp -d), and never touch the live server. Extend test/server.test.mjs to check that the agents endpoint returns claude.

## Done when

`npm test` passes including an agents-endpoint test, and public/app.js renders the agent badge on task cards

## Result — done (check passed) (2026-09-25 03:41)

AGENT-ORCH-STATUS: done — Agent/model picker, task agent badges, deletable routes list; tests pass
