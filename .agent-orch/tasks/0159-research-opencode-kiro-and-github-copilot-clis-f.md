# Task #159: Research OpenCode, Kiro and GitHub Copilot CLIs for headless use

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 04:21

## Prompt

Research and install three more coding-agent CLIs (BRIEF goal 10) and document them in .agent-orch/AGENTS.md, one section each, like the existing codex/agy sections. The CLIs: OpenCode (sst/opencode, `npm i -g opencode-ai` or the official installer), Kiro CLI (AWS Kiro's CLI; find its official linux/arm64 install) and GitHub Copilot CLI (`npm i -g @github/copilot`). For each, verify on this machine: install and binary path; subscription/account login that works over SSH (device-code or pasted-code flow, and whether it can run inside our tmux-driven Connections flow), where credentials live and the status/whoami command; the non-interactive/headless invocation with prompt, cwd, model, auto-approve/permissions and session resume; the streaming/JSON output format with sample events (text, tool call, tool result, final, usage, errors); model discovery; how rate-limit/quota errors and reset times appear; and the env vars that force paid API-key billing (to strip). Note blockers honestly: e.g. if Copilot reuses the gh login, that the Kiro CLI requires an AWS Builder ID, or that a CLI has no JSON output (then document the plain-text parsing strategy). Don't write adapter code.

## Done when

.agent-orch/AGENTS.md has OpenCode, Kiro and Copilot sections covering install, login, headless command, output format, models and limits, and each binary's `--help` exits 0

## Result — done (2026-09-26 08:29)

AGENT-ORCH-STATUS: done — Three CLI research sections documented; all help checks passed.
