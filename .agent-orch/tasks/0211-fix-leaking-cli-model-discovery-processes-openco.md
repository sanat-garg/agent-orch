# Task #211: Fix leaking CLI model-discovery processes (opencode models orphans)

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-26 19:43  
- files: agents.mjs, models.mjs, usage.mjs, bin/agent-health.mjs, test/helpers-spawn*.test.mjs

## Prompt

Observed on 2026-09-26 at 19:42: orphaned `opencode models --verbose` processes (ppid 1, ~300-390 MB RSS each, several at once, only seconds or minutes old) keep piling up and push the 5.9 GB, no-swap VPS to full RAM. They come from model discovery (agents.mjs listModels/discoverModels for opencode, cached by models.mjs; also triggered by bin/agent-health.mjs, the Connections refresh and sign-in changes). Fix for ALL agents' discovery, limit and status helpers (opencode models, agy models, agy -p /usage, codex debug models, kiro-cli whoami/list-models, the copilot SDK client, and the claude supportedModels query): 1) Spawn every helper with detached:true in its own process group, and on timeout or abort kill the whole group (SIGTERM, then SIGKILL after 3 s). Make sure the promise settles and nothing survives the parent. Use a shared helper (e.g. runHelper(cmd, args, {timeoutMs})) instead of ad-hoc spawnSync or execFile calls. 2) Single-flight: concurrent requests for the same agent/account share one in-flight discovery. 3) Cache discipline: serve from the models.json and limits.json caches, refreshing only at boot, every 6 h, after a sign-in change or on the explicit Refresh button, with a minimum 60 s between refreshes per agent. The planner context and UI reads never trigger discovery. 4) opencode specifically: check whether `opencode models` starts a background server or child that outlives it. If so, run it with the flag or env that avoids that, or kill its child tree. 5) Tests: a stub CLI that forks a long-lived child and ignores SIGTERM; after a timeout, no stub processes remain (check the /proc scan in the test); single-flight collapses 5 concurrent calls into 1 spawn. After the change, run `node bin/agent-health.mjs` twice and confirm with `ps` that no opencode, agy or kiro helper processes remain afterwards.

## Done when

`npm test` passes with the helper-timeout-kills-tree and single-flight tests, and after two runs of `node bin/agent-health.mjs`, `ps -eo ppid,args | awk '$1==1' | grep -c 'opencode models'` prints 0
