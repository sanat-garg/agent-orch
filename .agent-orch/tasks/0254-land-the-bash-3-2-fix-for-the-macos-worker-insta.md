# Task #254: Land the bash 3.2 fix for the macOS worker installer

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 01:58  
- files: bin/install-worker-macos.sh, bin/install-worker.sh, bin/dev/build-bash32.sh, test/install-macos-bash32.test.mjs

## Prompt

The Mac worker install still fails on macOS's /bin/bash 3.2.57 with `syntax error near unexpected token |`: bin/install-worker-macos.sh still contains `cat <<EOF | write "$plistf"` (~line 296), which bash 3.2's `declare -f` prints with the pipe AFTER the EOF line, breaking `sudo -u "$WUSER" -H bash -c "…$(declare -f)…"`. See the bash 3.2 gotcha in .agent-orch/CONTEXT.md. Earlier attempts #244/#247 were cancelled. If branch agent-orch/task-244 exists, reuse its work (`git log main..agent-orch/task-244`); else implement: 1) change it to `write "$plistf" <<EOF`, and remove any other `cat <<… | …` in both installers; 2) bin/dev/build-bash32.sh builds bash-3.2.57 into ~/.local/opt/bash-3.2.57/bin/bash (bison; `./configure --build=aarch64-unknown-linux-gnu --without-bash-malloc --disable-nls`; make with CFLAGS and CFLAGS_FOR_BUILD='-O1 -std=gnu89 -Wno-implicit-function-declaration -Wno-implicit-int -Wno-int-conversion -Wno-incompatible-pointer-types -Wno-error'; delete the shipped y.tab.c/y.tab.h first), and copy /tmp/b32/bash-3.2.57/bash if it still exists; 3) test/install-macos-bash32.test.mjs (it skips if the binary is missing) asserts that bash 3.2 re-parses `set -euo pipefail; $vars; $(declare -f); cd; worker_stage` (load the functions via an env guard such as `[[ -n "${AGENT_ORCH_INSTALLER_NO_MAIN:-}" ]] || main "$@"`, and never use ${BASH_SOURCE[0]} for this) and that `--dry-run --controller https://x --code TEST --agents claude,codex` exits 0 under bash 3.2 in both user modes. Run only this test file plus the existing install tests (per the owner's minimise-test-runs preference).

## Done when

`! grep -n 'cat <<' bin/install-worker-macos.sh | grep -q '|'` passes and `node --test test/install-macos-bash32.test.mjs` passes without skipping
