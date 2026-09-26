# Task #148: Antigravity: reproduce and fix file/tool failures with a real smoke suite

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 23:56

## Prompt

The owner reports that Antigravity 'can barely access files, view_file fails and other issues'. The earlier diagnosis (.agent-orch/ANTIGRAVITY-TOOLS.md, read it first) found view_file paths lost in normalisation, schedule-timer conflicts and a bwrap sandbox failure, but couldn't reproduce everything. Do a hands-on end-to-end check with the REAL agy CLI, exactly as the orchestrator launches it (agents.mjs runAntigravity: `agy -p … --output-format stream-json --print-timeout 0 --model … --dangerously-skip-permissions`, cwd = project, with the same env stripping). 1) Create bin/agent-smoke.mjs: it makes a scratch git project in a temp dir with a few files and a tiny `node --test` suite, then runs a fixed list of prompts through runAgentCli for a given agent and model: read a specific file and quote line 3; list files with a glob; grep for a string; edit a function and make the failing test pass; create a new file in a subdirectory; run `npm test` and report the result; read a file by relative path and by absolute path; handle a large file (>2000 lines). For each, it verifies the outcome on disk (not just the agent's words) and prints a pass/fail table with the failing tool events. 2) Run it for antigravity with one Gemini model (gemini-3.1-pro-high) and one third-party model (claude-sonnet-4-6). For every failure, find the root cause in OUR launch/adapter (cwd, workspace trust/allowed dirs, sandbox/bwrap availability on this arm64 box, env/HOME, path normalisation, stream parsing, timeouts, conversation resume) or in agy config, and fix it. If a failure is inside agy itself and can't be fixed from our side, document it with evidence and a workaround. 3) Re-run until all pass. Record the final table in .agent-orch/ANTIGRAVITY-TOOLS.md. Also run the smoke suite for claude and codex to catch shared adapter regressions. Keep the unit tests passing, and add adapter unit tests for each bug fixed.

## Done when

`node bin/agent-smoke.mjs --agent antigravity --model gemini-3.1-pro-high` and `--model claude-sonnet-4-6` both exit 0 with every check passing, and `npm test` passes

## Result — done (check passed) (2026-09-26 01:32)

AGENT-ORCH-STATUS: done — agy smoke passes 10/10 on both models; edit-path bug fixed
