# Task #34: Detect agent login state and route logged-out agents to Claude

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-25 03:42  
- starts after: #33

## Prompt

In agents.mjs each adapter's available() only checks the binary is on PATH. codex is installed but `codex login status` prints 'Not logged in', so routes to codex would fail on auth. Add an async (or cached, sync-readable) loggedIn() to each adapter. codex: `codex login status` exit code / output ('Logged in' vs 'Not logged in'). agy: see .agent-orch/AGENTS.md for where its OAuth credentials live, and check that the file exists. claude: return true, or check ~/.claude/.credentials.json. Cache the result for about 60 s and never block the event loop for more than a spawn with a 5 s timeout. Expose `loggedIn` in GET /api/agents (server.mjs ~line 1160). In orchestrator.mjs resolveRoute, treat a logged-out agent like an unavailable one (fall back to Claude and log why). Add tests using the stub binaries in test/fixtures/ (e.g. a codex stub that answers `login status`) covering the logged-out fallback in routing and the field in /api/agents. Update the routing line in .agent-orch/CONTEXT.md. Do not restart the live server. Test servers need CW_DATA_DIR=$(mktemp -d).

## Done when

`grep -q loggedIn agents.mjs && grep -q loggedIn server.mjs && npm test`
