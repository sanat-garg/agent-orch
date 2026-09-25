# Task #28: Add Antigravity/Gemini CLI adapter to agents.mjs

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 03:21  
- starts after: #27

## Prompt

Add the Google agent adapter to agents.mjs (id 'antigravity' if .agent-orch/AGENTS.md found a headless Antigravity CLI, otherwise id 'gemini' with the label 'Gemini CLI (Antigravity has no CLI)'). Follow the same pattern as the codex adapter: non-interactive streaming JSON output, model flag, auto-approve for autonomous runs, resume if supported, rate-limit mapping, abort handling, and stripping GEMINI_API_KEY/GOOGLE_API_KEY and similar vars so it uses the Google account login. Test it with a stub binary in test/fixtures.

## Done when

`npm test` passes with a Google-agent adapter test using a stub binary

## Result — done (check passed) (2026-09-25 03:34)

AGENT-ORCH-STATUS: done — Antigravity adapter added; stub-binary tests pass in npm test
