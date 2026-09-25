# Task #27: Add Codex CLI adapter to agents.mjs

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 03:21  
- starts after: #26

## Prompt

Add a 'codex' adapter to agents.mjs following the interface there and the Codex section of .agent-orch/AGENTS.md. Spawn the codex CLI in non-interactive JSON mode in cwd with the given model. For autonomous runs, use its full-auto/no-approval mode inside the project dir. Support resume if the CLI supports it. Parse its JSON event stream into the normalised events, map its usage-limit errors to outcome 'rate_limited' with resetsAt when available, and honour signal (kill the process group on abort). Strip OPENAI_API_KEY and any other key-billing env vars so it uses the ChatGPT login. Test with a stub executable in test/fixtures that prints recorded sample events; don't call the real service in tests.

## Done when

`npm test` passes with a codex adapter test that runs a stub binary and asserts the normalised text/tool/result events

## Result — done (check passed) (2026-09-25 03:32)

AGENT-ORCH-STATUS: done — codex adapter added; stub-binary tests pass under npm test
