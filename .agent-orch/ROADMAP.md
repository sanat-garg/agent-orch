# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-09-26 10:55 (reflect #179)._ All six AUDIT round-4 findings are now fixed (#30 by #176, now marked **Fixed**).
Round 5 (#177) audited the whole HTTP/WS surface and found it mostly sound. It did find three real issues:
**#33**, where one `null` WebSocket frame crashes the whole server and every running task with it; **#34**, where
other `*.sslip.io` sites count as same-site, so they can frame the app (clickjacking) and shadow the session cookie;
and **#35**, where prototype names like `constructor` pass the `AGENTS[x]` checks and chat modes aren't validated.

The mobile HIG review (#178, `.agent-orch/UI-REVIEW.md`) lists 17 findings. Two decide whether the PWA works on a real
iPhone at all: #1 (the top bar collapses under the standalone safe-area inset) and #2 (no keyboard/visualViewport
handling). Weekly capacity is at 80%, so this round queues only the security fixes and the top-bar fix. All are small
and touch disjoint files, except the three server.mjs fixes, which serialise on that file.

## Next (queued)
1. Fix AUDIT #33: malformed WS frames can't crash the server (type guard plus try/catch in the message handler).
2. Fix AUDIT #34: `frame-ancestors 'none'` / `X-Frame-Options: DENY`, and the `__Host-` session cookie.
3. Fix AUDIT #35: `Object.hasOwn` agent checks and `MODES` validation for convo mode and `nextMode`.
4. UI-REVIEW #1: the top bar's height includes the safe-area inset (CSS only).

## Later
- UI-REVIEW #2 (visualViewport keyboard handling; hide the orch bar while typing), then #3–#5 (task-card titles, settings
  as a bottom sheet, 44pt touch targets), then #6–#8 (contrast, type size, bottom chrome). Mark each one done in UI-REVIEW.md.
- The lasting fix for #34 is a hostname under a domain the owner controls. That's the owner's decision.
- Split public/app.js (~4.5k lines) into native ESM modules, guarded by test/ui-static.test.mjs.
- SIGTERM handler that marks runs interrupted (low value).
