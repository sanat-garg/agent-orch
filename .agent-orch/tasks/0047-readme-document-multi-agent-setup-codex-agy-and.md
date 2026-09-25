# Task #47: README: document multi-agent setup (Codex, agy) and routing rules

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 03:55  
- starts after: #46

## Prompt

README.md has no mention of the multi-agent feature (brief goal 5). Add a '## Coding agents' section after Setup. Base it on .agent-orch/AGENTS.md, agents.mjs and the routing notes in .agent-orch/CONTEXT.md. Cover: the supported agents (Claude Code, OpenAI Codex CLI, Google Antigravity `agy`); how to install each and log in with a subscription (e.g. `codex login --device-auth`, running `agy` once for OAuth); that API-key billing is never used, and which env vars are stripped; how the chat agent/model picker works; how routing rules are created (tell the planner in chat, e.g. 'use codex for tests') and resolved (task field → project route → global route → Claude), with deleting routes in the UI; and the fallback to Claude when an agent is missing or logged out ('needs sign-in' in the UI). Keep it concise and in the README's existing style, and check every command and path you mention against the code. Change only README.md.

## Done when

`grep -q '^## Coding agents' README.md && grep -q 'codex login' README.md && grep -qi 'route' README.md`

## Result — done (2026-09-25 04:03)

AGENT-ORCH-STATUS: done — README documents coding agents, logins, billing guards, routing, fallback
