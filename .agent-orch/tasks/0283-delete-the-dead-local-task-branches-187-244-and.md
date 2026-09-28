# Task #283: Delete the dead local task branches 187, 244 and 247

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 05:57  
- files: .agent-orch/JOURNAL.md

## Prompt

Goal: remove three local git branches in /home/ubuntu/agent-orch that hold nothing main needs, so `git branch` and integrators stop seeing them. `agent-orch/task-187` is partial work for the removed Copilot agent (brief goal 10: never re-add it). `agent-orch/task-244` and `agent-orch/task-247` carried the bash 3.2 macOS installer fix and the verifier `|` fix, which landed on main via tasks #254 and #263.

Do, in the main checkout (the live app; only git ref operations, never touch the working tree or restart anything):
1. For 244 and 247, confirm the fix is on main: `git diff main...agent-orch/task-244 --stat` and skim the diff; check `grep -n 'regex' taskrun.mjs` and test/install-macos-bash32.test.mjs exist on main. If a hunk is genuinely missing from main, stop and write it up in .agent-orch/JOURNAL.md instead of deleting.
2. `git branch -D agent-orch/task-187 agent-orch/task-244 agent-orch/task-247`.
3. Do NOT delete `agent-orch/task-197`, `-199`, `-209` (unlanded partial work), `backup/pre-agent-orch` or any `claude/*` branch.
4. Append a two-line note to .agent-orch/JOURNAL.md saying which branches were deleted and why.

## Done when

`! git show-ref --verify --quiet refs/heads/agent-orch/task-187` && `! git show-ref --verify --quiet refs/heads/agent-orch/task-244` && `! git show-ref --verify --quiet refs/heads/agent-orch/task-247` && `git show-ref --verify --quiet refs/heads/agent-orch/task-209`
