# Task #205: Integrate #184: OpenCode Connect: let the owner choose the provider instead of forcing OpenAI

- kind: work  
- source: planner  
- priority: 95 (normal)  
- created: 2026-09-26 14:36

## Prompt

Task #184 ("OpenCode Connect: let the owner choose the provider instead of forcing OpenAI") finished in its own git worktree, but its branch `agent-orch/task-184` conflicts with `main`, which changed meanwhile (conflicting files: connections.mjs, public/app.js). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #184's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #184's instructions were:

Bug: in the Connections modal, OpenCode's Connect button opens OpenAI's sign-in, because connections.mjs (~line 53) hardcodes `opencode auth login --provider openai --method 'ChatGPT Pro/Plus (headless)'` (and logout `opencode auth logout openai`). OpenCode is a harness with no account of its own: it signs into model providers. Fix: 1) Discover the providers and login methods this installed OpenCode version supports (run `opencode auth login` interactively in a scratch tmux on the dedicated login socket and capture the provider menu, check `opencode auth --help` and `opencode models`, and read the OpenCode section of .agent-orch/AGENTS.md). Keep ONLY subscription/account sign-ins that work headless (e.g. ChatGPT Plus/Pro device flow, GitHub Copilot device flow, OpenCode's own subscription if it has an account login), and exclude plain API-key providers (the subscription-only rule; see the OpenCode subscription guard from AUDIT #32). 2) The Connections modal: clicking Connect on OpenCode first shows a small provider picker (radio list: provider name plus one line like 'Uses your ChatGPT Plus/Pro plan'), then runs that provider's flow (URL + code, paste-back if needed) through the existing tmux login machinery. Add the per-provider url/code/success regexes. 3) Status: GET /api/connections for opencode reports every signed-in provider (from `opencode auth list` or equivalent), and the row shows 'Connected via ChatGPT (email)' / 'via GitHub Copilot'. Disconnect offers per-provider logout. Model discovery lists only models from signed-in providers. 4) Update .agent-orch/AGENTS.md and README. Tests: provider-menu parsing from captured fixture text, and a start request for provider X that launches X's flow (not openai). Verify in the UI on a test server (separate port, CW_DATA_DIR=$(mktemp -d), CW_NO_ORCHESTRATOR=1) with a screenshot of the provider picker.

## Done when

`npm test` passes with opencode provider-picker tests, and `! grep -n "'--provider', 'openai'" connections.mjs` (no hardcoded openai provider)

## Result — done (check passed) (2026-09-26 14:47)

AGENT-ORCH-STATUS: done — Merge conflicts resolved; tests pass; no hardcoded OpenAI provider remains
