# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-25 (reflect #82)._ The brief's definition of done is met: README is current (it documents
`CW_NO_ORCHESTRATOR`, Connections and routing), `npm test` passes (117 tests), and all 26 AUDIT items are fixed.
Preflight #81 booted HEAD on a copy of the live data dir: verdict **OK**. Migrations are additive only, no
rows changed, the UI rendered with no console errors, and all APIs returned 200 (see PREFLIGHT.md).

The live service still runs code from 03:23 UTC, about 47 commits behind HEAD. Nothing more on the repo side
makes that restart safer. The remaining work is on the owner's side, and more agent work now would mostly
add to the pile of undeployed code. So only one small regression guard is queued.

**Owner action (pending):** restart once while no task runs: use "Restart when idle" in the UI banner, or
run `sudo systemctl restart agent-orch`. Then sign in to Codex and Antigravity from the sidebar's
Connections panel.

## Next (queued)
1. Static UI smoke test: app.js parses, and every `$('id')` in app.js exists in index.html. This is a
   cheap guard for a future app.js split. Checked by hand today: no missing ids.

## Later (after the owner restarts and signs in)
- A real end-to-end codex/agy task run, then a small routing audit of the real output (AUDIT round 4).
- Split public/app.js (~2.7k lines) into native ESM modules, now that a static UI check will exist.
- Mobile layout review on a real phone (preflight has a headless mobile screenshot at /tmp/preflight-bu8y).
- SIGTERM handler that marks runs interrupted. Low value, because orphans are requeued on start.
- Scheduling tests spend about 11 s in fixed waits. Tighten them only if the suite keeps growing.
