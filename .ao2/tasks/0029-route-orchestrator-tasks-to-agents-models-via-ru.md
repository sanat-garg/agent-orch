# Task #29: Route orchestrator tasks to agents/models via rules and per-task fields

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 03:21  
- starts after: #28

## Prompt

Make the orchestrator pick the agent and model per task. 1) DB: add nullable `agent` and `model` columns to tasks (migrate existing DBs with ALTER TABLE if missing), and a `routes` table (id, project_id NULL=global, match TEXT: a task kind or a keyword/category like 'tests','ui','docs','refactor', agent, model, note, created_at). 2) The tasks JSON block accepts optional per-task "agent" and "model", plus a top-level "routes": [{"match","agent","model","scope":"project|global"}] (and {"remove": id}) so the planner can save rules when the owner says things like 'use codex for writing tests' or 'use opus for planning'. 3) Resolution order when a task runs: explicit task fields, then the first matching project route (by task kind or keyword in the title), then a global route, then the project default (Claude, project.model). Unavailable agents fall back to Claude with a logged event. 4) The planner prompt lists the available agents (AGENTS registry with available()), their suggested models and the current routes, and explains how to set routes. 5) runAgent dispatches through runAgentCli. Unit tests cover route resolution and block parsing.

## Done when

`npm test` passes with tests showing that a task with no explicit agent picks the matching project route, then the global route, then the default
