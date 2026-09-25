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

## 2026-09-25 03:37 — #29 Route orchestrator tasks to agents/models via rules and per-task fields [done (check passed)]

Tasks route to agents/models; npm test passes, 40/40

## 2026-09-25 03:41 — #30 UI: agent/model picker in chat, agent badge on tasks, routes list [done (check passed)]

Agent/model picker, task agent badges, deletable routes list; tests pass

## 2026-09-25 03:43 — #32 Remove leftover Claude Web strings and mark AUDIT #2 and #15 fixed [done]

Claude Web strings removed; AUDIT #2 and #15 marked fixed

## 2026-09-25 03:44 — #33 Verifier runs every command-like backticked snippet in Done when (AUDIT #16) [done]

Verifier now runs all command-like Done-when snippets, joined with &&

## 2026-09-25 03:46 — #34 Detect agent login state and route logged-out agents to Claude [done]

Logged-out agents now fall back to Claude; the /api/agents response includes loggedIn

## 2026-09-25 03:48 — #35 Close the parallel-request login lockout bypass (AUDIT #8) [done]

parallel login bursts now hit lockout; regression test passes

## 2026-09-25 03:49 — #36 Answer oversized request bodies with 413 instead of hanging (AUDIT #14) [done]

Oversized bodies now get 413 and bad JSON gets 400

## 2026-09-25 03:51 — #38 Close expired or revoked sessions' WebSockets (AUDIT #9) [done (check passed)]

WebSockets for removed or expired sessions now close with 4001

## 2026-09-25 03:52 — #39 Deleting a chat mid-plan stops queued planner turns (AUDIT #6) [done (check passed)]

Deleting a chat mid-plan now drops its queued planner turns

## 2026-09-25 03:52 — #40 Skip corrupt JSONL lines instead of blanking chat and task logs (AUDIT #13) [done (check passed)]

Corrupt JSONL lines are skipped; chat and task logs still load

## 2026-09-25 03:53 — #41 UI: show logged-out agents as needing sign-in in picker and routes list [done (check passed)]

Picker and routes list flag logged-out agents as needing sign-in

## 2026-09-25 03:54 — #42 Make orchestrator git commits async so they don't block the server (AUDIT #10) [done]

Orchestrator git commits now async and serialized; tests pass

## 2026-09-25 03:56 — #44 Dedupe concurrent gh.ensureRepo calls per directory (AUDIT #12) [done (check passed)]

ensureRepo dedupes concurrent calls per dir; test passes

## 2026-09-25 03:57 — #45 runCheck honours task cancellation and kills its process group (AUDIT #11) [done (check passed)]

runCheck now honours task cancellation and kills its process group

## 2026-09-25 04:02 — #46 Planner-busy guard so plan tasks and chat planner turns never overlap (AUDIT #5) [done (check passed)]

Plan tasks and chat planner turns no longer overlap; test added

## 2026-09-25 04:03 — #47 README: document multi-agent setup (Codex, agy) and routing rules [done]

README documents coding agents, logins, billing guards, routing, fallback

## 2026-09-25 04:04 — #48 Close out the Definition of Done: every AUDIT item Fixed or Deferred, README verified [done (check passed)]

All 16 AUDIT items fixed, README checked against live setup

## 2026-09-25 04:06 — #50 Unit-test the pacing governor decide() [done (check passed)]

decide() exported, 13 pacing tests pass, npm test green
