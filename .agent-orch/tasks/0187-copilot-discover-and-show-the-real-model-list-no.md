# Task #187: Copilot: discover and show the real model list, not just 'auto'

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-26 12:43  
- files: agents.mjs, connections.mjs, test/agents*.test.mjs, test/fixtures/copilot-*

## Prompt

The Copilot agent shows only 'Auto': data/models.json has copilot {models:[{id:'auto'}]}. Discovery is in agents.mjs (COPILOT.listModels ~line 1008, which uses the Copilot SDK client.listModels() with COPILOT_HOME=~/.copilot and a stripped env, and copilotModels() ~line 991, which filters out ids containing '/'). Investigate and fix: 1) Auth: COPILOT.loggedIn() checks `gh auth status`, but the Copilot CLI has its own login state in ~/.copilot (config.json/session store). Check whether copilot itself is authenticated and entitled (e.g. run `copilot` non-interactively with a trivial prompt and --model auto in a scratch dir, or use the SDK's auth/status call). If the SDK needs a GitHub token that stripEnv removes (GH_TOKEN/COPILOT_GITHUB_TOKEN are in envFilter), supply the gh CLI's token explicitly for model listing and runs (a Copilot subscription token isn't API billing), or complete Copilot's own login. Make loggedIn()/account() reflect Copilot's real auth, not just gh. 2) Parsing: dump the raw listModels() rows (to a temp file, with no tokens) and fix copilotModels(): keep real model ids even if they contain '/', use the SDK's display name, mark the policy/entitlement state (enabled vs 'requires enabling in GitHub settings') and premium multipliers if provided, and keep 'auto' as the default entry. 3) Refresh the cache (models.json) and confirm that the agents endpoint and the prompt context list the Copilot models. 4) The Connections row and model picker show the models; disabled-by-policy models are shown greyed with the reason. 5) Run `node bin/agent-smoke.mjs --agent copilot --model <one discovered non-auto model>` and fix issues. Tests: copilotModels() with a fixture of raw SDK rows (including ids with '/', and disabled policy states), and loggedIn() using Copilot's own auth state.

## Done when

`npm test` passes with the copilotModels fixture tests, data/models.json lists more than just 'auto' for copilot, and `node bin/agent-smoke.mjs --agent copilot --model <a discovered model>` exits 0
