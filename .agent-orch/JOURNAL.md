# Journal

_Append-only record of completed work, written by the orchestrator._

## 2026-09-24 23:32 — #10 Add node:test smoke test for server startup and login [done (check passed)]

npm test runs 4 passing server smoke tests

## 2026-09-24 23:33 — #11 Write README.md with setup and security notes [done (check passed)]

README lists all four env vars; terminals documented at /shell/

## 2026-09-24 23:36 — #12 Audit server, orchestrator and UI for bugs into .agent-orch/AUDIT.md [done]

AUDIT.md lists 15 ranked, verified bugs with fixes

## 2026-09-24 23:37 — #14 Fix malformed-cookie server crash (AUDIT #1) [done (check passed)]

malformed cookies no longer crash the server; regression test passes

## 2026-09-24 23:38 — #19 Task drawer: show instructions first, then what happened, then done-when [done (check passed)]

Drawer now shows instructions, what happened, then done-when

## 2026-09-24 23:38 — #20 Rebrand all user-visible names to agent-orch [verify failed (1)]

Command: grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md

## 2026-09-24 23:38 — #20 Rebrand all user-visible names to agent-orch [verify failed (2)]

Command: grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md

## 2026-09-24 23:39 — #20 Rebrand all user-visible names to agent-orch [in progress (3)]

Check can't pass as written: bare grep exits 1 when clean (AUDIT #16)

## 2026-09-24 23:39 — #20 Rebrand all user-visible names to agent-orch [verify failed (4)]

Command: grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md

## 2026-09-24 23:39 — #20 Rebrand all user-visible names to agent-orch [failed (verification)]

`grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md` still failing after 4 sessions:

## 2026-09-24 23:40 — #15 Catch unhandled rejections from fire-and-forget calls (AUDIT #4) [done (check passed)]

fire-and-forget rejections now logged; backstop handler added; AUDIT #4 Fixed

## 2026-09-24 23:45 — #20 Rebrand all user-visible names to agent-orch [verify failed (1)]

Command: grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md

## 2026-09-24 23:45 — #20 Rebrand all user-visible names to agent-orch [verify failed (2)]

Command: grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md

## 2026-09-24 23:45 — #20 Rebrand all user-visible names to agent-orch [verify failed (3)]

Command: grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md

## 2026-09-24 23:45 — #20 Rebrand all user-visible names to agent-orch [verify failed (4)]

Command: grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md

## 2026-09-24 23:46 — #20 Rebrand all user-visible names to agent-orch [failed (verification)]

`grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md` still failing after 4 sessions:

## 2026-09-24 23:47 — #20 Rebrand all user-visible names to agent-orch [done (check passed)]

Check exits 0 under bash; "exit 1" was stale output

## 2026-09-24 23:48 — #21 Rename AO2 protocol markers and DB file to agent-orch [done (check passed)]

New fence, status and DB names in place; old names still accepted; tests pass

## 2026-09-24 23:49 — #22 Rename project memory dir .ao2 to .agent-orch with auto-migration [done (check passed)]

memory dir is .agent-orch with auto-migration, tests pass

## 2026-09-24 23:51 — #23 Write one-shot script to move install to ~/agent-orch [done]

bin/rename-install.sh ready; dry-run and sandbox re-runs pass

## 2026-09-24 23:51 — #16 Add orchestrator lock file against double instances (AUDIT #2) [done (check passed)]

Rename already committed; grep and all 12 tests pass

## 2026-09-24 23:52 — #17 Fix chat context rollover orphaning the new runtime (AUDIT #3) [verify failed (1)]

Command: grep -n "runtimes.get(convo.id) === rt" server.mjs

## 2026-09-25 03:21 — #17 Fix chat context rollover orphaning the new runtime (AUDIT #3) [done (check passed)]

Literal runtimes.get(convo.id) === rt guard present; tests pass

## 2026-09-25 03:22 — #18 Stop losing messages sent while WebSocket reconnects (AUDIT #7) [done (check passed)]

Unsent messages stay in composer with a reconnecting notice

## 2026-09-25 03:28 — #25 Research Codex and Antigravity/Gemini CLIs for headless use [done]

AGENTS.md covers Codex, Antigravity and Gemini; codex --help exits 0

## 2026-09-25 03:30 — #26 Create agents.mjs adapter interface with Claude adapter [done (check passed)]

agents.mjs has a Claude adapter that runAgent calls through; tests pass

## 2026-09-25 03:32 — #27 Add Codex CLI adapter to agents.mjs [done (check passed)]

codex adapter added; stub-binary tests pass under npm test

## 2026-09-25 03:34 — #28 Add Antigravity/Gemini CLI adapter to agents.mjs [done (check passed)]

Antigravity adapter added; stub-binary tests pass in npm test
