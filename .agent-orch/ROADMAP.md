# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-25 09:40 (reflect #84)._ The brief's definition of done is still met. README is current,
`npm test` passes (120 tests, including the new static UI check from #83), all 26 AUDIT items are fixed,
and PREFLIGHT.md says **OK** for booting HEAD on a copy of the live data.

The live service (pid 463209) has been running since 03:23 UTC. It is now 58 commits behind HEAD. Every
item left on the roadmap needs that restart plus a Codex/agy sign-in first, because the next real risk is
how the new code behaves on live data and real CLIs. Queuing more agent work now would only add to the
code that isn't deployed yet. **No tasks queued this round.**

**Owner action (pending):** restart once while no task is running. Use "Restart when idle" in the UI
banner, or run `sudo systemctl restart agent-orch`. Then sign in to Codex and Antigravity from the
sidebar's Connections panel.

## Next (queued)
_None. Waiting on the owner's restart._

## Later (after the owner restarts and signs in)
- A real end-to-end codex/agy task run, then a small routing audit of the real output (AUDIT round 4).
- Split public/app.js (~2.7k lines) into native ESM modules; the static UI check from #83 now guards it.
- Mobile layout review on a real phone (preflight has a headless mobile screenshot at /tmp/preflight-bu8y).
- SIGTERM handler that marks runs interrupted. Low value, because orphans are requeued on start.
- Scheduling tests spend about 11 s in fixed waits. Tighten them only if the suite keeps growing.
