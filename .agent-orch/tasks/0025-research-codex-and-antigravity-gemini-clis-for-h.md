# Task #25: Research Codex and Antigravity/Gemini CLIs for headless use

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 03:21  
- starts after: #18

## Prompt

Research and install the non-Claude coding agent CLIs so later tasks can build adapters. 1) OpenAI Codex CLI: install globally (`sudo npm i -g @openai/codex`). 2) Google Antigravity: find out whether it ships a headless/non-interactive CLI usable on linux/arm64 (web search). If it doesn't, use Google's Gemini CLI (`sudo npm i -g @google/gemini-cli`) and say so clearly. For each CLI, verify it on this machine with `--help` and document in .agent-orch/AGENTS.md: the install command and binary path; how to sign in with a SUBSCRIPTION account (ChatGPT plan / Google account, e.g. device-code login that works over SSH) and where credentials are stored; the exact non-interactive invocation (e.g. `codex exec --json ...`) with prompt, working dir, model flag, full-auto/sandbox flags and session resume; the JSON/stream output format with a short real or doc-sourced sample of each event type (text, tool call, final result, usage, errors); how usage-limit/rate-limit errors appear; and the env vars that would force paid API-key billing (these must be stripped, like API_ENV in server.mjs). Don't write adapter code.

## Done when

.agent-orch/AGENTS.md exists with a section per CLI covering install, subscription login, headless command, model flag, resume and output event format, and `codex --help` exits 0

## Result — done (2026-09-25 03:28)

AGENT-ORCH-STATUS: done — AGENTS.md covers Codex, Antigravity and Gemini; codex --help exits 0
