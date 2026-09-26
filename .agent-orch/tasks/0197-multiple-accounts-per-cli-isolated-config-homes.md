# Task #197: Multiple accounts per CLI: isolated config homes, sign-in and selection backend

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 14:32  
- starts after: #196  
- files: accounts.mjs, agents.mjs, connections.mjs, usage.mjs, server.mjs, .agent-orch/AGENTS.md, test/accounts*.test.mjs

## Prompt

Support several accounts for the same CLI (e.g. two Claude or two Codex subscriptions). 1) Research and document in .agent-orch/AGENTS.md how each CLI can use an isolated credential/config location: Claude Code (CLAUDE_CONFIG_DIR), Codex (CODEX_HOME), Antigravity/agy (HOME or its config dir env), OpenCode (XDG_CONFIG_HOME/XDG_DATA_HOME or OPENCODE_* dirs), Kiro (HOME/XDG), and Copilot (COPILOT_HOME, plus GH_CONFIG_DIR). Verify each on this machine. 2) Add an accounts registry (<DATA>/accounts.json): {id, agent, label, home (a dir under <DATA>/accounts/<agent>/<id>, 0700), createdAt}. The existing login is account 'default' with the CLI's normal home. 3) Every adapter call (run, listModels, loggedIn, account, logout) and every connections login spec takes an account and applies its env overrides. Usage/limit records and blocks are keyed by agent+account, and models are discovered per account. 4) Endpoints: GET /api/accounts; POST /api/accounts {agent, label} (creates it and starts its sign-in via the tmux flow); PATCH (rename); DELETE (logout, remove the dir). 5) Model refs gain an optional account: 'codex@work:gpt-6-sol'. Tasks and fallback entries store {agent, account?, model}, and a missing account means any signed-in account of that agent with usage left, default first. Tests: env isolation per adapter (stub CLIs asserting the env), per-account blocks, and model-ref parsing.

## Done when

`npm test` passes with per-account env isolation, per-account limit blocks and model-ref parsing tests, and GET /api/accounts returns the default accounts
