# Task #185: OpenCode: free Zen models available without sign-in

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-26 12:41  
- starts after: #184

## Prompt

OpenCode ships free 'OpenCode Zen' models that work with NO sign-in. On this machine `opencode models` (run in a neutral cwd) prints: opencode/big-pickle, opencode/ling-3.0-flash-fin-free, opencode/mimo-v2.6-flash-free, opencode/muse-spark-1.3-contributor-free, opencode/nemotron-3-ultra-free, opencode/nemotron-3.5-lightning-free, opencode/space-bunny-free. Yet agent-orch marks OpenCode 'NOT LOGGED IN: falls back to Claude; models unknown'. Fix: 1) Model discovery for opencode runs `opencode models` (with the same env/config isolation the adapter uses) and parses provider/model ids. Models under the `opencode/` provider are the free Zen tier: label them 'Zen · <name> (free)'. 2) The availability/connection state: OpenCode is 'ready' whenever it has at least one usable model, even without a provider login. The Connections row shows 'Ready · free Zen models' plus an optional 'Connect a provider' (the provider picker from task #184). The routing/fallback-to-Claude logic must not treat it as logged out. 3) Billing guard: keep the subscription-only rule for everything else. Allow the free Zen models (ids ending in -free, and big-pickle, or better, whatever `opencode models --verbose`/the Zen catalog marks as free/zero-cost; check it), and do NOT expose paid opencode/ Zen models unless the owner adds a Zen key. Make sure the OpenCode subscription guard (AUDIT #32) permits the free Zen provider without an API key. 4) Run the smoke suite: `node bin/agent-smoke.mjs --agent opencode --model opencode/big-pickle` (and one more free model) until every check passes, and fix adapter issues found. 5) Update .agent-orch/AGENTS.md and README. Tests: discovery parsing of the model list, 'ready without login' state, and the free-model filter.

## Done when

`node bin/agent-smoke.mjs --agent opencode --model opencode/big-pickle` exits 0, `npm test` passes, and GET /api/connections reports opencode ready with the free Zen models listed
