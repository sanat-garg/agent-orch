# Task #293: AUDIT #43: the restart drain preflights the new HEAD before exiting, and README adds StartLimitIntervalSec=0

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 08:44  
- files: server.mjs, test/restart.test.mjs, README.md, .agent-orch/AUDIT.md

## Prompt

Fix AUDIT.md Round 6 item #43 (read it first). server.mjs `startRestartDrain` (around line 307) reaches `process.exit(0)` without checking that the code at HEAD boots. With the opt-in `autoRestart` setting on, a merged task that breaks server start-up (a syntax error in a module only server.mjs imports, a migration that throws) restarts straight into the crash; systemd's default start limit (StartLimitBurst=5 in 10s with RestartSec=2) then leaves the unit failed and the web terminal (Caddy forward_auth to :3000) down too. Nobody is watching, because autoRestart exists so nobody has to.

Add a preflight that runs once the drain reports idle and before exit, for both the owner's manual restart and the automatic one: (1) `node --check` on every root `*.mjs` and `bin/*.mjs`; (2) boot `node server.mjs` once as a child on a free port with `CW_NO_ORCHESTRATOR=1`, a fresh temp `CW_DATA_DIR` and the same env otherwise, wait up to ~20 s for `GET /auth/check` (or `/api/health`) on that port to answer any HTTP status, then kill the child and remove the temp dir. Never boot the orchestrator on a copy of the live DB (it would start claiming tasks). If any step fails: do not exit; log `[restart] preflight failed: …`, clear `restartPending` and tell clients (the same `status` frame the cancel path sends), record an orchestrator event or owner notice if there is an existing helper for that, and set `autoRestartSkipHead` to that HEAD so the auto path waits for a newer commit. Keep the function small; put the preflight in its own async helper next to startRestartDrain.

Extend test/restart.test.mjs (read how it spawns the server and fakes the git state) with one case where the preflight fails, e.g. the test writes a root `broken.mjs` with a syntax error into the temp checkout the server runs from, and asserts the server stays up and logs the failure; keep the existing passing cases green. In README.md, add `StartLimitIntervalSec=0` to the systemd unit examples (lines around 105 and 121) with a one-line reason. Mark #43 **Fixed** in .agent-orch/AUDIT.md.

## Done when

`npm test -- test/restart.test.mjs` passes and `grep -q 'StartLimitIntervalSec=0' README.md`

## Result — done (check passed) (2026-09-28 08:49)

AGENT-ORCH-STATUS: done — restart preflights HEAD; failed boot stays up; README has StartLimitIntervalSec=0
