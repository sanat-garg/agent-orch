# Task #60: Per-agent rate-limit blocks; tighten agy limit detection (AUDIT #18)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 04:24  
- starts after: #59

## Prompt

Fix AUDIT #18 in .agent-orch/AUDIT.md (read it first). In orchestrator.mjs, `recordGovernor` (around line 962) sets the global kv `blocked_until` for any rate_limited outcome. Only a Claude limit should do that. For codex/antigravity, store kv `blocked_until:<agent>` (resetsAt + CFG.resetBufferSec, or the existing unknown-reset backoff). While that key is in the future, `resolveRoute` should treat the agent as unavailable and fall back to Claude with a route_note like 'Codex usage limit until <time>'. Reuse any per-agent unusable mechanism that task #17 (AUDIT #17) added, if one exists. Make sure a successful non-Claude run doesn't clear the global block, and a successful Claude run doesn't clear an agent's block. In agents.mjs, around line 420, the antigravity result classifier tests `AGY_LIMIT_RE` against all of stderr (`hay`). Change it to test only the error message (`errMsg` / result.error), so a failed run whose log mentions 'quota' is not read as a limit. Add tests: a codex rate_limited result leaves the global `blocked_until` at 0 and the next task routes to Claude, and an agy stub whose stderr mentions 'quota' but whose error doesn't is classified as 'error'. Mark AUDIT #18 Fixed, and remove the sentence 'A non-Claude rate limit still sets the global `blocked_until`' from .agent-orch/CONTEXT.md (replace it with the new behaviour).

## Done when

`npm test` passes and `! grep -q 'A non-Claude rate limit still sets the global' .agent-orch/CONTEXT.md`
