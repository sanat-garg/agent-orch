# Task #208: Resource analyzer and safe reaper for leftover processes

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-26 19:41  
- files: resources.mjs, orchestrator.mjs, agents.mjs, server.mjs, test/resources*.test.mjs, test/fixtures/proc-*

## Prompt

Add resources.mjs, a CPU/RAM analyzer plus a safe process reaper (BRIEF goal 9). 1) Snapshot every ~10 s from /proc (no new deps): system MemTotal/MemAvailable/Swap, load and CPU% per core, and per process pid, ppid, cmdline, RSS (plus PSS from /proc/<pid>/smaps_rollup when readable), CPU% since the last sample, age and cwd. Aggregate process trees. Classify each tree: 'live server' (the agent-orch service's own pid tree), 'task:<id>' (agent CLI trees started by the orchestrator for running tasks; have runAgent/runAgentCli register child pids and pgids by task id), 'chat' (chat runtimes), 'orphaned agent' (claude/codex/agy/opencode/kiro-cli/copilot/node MCP servers/language servers whose registering task or chat is no longer running, or whose parent is init/systemd), 'test server' (node server.mjs with CW_DATA_DIR in a temp dir, or ports other than 3000), 'browser' (chromium/headless_shell/Playwright), 'login session' (tmux -L agent-orch-login with no active login), 'owner terminal' (the agent-orch-tmux / ttyd trees), 'system', and 'other'. 2) Reaper: automatically kill (SIGTERM, then SIGKILL after 5 s, whole process group) ONLY these categories: orphaned agent trees older than 2 min, test servers older than 30 min, browsers not owned by a running task older than 10 min, and stale login tmux sessions. NEVER touch the live server, running task/chat trees, owner terminals, sshd/systemd/system services, or anything not owned by the ubuntu user. Log every kill (pid, category, cmdline truncated, RSS freed) to <DATA>/metrics/reaper.jsonl and as orchestrator events. Also run the reaper right before claiming a task when MemAvailable is low. Add a dry-run mode. 3) API (login-protected): GET /api/resources (the system summary, grouped trees with top processes, reclaimable estimate, recent reaper log) and POST /api/resources/kill {pid} (allowed only for categories other than live server, system and owner terminal; running task trees go through the task pause API instead). 4) Tests: classification against fixture /proc trees (a fake procfs dir injected into resources.mjs), the reaper never selecting protected categories, and orphan detection when a task finished but its CLI child lives on.

## Done when

`npm test` passes with resources.mjs classification and reaper-safety tests, and GET /api/resources on a test server returns a grouped process list with a reclaimable estimate
