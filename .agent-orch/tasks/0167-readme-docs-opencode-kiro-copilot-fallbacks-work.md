# Task #167: README docs: OpenCode, Kiro, Copilot, fallbacks, worktrees and parallel tasks

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-26 09:57  
- files: README.md

## Prompt

README.md's 'Coding agents' section covers Claude, Codex and Antigravity only. Add concise docs for the OpenCode, Kiro and GitHub Copilot CLIs (install, sign-in via the Connections modal, how models are discovered, known limits: Kiro's authenticated headless use is unverified; Copilot reports no remaining/reset usage), the per-chat and reflection fallback lists, and how work tasks run in isolated git worktrees in parallel (`files`, `after`, integrator tasks, the ../.agent-orch-worktrees directory, what happens on a merge conflict). Read .agent-orch/CONTEXT.md, .agent-orch/AGENTS.md, agents.mjs, worktrees.mjs and parallel.mjs for facts; don't invent flags. Match the README's existing tone and length per section. Only edit README.md.

## Done when

`grep -qi kiro README.md` `grep -qi copilot README.md` `grep -qi opencode README.md` `grep -qi worktree README.md`

## Result — done (check passed) (2026-09-26 09:58)

AGENT-ORCH-STATUS: done — README documents new agents, fallbacks, worktrees and parallel tasks
