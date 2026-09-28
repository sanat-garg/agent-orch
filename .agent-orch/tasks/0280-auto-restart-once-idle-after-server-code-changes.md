# Task #280: Auto-restart once idle after server code changes: backend setting and drain trigger

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 05:57  
- files: server.mjs, orchestrator.mjs, test/restart.test.mjs, README.md, .agent-orch/CONTEXT.md

## Prompt

Goal: an opt-in setting that makes agent-orch restart itself once idle after merged commits touched server-side code, so fixes go live without the owner pressing 'Restart when idle'. Today server.mjs only counts `commitsSinceBoot` for the banner (see the '---------- self-restart ----------' block near line 291) and `POST /api/restart-when-idle` (near line 1440) does the drain: `orch.drain()`, `whenIdle(...)`, `process.exit(0)`; systemd (Restart=always) boots the new code.

Do:
1. orchestrator.mjs: add a boolean `autoRestart` (default false) to the kv `parallel_settings` object: validate it in `setParallelSettings` (like `controllerWork`), include it wherever the other parallel settings reach `stateView()` so the UI can read it, and expose a getter (e.g. `orch.autoRestart()`) for the server.
2. server.mjs: factor the drain-and-exit code of POST /api/restart-when-idle into a function (e.g. `startRestartDrain(reason)`) and call it from the route. Add a poll (default every 60 s, env `AGENT_ORCH_RESTART_POLL_MS` for tests) that, when `orch.autoRestart()` is true, nothing is already pending and `git diff --name-only <bootCommit>..HEAD` lists a server-side file (root `*.mjs`, `bin/`, `package.json`, `package-lock.json`; ignore `public/`, `.agent-orch/`, `test/`, docs), starts the same drain with a `[restart] auto:` log line and broadcasts `{t:'status', restartPending}` so the banner shows. Allow env `AGENT_ORCH_BOOT_COMMIT` to override the boot commit (tests only). Never trigger under `CW_NO_ORCHESTRATOR=1`.
3. Test in test/restart.test.mjs (copy its spawn-on-a-free-port setup, temp `CW_DATA_DIR`): pick the parent of the latest commit that touched server.mjs (`git log -2 --format=%H -- server.mjs`), spawn server.mjs with `AGENT_ORCH_BOOT_COMMIT=<that parent>` and `AGENT_ORCH_RESTART_POLL_MS=200`, sign in, PUT `/api/orch/parallel` `{autoRestart: true}`, and assert the process exits 0 within ~10 s; also assert that with autoRestart off it stays up. Keep the existing tests passing.

Constraints: never touch port 3000 or the live data dir. Default off: nothing changes for the owner until they turn it on. Add one line to README.md's restart section and note the setting in .agent-orch/CONTEXT.md's Restart bullet.

## Done when

`npm test -- test/restart.test.mjs test/parallel.test.mjs` && `grep -q autoRestart server.mjs` && `grep -q autoRestart orchestrator.mjs`
