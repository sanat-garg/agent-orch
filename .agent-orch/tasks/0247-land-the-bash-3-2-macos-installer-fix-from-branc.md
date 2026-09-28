# Task #247: Land the bash 3.2 macOS installer fix from branch agent-orch/task-244

- kind: work  
- source: reflection  
- priority: 85 (urgent)  
- created: 2026-09-28 01:13  
- files: bin/install-worker-macos.sh, bin/install-worker.sh, bin/dev/build-bash32.sh, taskrun.mjs, test/install-macos-bash32.test.mjs, test/verify.test.mjs, .agent-orch/JOURNAL.md

## Prompt

Finished, tested work sits on local branch `agent-orch/task-244` (2 commits on top of an older main): bin/install-worker-macos.sh and bin/install-worker.sh made bash 3.2-safe (`stage_cmd`, `write FILE <<EOF` instead of `cat <<EOF | write`, no empty arrays under set -u, `AGENT_ORCH_INSTALLER_NO_MAIN` guard), bin/dev/build-bash32.sh, test/install-macos-bash32.test.mjs, a taskrun.mjs fix (`unquoted()` so a `|` inside a quoted grep pattern no longer stops the 'prints nothing' exit-1 rewrite) and test/verify.test.mjs cases. Bring it onto main: `git merge --squash agent-orch/task-244` (or cherry-pick both commits) in your worktree. The only conflict is .agent-orch/CONTEXT.md: keep main's version entirely (it was rewritten and already documents the bash 3.2 rules). Also take main's version of .agent-orch/JOURNAL.md if it conflicts; drop the branch's .agent-orch/tasks/0244-*.md file. Do NOT change the code from the branch beyond conflict resolution. Confirm `~/.local/opt/bash-3.2.57/bin/bash --version` says 3.2.57 (if missing, run bin/dev/build-bash32.sh). Run `node --test test/install-macos-bash32.test.mjs test/install-scripts.test.mjs test/verify.test.mjs` with `TMPDIR` set to an existing dir on the home disk, then the full `npm test`. Append a JOURNAL.md line. The verifier fix goes live only after a server restart; do not restart the live server.

## Done when

`test -f test/install-macos-bash32.test.mjs` and `grep -q 'const unquoted' taskrun.mjs` and `grep -q 'stage_cmd' bin/install-worker-macos.sh` and `npm test` passes
