# Task #174: Fix AUDIT #32: OpenCode subscription guard checks global config and OPENCODE_CONFIG_CONTENT

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-26 10:31  
- files: agents.mjs, test/opencode.test.mjs

## Prompt

Read .agent-orch/AUDIT.md finding #32 (Round 4) and the OpenCode section of .agent-orch/AGENTS.md first. Constraint from BRIEF.md: agents must run on subscriptions, never API keys. Bug in agents.mjs `runOpencode` (around lines 740-800): it refuses to run only when opencode.json/opencode.jsonc/.env in the cwd set `apiKey`/`baseURL`, but OpenCode also loads `~/.config/opencode/{config.json,opencode.json,opencode.jsonc}`, project configs in parent directories up to the git root, and inline JSON from `OPENCODE_CONFIG_CONTENT`. Fix: (1) extend the check to the global config files under the (overridable-for-tests) home dir and to config files in every directory from cwd up to the git root; (2) strip `OPENCODE_CONFIG_CONTENT` (and any other OPENCODE_CONFIG* var) from the child environment via the adapter's `envFilter`, so it applies in chat and orchestrator runs alike; (3) keep the refusal message clear about which file set a key. The real ~/.config/opencode on this VM holds only `$schema` and must still pass. Add tests to test/opencode.test.mjs using the existing stub binary in test/fixtures/: a temp HOME whose ~/.config/opencode/opencode.json sets a provider apiKey makes runOpencode refuse; a parent-dir opencode.json with baseURL makes it refuse; OPENCODE_CONFIG_CONTENT is absent from the stub's environment; a clean config still runs. Do NOT edit .agent-orch/AUDIT.md. Never restart the live server on port 3000.

## Done when

`node --test test/opencode.test.mjs` passes, including new tests for a global-config apiKey refusal and OPENCODE_CONFIG_CONTENT being stripped.
