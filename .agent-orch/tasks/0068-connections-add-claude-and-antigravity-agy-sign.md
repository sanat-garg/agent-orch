# Task #68: Connections: add Claude and Antigravity (agy) sign-in specs

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 08:21  
- starts after: #3

## Prompt

Extend connections.mjs (built in the previous task) with login specs for Claude Code and Antigravity. Claude: find a non-destructive way to sign in with the Claude subscription (e.g. `claude auth login`/`claude setup-token`/`claude /login` in tmux; check `claude --help` on this machine). Status comes from `claude auth status` or an equivalent check. NEVER pick an API-key method. Warn in the UI before logging Claude out, because every agent in agent-orch depends on it. agy: run `agy` interactively in tmux, choose the Google login option, extract the OAuth URL, accept the pasted authorization code, and detect success (see the agy section of .agent-orch/AGENTS.md). Record the real pane text you observe as test fixtures, and add parsing tests. Update the adapters' `login` hints in agents.mjs to say 'Connect from the sidebar'.

## Done when

`npm test` passes with Claude and agy parsing fixtures, and GET /api/connections reports correct installed/signedIn for claude and agy on this machine
