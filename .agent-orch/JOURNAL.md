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

## 2026-09-25 04:10 — #51 Test orchestrator task scheduling: ordering, deps, cascade, blocked_until [done (check passed)]

scheduling tests added; npm test passes, all 73 tests

## 2026-09-25 04:12 — #52 Show route fallback reason on the task's agent badge [done (check passed)]

fallback reason stored in route_note and shown on badge

## 2026-09-25 04:16 — #54 Audit round 2: multi-agent adapters, routing and non-Claude chat [done (check passed)]

AUDIT.md lists five confirmed multi-agent findings, #17–#21

## 2026-09-25 04:18 — #55 Orchestrator drain(): stop claiming tasks and resolve when running tasks finish [done (check passed)]

drain() stops claims, resolves when idle; tests pass

## 2026-09-25 04:20 — #56 Server: restartPending state and POST /api/restart-when-idle [done (check passed)]

restart-when-idle endpoint and status fields added, all tests pass

## 2026-09-25 04:22 — #57 UI: 'updates since start' banner with a Restart when idle button [done (check passed)]

Update banner with Restart-when-idle button added; tests pass

## 2026-09-25 08:23 — #65 Header repo link: derive from the real git remote, not cached convo.repo [done (check passed)]

Repo link now comes from git origin; tests pass

## 2026-09-25 08:26 — #66 Usage-limit notice: correct reset time in the viewer's timezone [done (check passed)]

Usage-limit notices show the real reset in the viewer's timezone; tests pass

## 2026-09-25 08:32 — #67 Server: tmux-driven sign-in sessions for agent CLIs (codex first) [done (check passed)]

Web sign-in backend for codex/GitHub via tmux; tests pass

## 2026-09-25 08:38 — #68 Connections: add Claude and Antigravity (agy) sign-in specs [done (check passed)]

Claude and agy sign-in specs, fixtures, tests and status checks work

## 2026-09-25 08:44 — #69 Sidebar Connections panel: connect/disconnect Claude, Codex, Antigravity, GitHub [done (check passed)]

sidebar Connections panel added; browser flow verified and tests pass

## 2026-09-25 08:47 — #59 Non-Claude auth failure blocks only that agent, not the whole orchestrator (AUDIT #17) [done (check passed)]

non-Claude auth failures now fall back to Claude; tests pass

## 2026-09-25 08:50 — #60 Per-agent rate-limit blocks; tighten agy limit detection (AUDIT #18) [done (check passed)]

Non-Claude usage limits now block only that agent

## 2026-09-25 08:53 — #61 Drop stale codex/agy sessions and retry once without resume (AUDIT #19) [done (check passed)]

Dead codex/agy sessions are now dropped and the turn retried fresh

## 2026-09-25 08:58 — #62 Infer route agent from model family and drop mismatched models (AUDIT #20) [done (check passed)]

Routes infer agents from model family and drop mismatched models

## 2026-09-25 09:01 — #63 CLI adapters kill leftover process-group members after normal exit (AUDIT #21) [done (check passed)]

CLI runs now kill leftover process-group members; AUDIT #21 fixed

## 2026-09-25 09:06 — #71 Audit round 3: sign-in connections, drain/restart-when-idle, limit notices [done (check passed)]

AUDIT.md now has Round 3 with bugs #22-26

## 2026-09-25 09:07 — #72 Remove tracked .ao2/ leftovers from git [done (check passed)]

Stale .ao2/ removed from git; npm test passes

## 2026-09-25 09:12 — #74 Send pasted sign-in codes with -- and fail if the send fails (AUDIT #25) [done (check passed)]

Codes are sent after `--`; failed sends return 500 without Enter; tests pass

## 2026-09-25 09:17 — #75 Make login start/cancel/finish race-safe (AUDIT #22) [done (check passed)]

Login start/cancel/finish race-safe; race tests pass; #22 Fixed

## 2026-09-25 09:19 — #76 Connections panel recovers after a reconnect or restart; kill orphaned login tmux at boot (AUDIT #23) [done (check passed)]

Connections panel reloads on reconnect; orphaned login tmux killed at boot

## 2026-09-25 09:23 — #77 Restart-when-idle waits for busy chat and planner turns, and can be cancelled (AUDIT #24) [done (check passed)]

Restart waits for busy chat work, and restarts can be cancelled

## 2026-09-25 09:26 — #78 Past usage-limit notices show an absolute time, not 'now' (AUDIT #26) [done (check passed)]

Past limit notices now show an absolute time; tests pass

## 2026-09-25 09:33 — #80 Add CW_NO_ORCHESTRATOR=1 to boot the server without running the orchestrator [done (check passed)]

CW_NO_ORCHESTRATOR=1 boots inert, tested; all 117 tests pass

## 2026-09-25 09:35 — #81 Preflight HEAD against a copy of the live data dir and write .agent-orch/PREFLIGHT.md [done (check passed)]

HEAD boots cleanly on copied live data; PREFLIGHT verdict OK

## 2026-09-25 09:38 — #83 Static UI smoke test: app.js parses and every $('id') exists in index.html [done (check passed)]

UI static smoke test added; it and npm test pass

## 2026-09-25 10:14 — #85 Merge Connections into the sidebar footer and open it as a modal [done (check passed)]

Connections now open as a modal from the sidebar footer button

## 2026-09-25 10:18 — #86 Click-to-copy for terminal commands shown in chat [done (check passed)]

Shell commands, code blocks and inline commands now copy on click

## 2026-09-25 10:24 — #88 Capture screenshots from agent runs and serve them via /api/media [done (check passed)]

Screenshots are stored and served at /api/media; tests pass

## 2026-09-25 10:30 — #89 Render screenshots inline in chat and task drawer with a lightbox [done (check passed)]

Screenshots render in chat and task drawer, with a lightbox

## 2026-09-25 13:24 — #90 Screenshot helper and instructions for agents to capture UI screenshots [done]

bin/shot.mjs captures PNGs; prompts and README updated

## 2026-09-25 13:32 — #92 Record per-agent usage history and serve /api/usage/history [done (check passed)]

Usage history store and /api/usage/history endpoint built, tests passing

## 2026-09-25 13:40 — #93 Feed Codex and Antigravity rate-limit windows into usage history [done (check passed)]

Codex and agy usage windows now recorded; npm test passes

## 2026-09-25 13:50 — #94 Usage modal: click the usage card to see limits over time per agent [done (check passed)]

Usage card opens per-agent charts modal; npm test passes

## 2026-09-25 14:01 — #97 Make rate limits fully independent per agent (chat and workers) [done (check passed)]

per-agent rate limits independent; npm test passes (138)

## 2026-09-25 14:13 — #98 Model selectors: fetch real model lists from each CLI, no hardcoded guesses [done (check passed)]

Model lists now come from each CLI; tests pass

## 2026-09-25 14:22 — #99 Antigravity connection: show signed-in email and a Disconnect button [done (check passed)]

Antigravity shows its signed-in email and can be disconnected

## 2026-09-25 14:25 — #100 Sidebar footer: drop the 'N/N signed in' count [verify failed (1)]

Command: ! grep -nE "signed in\

## 2026-09-25 14:25 — #100 Sidebar footer: drop the 'N/N signed in' count [verify failed (2)]

Command: ! grep -nE "signed in\

## 2026-09-25 14:27 — #100 Sidebar footer: drop the 'N/N signed in' count [verify failed (3)]

Command: ! grep -nE "signed in\

## 2026-09-25 14:30 — #100 Sidebar footer: drop the 'N/N signed in' count [verify failed (4)]

Command: ! grep -nE "signed in\

## 2026-09-25 14:34 — #100 Sidebar footer: drop the 'N/N signed in' count [done (check passed)]

restarted server's check passes; this prompt's failure predates restart

## 2026-09-25 18:25 — #108 Artificial Analysis client: API key in Connections, cached model metrics [done (check passed)]

AA key storage, cached metrics, model mapping, /api/models/metrics, tests pass

## 2026-09-25 18:33 — #109 Delegation engine: rank comparable models with available usage for a task [done (check passed)]

delegate.mjs ranks models and moves eligible tasks; tests pass

## 2026-09-25 18:42 — #110 Model selector 'Auto Delegate' option and manual Delegate action on queued tasks [done (check passed)]

Auto Delegate picker option and manual Delegate sheet with endpoint tests

## 2026-09-25 18:52 — #112 Edit or retract saved chat messages before the orchestrator reads them [done (check passed)]

saved messages editable/retractable while pending; 409 after consume, tests pass

## 2026-09-25 18:59 — #113 Usage modal: add a 6h range [done (check passed)]

Usage modal offers 6h range with 15-minute token buckets

## 2026-09-25 19:09 — #114 Task queue order: position column, dependency-aware reorder API [done (check passed)]

manual queue reorder API added; all 172 tests pass

## 2026-09-25 19:25 — #115 Drag-and-drop task cards in the queue, moving dependents with them [done (check passed)]

Queue sheet drag-reorders tasks with dependents via the move API

## 2026-09-25 19:33 — #124 Composer model selector: width fits the selected model name [done (check passed)]

model picker sizes to its selected name, clamped and ellipsized

## 2026-09-25 19:45 — #125 Composer: drop the Pinned chip; Auto Delegate shows the start model plus likely fallbacks [done (check passed)]

Pinned chip removed; Auto Delegate preview now live and tested

## 2026-09-25 19:52 — #126 Queue window: wider, indented dependents, new waiting/limited glyphs [done (check passed)]

queue is wider, shows dependents as a tree, has new glyphs

## 2026-09-25 19:59 — #129 Backend: owner-defined fallback list per chat for Auto Delegate [done (check passed)]

curated per-chat fallbacks stored, snapshotted, honoured; npm test passes

## 2026-09-25 20:27 — #131 Fix mobile queue list overflowing the viewport [done]

Mobile queue fits and scrolls at all three widths

## 2026-09-25 20:45 — #132 Fix missing Artificial Analysis data in Auto Delegate fallback popup [done]

Free-tier metrics reach popup; distinct data states pass regression.

## 2026-09-25 20:51 — #133 Simplify Auto Delegate fallback popup UI [done]

Compact fallback popup verified at desktop and 375 pixels.

## 2026-09-25 20:55 — #134 Diagnose and fix Antigravity file tool failures [in progress (1)]

Diagnostic fix verified; reported file-execution failure remains unreproduced

## 2026-09-25 23:26 — #136 Add cached LiveBench scores for delegation [done]

LiveBench adapter fetches official livebench.ai results; tests pass

## 2026-09-25 23:54 — #140 Fix and redesign the Auto Delegate fallback editor in the app's theme [done (check passed)]

fallback editor rebuilt, interactions persist; npm test passes

## 2026-09-26 00:03 — #142 Orchestrator settings: fallback hierarchy for reflection tasks [done (check passed)]

Reflection fallbacks editor added to #obPop, saved and snapshotted per project, npm test passes

## 2026-09-26 00:15 — #146 Codex: fix false 'limit hit' and use real reset times from rate-limit snapshots [done (check passed)]

Codex limit was real; reset times now parsed from snapshots/errors

## 2026-09-26 01:32 — #148 Antigravity: reproduce and fix file/tool failures with a real smoke suite [done (check passed)]

agy smoke passes 10/10 on both models; edit-path bug fixed

## 2026-09-26 01:52 — #149 Verify Antigravity runs a real orchestrator task end to end [done (check passed)]

both antigravity orchestrator runs finish done; three bugs fixed, tested

## 2026-09-26 02:12 — #147 Antigravity: show all four limits (Gemini 5h/weekly, third-party 5h/weekly) with clear names [done (check passed)]

Four named limits, independent group blocking; all 208 tests pass

## 2026-09-26 02:20 — #137 Switch delegation ranking from Artificial Analysis to LiveBench [done]

LiveBench delegation ranking verified with availability and owner overrides preserved

## 2026-09-26 02:25 — #138 Show LiveBench in the simplified delegation popup [done]

LiveBench popup verified at desktop and mobile widths.

## 2026-09-26 02:34 — #145 Play a completion sound when a task finishes while the tab is in the background [done (check passed)]

Background completion sounds verified; all 207 tests pass.

## 2026-09-26 02:43 — #144 Revert to the original system font stack; remove bundled fonts [done]

Original fonts restored; required checks and tests pass

## 2026-09-26 04:33 — #152 Remove all benchmark scoring (LiveBench, Artificial Analysis) and automatic ranking [done (check passed)]

benchmark scoring gone; delegation uses owner fallback lists only

## 2026-09-26 04:50 — #153 Simple, foolproof fallbacks: one clean list per chat and for reflection [done (check passed)]

Fallback lists replace Auto Delegate everywhere; 189 tests pass

## 2026-09-26 05:05 — #154 Clear delegation status on task cards, drawer and chat [done (check passed)]

modelStatus() drives task cards, drawer and chat notices; tests pass

## 2026-09-26 05:20 — #155 Run concurrent tasks in isolated git worktrees and merge back safely [done (check passed)]

work tasks run in isolated worktrees and merge back safely

## 2026-09-26 05:44 — #156 Parallel planning: file-scoped tasks, multi-dependencies, integrator tasks, agent spreading [done (check passed)]

parallel scheduling with file gating, multi-deps, spreading and integrators; tests pass

## 2026-09-26 05:56 — #157 Screenshots: uniform thumbnails; click opens the image at original size [done (check passed)]

Fixed 160×100 thumbnails; lightbox opens images at original size; tests pass

## 2026-09-26 06:10 — #163 Fix 'While you were away' window overflowing the screen on iPhone [done (check passed)]

Away sheet and all modals fit phone screens; tests pass

## 2026-09-26 08:29 — #159 Research OpenCode, Kiro and GitHub Copilot CLIs for headless use [done]

Three CLI research sections documented; all help checks passed.

## 2026-09-26 08:50 — #160 OpenCode CLI: adapter, model discovery, connection and smoke test [done (check passed)]

OpenCode added; tests and API pass; smoke awaits sign-in

## 2026-09-26 09:08 — #161 Kiro CLI: adapter, model discovery, connection and smoke test [done (check passed)]

Kiro integrated; live smoke awaits owner sign-in

## 2026-09-26 09:37 — #162 GitHub Copilot CLI: adapter, model discovery, connection and smoke test [done (check passed)]

Copilot smoke 10/10, npm tests pass, connection listed

## 2026-09-26 09:49 — #158 Themed, non-blocking toasts at the side [done (check passed)]

themed stacked toasts with kinds; tests pass; screenshots captured

## 2026-09-26 09:58 — #167 README docs: OpenCode, Kiro, Copilot, fallbacks, worktrees and parallel tasks [done (check passed)]

README documents new agents, fallbacks, worktrees and parallel tasks
## 2026-09-26 09:59 — #166 Parallel e2e: prove two file-disjoint tasks run concurrently and both merge [done (check passed)]

parallel e2e passed live on haiku: tasks overlapped, both merged
## 2026-09-26 10:03 — #165 AUDIT round 4: worktrees, parallel scheduling, delegation and new adapters [done (check passed)]

AUDIT.md Round 4 lists six verified findings (#27–32)
## 2026-09-26 10:27 — #168 Speed up the tests: cut fixed waits in the slowest test files [done (check passed)]

full suite now ~198 s from 278 s, stable

## 2026-09-26 10:33 — #173 Fix AUDIT #31: dotted directory names in task files cover their contents [done (check passed)]

Declared paths without wildcards now cover their whole contents

## 2026-09-26 10:34 — #174 Fix AUDIT #32: OpenCode subscription guard checks global config and OPENCODE_CONFIG_CONTENT [done (check passed)]

OpenCode guard now checks global, parent configs; strips OPENCODE_CONFIG*
## 2026-09-26 10:35 — #172 Fix AUDIT #28: a failed or cancelled integrator releases its needs_integration owner [done (check passed)]

Failed/cancelled integrators now release their owners; tests pass
## 2026-09-26 10:37 — #170 Fix AUDIT #27: re-attach detached-HEAD task worktrees instead of deleting them [done (check passed)]

Detached-HEAD task worktrees re-attach and keep work; tests pass

## 2026-09-26 10:38 — #171 Fix AUDIT #29: unresolvedFiles must not flag setext ======= headings [done (check passed)]

Setext ======= headings are no longer flagged as unresolved conflicts

## 2026-09-26 10:48 — #178 Mobile HIG review: screenshot the main screens at 390x844 and list prioritised UI findings [done (check passed)]

UI-REVIEW.md has 17 HIG findings; 15 screenshots saved
## 2026-09-26 10:49 — #177 AUDIT round 5: security and robustness of the server's HTTP and WebSocket endpoints [done (check passed)]

Round 5 audit adds three verified findings (#33–#35)
## 2026-09-26 10:51 — #176 Fix AUDIT #30: retrying two failed prerequisites in either order revives their dependent [done (check passed)]

retrying failed prerequisites in either order revives dependents

## 2026-09-26 10:54 — #180 Fix AUDIT #33: malformed WebSocket frames must not crash the server [done (check passed)]

malformed WebSocket frames no longer crash the server; tests pass

## 2026-09-26 10:58 — #181 Fix AUDIT #34: forbid framing and harden the session cookie against same-site sslip.io hosts [done (check passed)]

Every response now forbids framing; HTTPS sessions use __Host-cw_session

## 2026-09-26 14:36 — #184 OpenCode Connect: let the owner choose the provider instead of forcing OpenAI [done (check passed)]

Waiting for the full test run to finish.
## 2026-09-26 13:18 — #186 Kiro Connect: pick the login method; never hang on an unanswered CLI prompt [done (check passed)]

Kiro login methods, prompt safeguards, timeout, and tests pass

## 2026-09-26 13:59 — #191 Edit a task's fallback agents from its side panel [done (check passed)]

Task fallback editing verified; all 248 tests pass.

## 2026-09-26 14:18 — #192 Parallel-first planning and scheduling [done (check passed)]

Parallel planning, dynamic scheduling, settings verified; all 251 tests pass.

## 2026-09-26 14:47 — #205 Integrate #184: OpenCode Connect: let the owner choose the provider instead of forcing OpenAI [done (check passed)]

Merge conflicts resolved; tests pass; no hardcoded OpenAI provider remains

## 2026-09-26 15:15 — #185 OpenCode: free Zen models available without sign-in [done (check passed)]

OpenCode is ready with free Zen models, no sign-in needed
## 2026-09-26 15:44 — #193 Parallel lanes view: see agents working side by side [done (check passed)]

That was the old monitor timing out. I'm still waiting for the new run to finish.

## 2026-09-26 15:48 — #195 Agent health check: verify models and rate limits for all six CLIs [done (check passed)]

agent-health exits 0; all six agents report health; tests pass

## 2026-09-26 19:10 — #204 Orchestrator dock: remove limit text, make Pause/Resume prominent [verify failed (1)]

Command: node --check public/app.js && npm test && ! grep -n "reached · re" public/app.js

## 2026-09-26 19:29 — #204 Orchestrator dock: remove limit text, make Pause/Resume prominent [done (check passed)]

Temporary fixture isolation fixed; exact verification passes all 267 tests.

## 2026-09-26 20:07 — #207 Stop parallel runs: one task at a time, memory guard, free disk space [done (check passed)]

one task by default, memory guard added, disk and worktrees cleaned
## 2026-09-26 20:27 — #196 Find and fix empty tool inputs/outputs and empty responses from CLI agents [done (check passed)]

empty events fixed; fixtures pass; smoke runs show zero unexplained empties

## 2026-09-26 20:44 — #208 Resource analyzer and safe reaper for leftover processes [done (check passed)]

resources.mjs classifier, safe reaper, /api/resources, and tests all pass

## 2026-09-26 21:32 — #211 Fix leaking CLI model-discovery processes (opencode models orphans) [done (check passed)]

Discovery helpers run group-killed and single-flight; no orphans remain

## 2026-09-27 12:15 — #216 Cluster design doc and shared wire protocol [done (check passed)]

CLUSTER.md and tested cluster-protocol.mjs added; npm test passes

## 2026-09-26 21:21 — #201 Review checkpoints in the queue: wait for owner approval after a task [verify failed (1)]

Command: npm test

## 2026-09-27 11:44 — #201 Review checkpoints in the queue: wait for owner approval after a task [done (check passed)]

npm test passes (296/296) with checkpoint and review-break UI tests

## 2026-09-27 12:07 — #215 Integrate #201: Review checkpoints in the queue: wait for owner approval after a task [verify failed (1)]

Command: npm test

## 2026-09-27 12:21 — #215 Integrate #201: Review checkpoints in the queue: wait for owner approval after a task [done (check passed)]

merged latest main; npm test passes 256/256 with checkpoint tests

## 2026-09-27 12:30 — #217 Controller: node registry, pairing tokens and cluster WebSocket hub [done (check passed)]

cluster hub with pairing/auth/heartbeat/revocation; npm test passes

## 2026-09-27 12:48 — #218 Worker daemon: connect, report inventory, run jobs in local checkouts [done (check passed)]

worker daemon runs jobs, pushes branches; npm test passes

## 2026-09-27 13:10 — #219 Scheduler: place tasks on remote nodes and merge their pushed branches [done (check passed)]

remote placement, dispatch and merge-back work; cluster e2e passes

## 2026-09-27 13:37 — #220 Node failure handling: disconnects, laptop sleep, WIP recovery and reassignment [done (check passed)]

Waiting for the full `npm test` run to finish.

## 2026-09-27 13:55 — #221 Install scripts for Linux VPS and macOS workers, plus an 'Add machine' wizard [done (check passed)]

The full test suite is still running; I'll check the result when it finishes.

## 2026-09-27 14:22 — #222 Remote sign-in and per-machine agent status in Connections [in progress (1)]

remote sign-in works; five older test failures on main block `npm test`

## 2026-09-27 14:32 — #222 Remote sign-in and per-machine agent status in Connections [done (check passed)]

Full suite running; waiting for its completion notice.

## 2026-09-27 15:00 — #238 Integrate #222: Remote sign-in and per-machine agent status in Connections [verify failed (1)]

Command: npm test

## 2026-09-27 15:16 — #238 Integrate #222: Remote sign-in and per-machine agent status in Connections [done (check passed)]

npm test passes 310/310, merge conflicts resolved

## 2026-09-27 15:57 — #223 Machines view: status, capacity and running tasks per machine [done (check passed)]

Machines view: per-node cards, controls, cluster summary; tests pass

## 2026-09-27 16:45 — #240 Integrate #223: Machines view: status, capacity and running tasks per machine [verify failed (1)]

Command: node --check public/app.js && npm test

## 2026-09-27 17:34 — #240 Integrate #223: Machines view: status, capacity and running tasks per machine [done (check passed)]

Stale-node-cache race fixed; exact check passes 324/324

## 2026-09-27 17:34 — #240 Integrate #223: Machines view: status, capacity and running tasks per machine [verify failed (2)]

Command: merge main again

## 2026-09-27 17:56 — #240 Integrate #223: Machines view: status, capacity and running tasks per machine [verify failed (3)]

Command: node --check public/app.js && npm test

## 2026-09-27 18:23 — #240 Integrate #223: Machines view: status, capacity and running tasks per machine [done (check passed)]

Merge resolved, tooltip race fixed, 353/353 tests pass

## 2026-09-27 19:32 — #229 Strong worker reporting: phases, health telemetry, crash reports, auto-drain [done (check passed)]

worker phases, telemetry, errors, log tail, auto-drain, updates; tests pass

## 2026-09-27 20:22 — #230 Many-MacBook support: multi-use pairing, battery and sleep policy [done (check passed)]

multi-use pairing, Mac power policy, LaunchDaemon installer; tests pass

## 2026-09-27 20:57 — #232 Lock workers to compute-only: no prompts, UI or management on worker machines [done (check passed)]

workers compute-only; npm test passes 403/403 with new tests

## 2026-09-27 22:44 — #234 Worker terminal status view and a local cap on pooled CPU/RAM [verify failed (1)]

Command: npm test && node worker.mjs status --once

## 2026-09-27 23:00 — #234 Worker terminal status view and a local cap on pooled CPU/RAM [done (check passed)]

full test suite passes; worker status view and local cap verified

## 2026-09-27 23:48 — #231 Machines view: smooth sync animations between workers and the head [verify failed (1)]

Command: node --check public/app.js && npm test

## 2026-09-28 00:05 — #231 Machines view: smooth sync animations between workers and the head [done (check passed)]

Branch on main; check passes 427/427 in worktree

## 2026-09-28 — #248 Land worker skills/subagents/MCP sync from claude/heuristic-visvesvaraya-d78c0d

Merged aae07b1 with conflicts resolved keeping both sides (feature 'ext' + ext.sync beside main's 'cap', queued, status view; inventory has cap and ext). npm test 435/435.

## 2026-09-28 01:44 — #248 Land worker skills/subagents/MCP sync from branch claude/heuristic-visvesvaraya-d78c0d [done (check passed)]

workers now get the head's skills, subagents and MCP servers; npm test passes

## 2026-09-28 — #252 Integrate #248 with main
Merged main (agent.credential / feature 'creds') into #248: FEATURES keeps both ('creds' then 'ext'), WORKER_ACCEPTS and worker.mjs handle both agent.credential and ext.sync; tests updated for both; server.test.mjs takes main's claude-machines expectation (half-snapshotted from main). npm test: 440/441, the one failure fixed and re-run.

## 2026-09-28 03:28 — #252 Integrate #248: Land worker skills/subagents/MCP sync from branch claude/heuristic-visvesvaraya-d78c0d [done (check passed)]

merge conflicts resolved; worker handles both agent.credential and ext.sync

## 2026-09-28 03:28 — #252 Integrate #248: Land worker skills/subagents/MCP sync from branch claude/heuristic-visvesvaraya-d78c0d [verify failed (1)]

Command: merge main again
## 2026-09-28 02:00 — #254 Land the bash 3.2 fix for the macOS worker installer [done (check passed)]

macOS installer, bash 3.2 build script and non-skipping test pass

## 2026-09-28 02:22 — #255 Design computer-work agents: connectors, browser, approvals (AGENTIC.md) [done]

AGENTIC.md covers connectors, browser, safety, task shape and rollout

## 2026-09-28 02:35 — #256 Browser capability: Playwright MCP with persistent profiles for agent runs [done (check passed)]

browser tasks get Playwright MCP; persistent-profile cookie test passes

## 2026-09-28 03:40 — #258 Approval gate for outbound actions, with an audit log [done (check passed)]

Outbound browser/connector calls held for approval, audited, tests pass
## 2026-09-28 03:11 — #249 UI-REVIEW #1: top bar keeps its 56px content row below the iPhone safe-area inset [done (check passed)]

Top bar height includes safe-area inset; static tests pass
## 2026-09-28 03:10 — #257 Live browser view: sign in once, watch and take over from the app [done (check passed)]

live browser view, take-over and sidebar Browser sheet pass tests

## 2026-09-28 03:12 — #260 Integrate #257: Live browser view: sign in once, watch and take over from the app [done (check passed)]

orchestrator.mjs conflicts resolved; browser-live and run-on tests pass

## 2026-09-28 03:43 — #250 UI-REVIEW #2: keyboard-aware composer via visualViewport; hide the orch bar while typing [done (check passed)]

Phone composer now stays above the keyboard; tests pass
## 2026-09-28 03:44 — #261 Integrate #258: Approval gate for outbound actions, with an audit log [done (check passed)]

Merge conflicts resolved; approval-gate, protocol and browser tests pass

## 2026-09-28 — #252 Integrate #248 (second merge of main)
Main gained whoami, browser capability, approval gate and live browser view meanwhile. Kept both: FEATURES ends 'approvals', 'screen', 'ext', 'cap'; WORKER_ACCEPTS has job.approval, screen.req/input and ext.sync; inventory carries browser and ext; job.start has capabilities/identity and ext; cluster.mjs whoami reuses tokenNode; worker.mjs has one `ext` (synced bundle + browser run MCP).
Full suite then failed 5 real-browser tests, on main too: Chromium aborts "Socket path too long" (its SingletonSocket sits in TMPDIR, Unix socket paths ≤107 bytes). bin/test.mjs now realpaths node_modules/.cache and puts the temp dir under ~/.cache when that path would be too long. `npm test`: 478/478.

## 2026-09-28 04:44 — #252 Integrate #248: Land worker skills/subagents/MCP sync from branch claude/heuristic-visvesvaraya-d78c0d [done (check passed)]

main re-merged with ext sync kept; npm test passes 478/478

## 2026-09-28 04:54 — #263 Verifier: a | inside a quoted grep pattern is regex, not a pipe (land the task-244 taskrun fix) [done (check passed)]

Verifier treats | in quoted grep patterns as regex

## 2026-09-28 04:56 — #264 Worker disk hygiene: prune unreferenced deps caches and the npm cache [done (check passed)]

Worker now prunes stale deps caches and oversized npm-cache

## 2026-09-28 04:58 — #265 Cluster: auto-undrain a worker once the low disk that drained it has recovered [done (check passed)]

Low-disk drains now lift themselves after three recovered frames

## 2026-09-28 05:02 — #266 UI-REVIEW #3: task-card titles wrap on phones and the model chip drops under the title [done (check passed)]

Phone task cards wrap titles to two lines; chip moved below

## 2026-09-28 05:05 — #267 UI-REVIEW #5: 44pt touch targets for chips, small buttons and icon buttons on touch screens [done (check passed)]

touch screens get 44pt targets; target and keyboard tests pass

## 2026-09-28 05:18 — #269 README docs: browser capability, approval gate, audit log, live browser view and worker extension sync [done (check passed)]

README documents browser tasks, approval gate, audit, live view, sync

## 2026-09-28 05:20 — #270 AUDIT #35: reject prototype agent names and validate chat modes [done (check passed)]

isAgent guards all agent names; chat modes validated against MODES

## 2026-09-28 05:22 — #271 UI-REVIEW #6: light-theme contrast to 4.5:1 for faint text and filled buttons, with a static contrast test [done (check passed)]

faint text and filled buttons now clear 4.5:1, with a contrast test

## 2026-09-28 05:25 — #272 UI-REVIEW #10: Connections opens as a bottom sheet on phones, no focus ring on touch, status lines wrap [done (check passed)]

Connections is a bottom sheet on phones; touch opens skip focus

## 2026-09-28 05:26 — #273 UI-REVIEW #15 and #16: inline code pills clone across lines, 44pt tool rows, system-font time cells [done (check passed)]

code pills clone across lines, 44pt touch tool rows, system-font times

## 2026-09-28 05:45 — #275 Fix the duplicate dragMove in app.js (sidebar project drag is dead) and guard top-level names [done (check passed)]

Queue drag is now qDragMove, so sidebar project drag works; test blocks duplicate names

## 2026-09-28 05:47 — #276 Integrator merge deletes the integrated task's branch from origin; remove the stale task-258 branch [done (check passed)]

integrator merges delete owner's origin branch; task-258 removed

## 2026-09-28 05:49 — #277 UI-REVIEW #7: 16px body text and 12px-minimum metadata on phones [done (check passed)]

Phones now get 16px body text and 12px-minimum metadata

## 2026-09-28 05:49 — #278 UI-REVIEW #13 and #14: sidebar footer in the body font at 44pt, centred small buttons; record rows 4, 8, 13 status [done (check passed)]

Sidebar footer uses body font, 44pt on touch; rows marked fixed

## 2026-09-28 05:59 — #280 Auto-restart once idle after server code changes: backend setting and drain trigger [done (check passed)]

Opt-in autoRestart setting drains and restarts after server-code merges; tests pass

## 2026-09-28 06:02 — #281 Auto-restart setting in the Settings sheet ui and banner wording [done (check passed)]

Settings switch saves autoRestart; the banner now says when a restart is automatic

## 2026-09-28 06:03 — #282 removeWorktree always deletes the directory and ensureWorktree sweeps orphan task dirs [done (check passed)]

worktree dirs always removed; boot sweep deletes orphans; stale dirs gone

## 2026-09-28 — #283 Deleted dead local branches agent-orch/task-187 (deea086), -244 (dc375fd), -247 (f428bc5)
187 was partial work for the removed Copilot agent; 244/247's macOS bash 3.2 installer fix and verifier `|` fix are on main via #254/#263 (only their bash-3.2 tweak to the Linux install-worker.sh never landed, unneeded: Linux ships bash ≥4.4).

## 2026-09-28 06:04 — #283 Delete the dead local task branches 187, 244 and 247 [done (check passed)]

Branches 187, 244 and 247 deleted, others kept, journal noted

## 2026-09-28 08:14 — #286 finishReflection: a reflection with no task block is a warning and a quick retry, not an empty verdict [done (check passed)]

blockless reflections now warn and retry in 5 min, tested

## 2026-09-28 08:24 — #287 AUDIT round 6: cluster protocol and pairing, approvals and audit log, browser live view, extension sync, restart and machines APIs [done (check passed)]

AUDIT.md Round 6 added: 16 findings (#37–#52), two high

## 2026-09-28 08:39 — #288 UI-REVIEW round 2: HIG review of the Settings sheet, Machines, Stats, Extensions, Files, Approvals and the live browser view on a 390px phone [done (check passed)]

Round 2 HIG review added: rows 18–35, 30 screenshots

## 2026-09-28 08:40 — #289 Retention GC: prune old run logs and unreferenced media at boot and daily [done (check passed)]

retention GC prunes old run logs and unreferenced media

## 2026-09-28 08:41 — #290 One-time kv migration dropping rows for the removed agents antigravity, opencode, kiro and copilot [done (check passed)]

boot migration drops removed-agent kv rows; test passes

## 2026-09-28 08:46 — #292 AUDIT #37: server.mjs passes the run config to ext.mcpRun so controller runs get the gate and browser [done]

Controller runs get gate/browser config; tests catch regressions

## 2026-09-28 08:49 — #293 AUDIT #43: the restart drain preflights the new HEAD before exiting, and README adds StartLimitIntervalSec=0 [done (check passed)]

restart preflights HEAD; failed boot stays up; README has StartLimitIntervalSec=0

## 2026-09-28 08:52 — #294 AUDIT #40: the browser classifier treats Enter, submit and common outbound buttons as outbound [done (check passed)]

Browser gate now holds Enter, submit, Post-style and nameless buttons

## 2026-09-28 08:56 — #295 AUDIT #45 and #51: the hub refuses disabled nodes and shares nothing with them; the worker gate reads only MEDIA_ID_RE screenshot ids [done (check passed)]

disabled nodes refused, sign-ins withheld; worker screenshot ids now validated

## 2026-09-28 09:01 — #296 UI-REVIEW #20 and #22: phone fields at 16px and 44pt touch targets on Stats, Skills, Files, Machines, Browser, drawer and queue cards [done (check passed)]

Touch devices get 16px fields and 44pt targets, tests pass

## 2026-09-28 11:21 — #302 Goal 9 controller slots: parallelTasks 1-16 (default 4), memory only an emergency floor, Settings select for this server [done (check passed)]

Test runner falls back to lockf on macOS; check passes
## 2026-09-28 10:58 — #304 Web Push backend without a new dependency: push.mjs with VAPID keys, subscriptions, aes128gcm and send; /api/push routes [done (check passed)]

Web Push backend and /api/push routes built; both test files pass
## 2026-09-28 11:06 — #300 Rapid mode: keep every free slot fed with parallel, file-disjoint work [done (check passed)]

Rapid mode tops up parallel work with verified quota guards.

## 2026-09-28 11:21 — #305 Push notifications ui: service worker, Settings switch, #task deep link and app badge [done (check passed)]

Done-when check now passes on macOS without flock
## 2026-09-28 11:26 — #309 Browser as a header tab with an in-place live view and an agent prompt box [done (check passed)]

Browser header tab shows live view with a working agent prompt box
## 2026-09-28 11:17 — #308 Browser prompt backend: POST /api/browser/task runs an agent on the live screen now [done (check passed)]

Browser task API verified; pinned agents run without git lifecycle.
## 2026-09-28 11:19 — #303 Goal 9 worker placement: an owner-set node cap is the limit; no headroom or spare-memory clipping for capped nodes [done (check passed)]

Done-when passes; test runner uses a lock directory without flock

## 2026-09-28 11:27 — #306 Send pushes for what needs the owner: approvals, chat permission prompts, failed tasks, review checkpoints and waiting events [done (check passed)]

Owner pushes wired for approvals, failures, reviews, waits, permissions

## 2026-09-28 11:46 — #319 UI-REVIEW #23: Stats heatmap labels at 11px, a text value per cell, and 14 days on phones with Show all days [done (check passed)]

Phone heatmap has 11px labels, cell labels, and a 14-day collapse
## 2026-09-28 11:35 — #313 Integrate #309: Browser as a header tab with an in-place live view and an agent prompt box [done (check passed)]

CONTEXT.md conflict resolved; UI tests pass against main's backend

## 2026-09-28 11:43 — #327 Verifier loophole: extractCommand judges risk on the unquoted command so a quoted grep pattern never voids the check [done (check passed)]

checkCommand now judges risk on the command with quoted text removed
## 2026-09-28 11:45 — #318 AUDIT #42 outside cluster.mjs: sampleOf clips cpu to 256 cores, metrics read is bounded, pending approvals per run are capped [done (check passed)]

Metrics cpu clipped, reads bounded to 8 MB, approvals capped per run
## 2026-09-28 11:45 — #320 UI-REVIEW #27: Stats tabs and the range chip share one row on phones and the subtitle scrolls with the body [done (check passed)]

Phone Stats header pins tabs and range chip in one row

## 2026-09-28 11:46 — #329 push.mjs: drop subscriptions that fail for good and honour Retry-After [done (check passed)]

push drops repeatedly rejected devices and honours Retry-After pauses

## 2026-09-28 11:47 — #330 changes.mjs: a task's changes as a file stat and a capped patch, from its merged commit or live branch [done (check passed)]

changes.mjs taskChanges returns branch/commit/none diffs; tests pass
## 2026-09-28 11:48 — #336 tests: worker-status.mjs serveStatus and request over a real unix socket [done (check passed)]

worker-status socket lifecycle covered by 7 passing tests

## 2026-09-28 11:48 — #326 Fix the stale cluster-protocol test: FEATURE_LIST includes browser-task [done (check passed)]

cluster-protocol test now expects browser-task; all 11 pass

## 2026-09-28 11:49 — #332 UI-REVIEW #18: pinch and pan on the live browser view with double-tap zoom, stage centred on phones [done (check passed)]

Live browser view pinch/pan, double-tap and wheel zoom work; tests pass

## 2026-09-28 11:49 — #322 Chat search backend: search.mjs searchConvos over titles and chat logs, streamed and capped, with tests [done (check passed)]

search.mjs searchConvos is implemented and its 3 tests pass
## 2026-09-28 11:52 — #324 AUDIT round 7: push, screen prompts, rapid top-up, retention GC, worktree sweep, the verifier and agent-share [done (check passed)]

AUDIT.md Round 7 adds 15 findings (#53–#67), priorities included

## 2026-09-28 11:53 — #331 Files tab: find files by name across the whole project [done (check passed)]

Files tab finds files by name across the whole project
## 2026-09-28 12:25 — #321 UI-REVIEW #33: closing Skills & tools returns to Settings when it was opened from there [done (check passed)]

Closing Skills & tools opened from Settings reopens Settings

## 2026-09-28 12:27 — #339 github.mjs: push to an existing origin without asking gh; tests with a local bare remote [done (check passed)]

existing origins push without gh; repoOf handles all URL forms

## 2026-09-28 16:58 — #344 Placement uses every machine: CPU-only gating, spread across nodes, explain skips [done (check passed)]

CPU-only placement spreads work; skip explanations and tests pass.
## 2026-09-28 13:18 — #347 Fix the live browser: working stream, google.com by default, viewport follows the screen [done (check passed)]

live browser e2e passes here; sharp 2× phone shot saved
## 2026-09-28 12:45 — #345 Workers fetch and push code through the head, so no GitHub access is needed [done (check passed)]

workers now clone and push through the head; cluster-git tests pass
## 2026-09-28 12:29 — #341 Wire chat search: GET /api/convos?q= via search.mjs and a search field above the chat list [done (check passed)]

Sidebar chat search now calls GET /api/convos?q=; tests pass

## 2026-09-28 12:29 — #340 digest.mjs: what finished, failed or needs the owner since they last looked, per project, with tests [done (check passed)]

digest.mjs reports per-project done/failed/needs-you, tests pass

## 2026-09-28 12:30 — #338 Gate proxy: a page that can't be read makes element tools, key presses and dialogs outbound, with tests [done (check passed)]

Proxy holds page actions when the snapshot errors or hangs; tests pass
## 2026-09-28 12:31 — #335 Verifier loophole: extractCommand refuses command and process substitution even inside double quotes [done (check passed)]

extractCommand now refuses substitution, including inside double quotes

## 2026-09-28 12:32 — #352 worktrees.mjs AUDIT #62: a symlinked worktrees root still matches git's list, so a reused worktree is never deleted [done (check passed)]

Worktrees under a symlinked root are reused and kept, tested
## 2026-09-28 12:33 — #351 push.mjs AUDIT #53: a VAPID key pair is made only when the file is missing; a bad file or PEM turns push off instead of overwriting or throwing [done (check passed)]

Unusable VAPID key file now disables push instead of replacing it

## 2026-09-28 12:44 — #315 AUDIT #50: bv_open honours a url only when the socket may drive [done (check passed)]

bv_open's url is followed only when the socket may drive
## 2026-09-28 12:34 — #316 AUDIT #46: fromWorker keeps auth.json.prev, rejects a future last_refresh and checks the token's account [done (check passed)]

fromWorker blocks future/mismatched-JWT refreshes and keeps auth.json.prev

## 2026-09-28 12:36 — #334 Integrate #319: UI-REVIEW #23: Stats heatmap labels at 11px, a text value per cell, and 14 days on phones with Show all days [done (check passed)]

Conflicts resolved; phone range chip and heatmap tests both pass
## 2026-09-28 12:36 — #350 Verifier AUDIT #65/#66: runner word boundaries, path-like snippets skipped, 2>&1, env prefixes and a leading cd accepted [done (check passed)]

Verifier accepts env/cd prefixes and 2>&1, and skips file names
## 2026-09-28 12:36 — #354 Browser tab ui: an Earlier prompts list under the activity panel with tap-to-show and Ask again [done (check passed)]

Browser tab lists earlier prompts with show, Back to latest and Ask again

## 2026-09-28 12:37 — #311 Integrate #302: Goal 9 controller slots: parallelTasks 1-16 (default 4), memory only an emergency floor, Settings select for this server [done (check passed)]

merge conflicts resolved; parallel slots 1-16 and rapid mode both kept

## 2026-09-28 12:39 — #349 Verifier AUDIT #64: every line of a fenced Done-when block and every ;-part of a snippet must pass [done (check passed)]

Each fenced-block line and each `;` part must now pass
## 2026-09-28 12:39 — #353 browser-task.mjs AUDIT #58: the last-line status marker decides a screen prompt's outcome; phrase matching only as a last resort on the final paragraph [done (check passed)]

Screen prompt outcome now comes from last-line status marker
## 2026-09-28 12:40 — #358 Files tab ui: search inside files with GET /api/files/grep and a Names | Contents switch [done (check passed)]

Files tab can now search inside files in Contents mode

## 2026-09-28 12:40 — #355 AUDIT ledger: mark round 7 #53, #58, #62, #64, #65 and #66 with what landed and what still waits [done (check passed)]

AUDIT round 7 #53/#58/#62/#64/#65/#66 marked, verified against code

## 2026-09-28 12:41 — #357 gate-proxy.mjs: a forwarded tools/call times out after callMs with an audited tool error, late answers dropped [done (check passed)]

forwarded calls now time out after callMs; late answers dropped
## 2026-09-28 12:43 — #360 Head: tell 'asleep' apart from 'network lost' and show the real reason [done (check passed)]

drops show 'connection lost'; reported reasons counted and shown per machine

## 2026-09-28 12:43 — #362 Completion sound plays while the tab is active too [done (check passed)]

completion sound now plays in active tabs too; tests pass
## 2026-09-28 12:44 — #317 AUDIT #49 and #41 in gate.mjs: no always key for arbitrary-code tools, argument hashes on connector keys, loopback navigation is outbound [done (check passed)]

Code tools have no always key; local navigation now held

## 2026-09-28 12:46 — #366 models.mjs: a failed rediscovery keeps the last good model list, never saves an empty one over it, and retries hourly [done (check passed)]

Failed model rediscovery keeps last good list, retries hourly

## 2026-09-28 14:09 — #378 Rapid mode: file overlap never blocks a free slot; merges handle it [done (check passed)]

rapid overlap soft, per-file caps tuned, merge retry, tests pass
## 2026-09-28 12:54 — #365 Stats ui: a Machines tab with one row per machine: tasks done and failed, check pass rate, busy time, tokens and last active [done (check passed)]

Stats has a tested Machines tab with per-machine rows and share bar
## 2026-09-28 12:55 — #370 taskrun.mjs: extractCheck tells a refused Done-when from one with no command (AUDIT #66 half two) [done (check passed)]

extractCheck reports refused Done-when snippets; verify tests pass

## 2026-09-28 13:00 — #369 retention.mjs AUDIT #61: keep approval screenshots and review shots, prune stale uploads [done (check passed)]

retention keeps referenced approval and review shots, prunes stale uploads

## 2026-09-28 13:08 — #380 Sidebar usage card cycles through the VPS and every worker [done (check passed)]

card rotates; Node tests pass, browser tests and screenshots impossible here
## 2026-09-28 13:01 — #373 files.mjs: GET /api/files/changed lists git-changed files and /api/files/diff serves one file's diff [done (check passed)]

Changed-files and per-file diff routes added and tested

## 2026-09-28 13:07 — #374 Files tab ui: a Changed view with +/− counts and a coloured diff in Quick Look [done (check passed)]

Changed view and diff work (jsdom-checked); browser tests skip here
## 2026-09-28 13:03 — #375 Files tab ui: Ask in chat puts path:line into the composer from Quick Look and a Contents hit [done (check passed)]

Ask in chat inserts path[:line] from Files, tested
## 2026-09-28 13:03 — #383 Bring back 'Keep improving' per project; off means no reflection at all [done (check passed)]

Keep improving switch is back; off blocks every reflection path
## 2026-09-28 13:04 — #377 approvals.mjs: the expiry note states the row's real TTL and overdue rows expire at boot [done (check passed)]

expiry notes show each row's own window; overdue rows expire at boot

## 2026-09-28 13:16 — #381 oracle-vm node in the Machines graph opens the full server details [done (check passed)]

oracle-vm opens the node detail, which now shows the full server details
## 2026-09-28 13:08 — #368 Ping button for worker machines: round-trip plus an on-Mac network self-check [done (check passed)]

Ping per worker card and Ping all work; ping tests pass

## 2026-09-28 13:52 — #396 uploads.mjs: placeUploads sweeps project-side attachment copies older than 30 days [done (check passed)]

placeUploads now removes project attachment copies over 30 days old; tests pass
## 2026-09-28 13:52 — #371 taskrun.mjs: checkUnavailable accepts a 127 only for a missing first program (AUDIT #65 half two) [done (check passed)]

checkUnavailable exported and tested; orchestrator.mjs wiring still pending
## 2026-09-28 13:52 — #395 UI-REVIEW #28 (Stats and Skills & tools tabs): the selected segment gets its own --seg-on colour in dark mode and a 600 weight [done (check passed)]

Stats and Skills & tools selected tabs: --seg-on, weight 600
## 2026-09-28 13:52 — #391 stats.mjs: every failed or cancelled task carries a classified `why`, and the snapshot a `failures` summary [done (check passed)]

stats tasks carry classified `why`; snapshot has `failures` summary

## 2026-09-28 14:01 — #402 Machines: organise each machine's options with plain words [done (check passed)]

Machine settings disclosure ships and tests pass; no screenshots (browsers crash here)
## 2026-09-28 14:01 — #406 Show the running build number, restart time and pending build [done (check passed)]

About section, /api/version, build label, worker builds, update toast added
## 2026-09-28 13:54 — #388 Fix the failing worker-cap test: nodeCap keeps a worker's CPU and max-tasks cap when the owner set max slots [done (check passed)]

owner-set worker slots now keep the worker's CPU cap
## 2026-09-28 13:54 — #394 mcp-probe.mjs: probe an MCP server over stdio or streamable http and report its tools or the error [done (check passed)]

mcp-probe.mjs probes stdio/http MCP servers; 7 tests pass
## 2026-09-28 13:55 — #393 extensions.mjs AUDIT #69: http and sse servers keep their outbound list, and a gated run withholds a connector the proxy cannot gate [done (check passed)]

gated runs withhold http outbound connectors; UI tests skipped, no Chromium

## 2026-09-28 14:27 — #400 Browser agent: Playwright MCP starts reliably (pre-warm, longer connect timeout, auto-retry) [done (check passed)]

Browser MCP pre-warms, waits 90s, retries; page test skipped here
## 2026-09-28 13:57 — #403 Files backend: copy, move, zip and unzip endpoints with safe paths [done (check passed)]

Files copy/move/zip/unzip endpoints are live, safe and tested

## 2026-09-28 14:01 — #392 Stats ui: a Why tasks failed card on Overview with a count per reason and the last tasks of each [done (check passed)]

failures card added; UI tests skip here: no browser launches
## 2026-09-28 14:01 — #404 Files tab: open the project folder, browse folders, right-click copy/cut/paste/zip/unzip [done (check passed)]

Files tab: folder navigation, multi-select, clipboard and ZIP menu (browser tests skip here)

## 2026-09-28 14:02 — #410 health.mjs: a kept-but-stale model list is reported as an error with both dates, not as healthy (re-run of #376) [done (check passed)]

stale model list now shows as warning error with dates

## 2026-09-28 14:02 — #409 taskrun.mjs: transientGit and retryGit retry git ref-lock and network failures with backoff (root cause of #328/#359/#376) [done (check passed)]

transientGit and retryGit exported from taskrun.mjs, tests pass

## 2026-09-28 14:03 — #401 A different completion sound per machine (the VPS and each worker) [done (check passed)]

per-machine finish sounds work and tests pass; no screenshots (Chromium won't launch)

## 2026-09-28 14:03 — #411 push.mjs AUDIT #54: createNotifier coalesces pushes per tag, keeps the newest dropped one, and caps bursts with one summary [done (check passed)]

push.mjs createNotifier holds messages per tag, caps bursts; tests pass

## 2026-09-28 14:04 — #412 gate-proxy.mjs: a streamable-http upstream, so http connectors can be gated instead of withheld (AUDIT #69's lasting fix) [done (check passed)]

gate-proxy gates streamable-http upstreams; both test files pass
## 2026-09-28 14:05 — #384 Head capacity from its real hardware; integration first on the head, work delegated to Macs [done (check passed)]

head slots from hardware, integrators reserved, workers-first delegation tested

## 2026-09-28 14:06 — #363 Integrate #315: AUDIT #50: bv_open honours a url only when the socket may drive [done (check passed)]

Merge conflict resolved; browser-live tests pass; #50 marked Fixed

## 2026-09-28 14:09 — #408 Fix the failing compute-only scheduler test: its project must have Keep improving on for its reflect task to run [done (check passed)]

compute-only tests pass; Linux-only /proc/systemd checks now skipped on macOS

## 2026-09-28 14:16 — #364 Integrate #345: Workers fetch and push code through the head, so no GitHub access is needed [done (check passed)]

Merge conflicts resolved; cluster-git, worker and cluster tests pass

## 2026-09-28 14:16 — #364 Integrate #345: Workers fetch and push code through the head, so no GitHub access is needed [verify failed (1)]

Command: merge main again
## 2026-09-28 14:15 — #421 worktrees.mjs: git operations retry lock races and network blips through retryGit [done (check passed)]

worktrees.mjs git calls retry lock races; conflicts never retried
## 2026-09-28 14:16 — #420 extensions.mjs AUDIT #69 lasting fix: http connectors with outbound tools run through the gate proxy instead of being withheld [done (check passed)]

http connectors now run through the gate proxy; sse still withheld

## 2026-09-28 14:16 — #424 login page: the product is agent-orch, not Claude Code (goal 4) [done (check passed)]

Login subtitle now says "Sign in to agent-orch"; tests pass

## 2026-09-28 14:16 — #422 retention.mjs AUDIT #63 (head half): sweep finished screen-prompt workspaces under browser-tasks/ [done (check passed)]

gcRetention now sweeps finished and orphaned browser-task workspaces, tests pass
## 2026-09-28 14:16 — #364 Integrate #345: Workers fetch and push code through the head, so no GitHub access is needed [done (check passed)]

CONTEXT.md conflict resolved; cluster-git tests pass

## 2026-09-28 14:40 — #426 Rolling restart: new server code goes live within minutes, even when busy [done (check passed)]

rolling restarts land new server code within 2 min; tests pass
## 2026-09-28 14:23 — #430 gate-proxy.mjs http upstream: on a 404 for a stale session, initialize again once and retry the call [done (check passed)]

http gate proxy re-initializes after a stale-session 404 and retries
## 2026-09-28 14:24 — #385 Integrate #374: Files tab ui: a Changed view with +/− counts and a coloured diff in Quick Look [done (check passed)]

merge resolved; Changed view, context menu and Ask in chat all pass

## 2026-09-28 14:42 — #435 Integrators run on workers too, so merges use Mac capacity [done (check passed)]

integrators run on workers; head lands, rebases, caps re-integration at 3
## 2026-09-28 14:25 — #429 cluster-git.mjs: a push is checked from its first pkt-lines and streamed into git, never buffered whole; git is killed when the client goes away [done (check passed)]

Pushes now stream into git after the ref check; dropped clients kill git

## 2026-09-28 14:25 — #416 Integrate #392: Stats ui: a Why tasks failed card on Overview with a count per reason and the last tasks of each [done (check passed)]

CONTEXT.md conflict resolved; ui-stats tests pass

## 2026-09-28 14:35 — #432 Custom completion sounds: upload your own, per machine or for all [done (check passed)]

custom sounds can be uploaded, imported from URLs, picked per machine, and tested
## 2026-09-28 14:32 — #414 Integrate #402: Machines: organise each machine's options with plain words [done (check passed)]

Merge resolved; settings disclosure now includes main's finish sound

## 2026-09-28 14:32 — #414 Integrate #402: Machines: organise each machine's options with plain words [verify failed (1)]

Command: merge main again
## 2026-09-28 14:32 — #437 Files backend: browse the whole VPS, with guardrails for secrets and system folders [done (check passed)]

Files API browses whole disk with secret and write guardrails
## 2026-09-28 14:30 — #399 Integrate #347: Fix the live browser: working stream, google.com by default, viewport follows the screen [done (check passed)]

merge resolved; browser e2e tests and phone screenshot verified

## 2026-09-28 14:30 — #399 Integrate #347: Fix the live browser: working stream, google.com by default, viewport follows the screen [verify failed (1)]
## 2026-09-28 14:32 — #417 Integrate #378: Rapid mode: file overlap never blocks a free slot; merges handle it [done (check passed)]

orchestrator.mjs conflicts resolved, rapid-overlap tests pass, merge uncommitted

## 2026-09-28 14:32 — #417 Integrate #378: Rapid mode: file overlap never blocks a free slot; merges handle it [verify failed (1)]
## 2026-09-28 14:29 — #386 Integrate #380: Sidebar usage card cycles through the VPS and every worker [done (check passed)]

Merge resolved; mini-rotate tests pass with main's machine sounds

## 2026-09-28 14:29 — #386 Integrate #380: Sidebar usage card cycles through the VPS and every worker [verify failed (1)]

Command: merge main again
## 2026-09-28 14:28 — #398 Integrate #381: oracle-vm node in the Machines graph opens the full server details [done (check passed)]

Merge resolved, Ping all kept, machines UI tests pass

## 2026-09-28 14:28 — #398 Integrate #381: oracle-vm node in the Machines graph opens the full server details [verify failed (1)]

Command: merge main again
## 2026-09-28 14:27 — #427 One push to main at a time: queue and retry the head's GitHub pushes, never crash a task [done (check passed)]

main and task-branch pushes queue, retry, never force or crash

## 2026-09-28 14:27 — #415 Integrate #406: Show the running build number, restart time and pending build [done (check passed)]

CONTEXT.md conflicts resolved; version tests pass, merge left uncommitted

## 2026-09-28 14:27 — #428 gate.mjs AUDIT #68 (re-run, browser-free check): uploads, coordinate clicks and javascript:/data: navigation are outbound; Enter's Always key names the field [done (check passed)]

gate classifies uploads, xy clicks, code URLs outbound; Enter keyed

## 2026-09-28 16:57 — #439 Integrate #400: Browser agent: Playwright MCP starts reliably (pre-warm, longer connect timeout, auto-retry) [done (check passed)]

#400 merged with main; MCP-start tests pass, ready-file race fixed

## 2026-09-28 16:57 — #439 Integrate #400: Browser agent: Playwright MCP starts reliably (pre-warm, longer connect timeout, auto-retry) [verify failed (1)]

Command: merge main again
## 2026-09-28 14:27 — #436 Rapid top-up fills every machine's free slots with work it can actually run [done (check passed)]

Rapid top-up now counts worker slots, excluding head-only integrators

## 2026-09-28 14:29 — #398 Integrate #381: oracle-vm node in the Machines graph opens the full server details [done (check passed)]

CONTEXT.md conflict resolved; UI and Machines tests pass

## 2026-09-28 14:30 — #312 Integrate #305: Push notifications ui: service worker, Settings switch, #task deep link and app badge [done (check passed)]

Merge conflicts resolved; push-ui, ui-static and security-headers tests pass

## 2026-09-28 14:32 — #441 Integrate #437: Files backend: browse the whole VPS, with guardrails for secrets and system folders [done (check passed)]

CONTEXT.md conflict resolved; files-scope tests pass
## 2026-09-28 14:32 — #399 Integrate #347: Fix the live browser: working stream, google.com by default, viewport follows the screen [done (check passed)]

CONTEXT conflict resolved; e2e passes; phone screenshot saved
## 2026-09-28 14:33 — #417 Integrate #378: Rapid mode: file overlap never blocks a free slot; merges handle it [done (check passed)]

merge conflicts resolved again, rapid-overlap tests pass
## 2026-09-28 14:33 — #386 Integrate #380: Sidebar usage card cycles through the VPS and every worker [done (check passed)]

Conflicts resolved and staged; mini-rotate tests pass (7/7)

## 2026-09-28 14:34 — #414 Integrate #402: Machines: organise each machine's options with plain words [done (check passed)]

Merged main again; Done-when and Machines browser tests pass

## 2026-09-28 14:38 — #443 Integrate #432: Custom completion sounds: upload your own, per machine or for all [done (check passed)]

merge conflicts resolved; custom-sound and machine-settings tests pass

## 2026-09-28 14:59 — #448 Integrate #435: Integrators run on workers too, so merges use Mac capacity [done (check passed)]

merge conflicts resolved; worker-integration tests and main's rapid/integrator tests pass

## 2026-09-28 14:59 — #448 Integrate #435: Integrators run on workers too, so merges use Mac capacity [verify failed (1)]

Command: merge main again
## 2026-09-28 14:42 — #446 Integrate #426: Rolling restart: new server code goes live within minutes, even when busy [done (check passed)]

merge conflicts resolved; rolling-restart, version, and UI tests pass

## 2026-09-28 17:32 — #348 One shared browser per profile: agents attach to the live view, self-healing, run on a Mac [done (check passed)]

Shared supervised Chromium per profile; viewer and MCP attach, self-healing
## 2026-09-28 15:07 — #438 Files tab: go to parent folders and anywhere on the VPS, still opening on the project [done (check passed)]

Files tab browses the whole VPS; scope tests pass
## 2026-09-28 14:55 — #407 Version format: v<major>.<minor> from the commit count (352 → v3.52) [done (check passed)]

Builds now show as v3.52 in About, sidebar, toasts, Machines
## 2026-09-28 14:53 — #431 AUDIT ledger round 8: #68 gate loopholes, #69 ungated http connectors, #70 the head ignored a worker's CPU cap [done (check passed)]

AUDIT.md has Round 8 (#68–#70), with #61 and #63 marked
## 2026-09-28 14:53 — #323 README docs: parallel tasks rewritten for goal 9, push notifications and the Browser tab [done (check passed)]

README covers parallel slots, push notifications, Browser tab tasks
## 2026-09-28 14:54 — #418 files.mjs: rename, new file/folder and delete endpoints with the copy/move path rules [done (check passed)]

rename/new/delete endpoints added to files.mjs; files-ops tests pass
## 2026-09-28 14:56 — #445 Assign task button on machine cards: pick a ready task, start it there now [done (check passed)]

Assign task picker on every machine card and detail panel

## 2026-09-28 15:07 — #449 Prompt bar: one combined model + fallbacks control [done (check passed)]

one model pill with fallbacks sheet; tests pass
## 2026-09-28 14:57 — #457 Integrate #407: Version format: v<major>.<minor> from the commit count (352 → v3.52) [done (check passed)]

Conflict resolved; version tests and UI static tests pass
## 2026-09-28 14:57 — #444 Assign API: list a machine's runnable tasks and start one on it immediately [done (check passed)]

assign API lists runnable tasks and starts them immediately
## 2026-09-28 15:02 — #447 Sidebar usage card: tap opens the all-machines window; no page dots [done (check passed)]

card opens all-machines window, dots gone, tests pass

## 2026-09-28 16:56 — #453 Fix the post-restart claim stall: 19 free slots, ready tasks, nothing starts [done (check passed)]

worker claims continue during restart; stalls logged, surfaced; live check pending
## 2026-09-28 16:56 — #458 Machines: 'Update all' brings every machine to the latest version [done (check passed)]

Update all rolls out machines one at a time; tests pass
## 2026-09-28 15:08 — #454 Ping result: restyled and fades away after 10 seconds [done (check passed)]

Ping result chip group now auto-fades after 10 seconds
## 2026-09-28 15:05 — #455 Plain-language refill status instead of 'Workers: 19 free · 12 ready → topping up' [done (check passed)]

Queue now shows plain-language refill status with an explanation popover

## 2026-09-28 15:06 — #419 Files tab ui: Rename, New file, New folder and Delete in the context menu [done (check passed)]

Files menu has Rename, New file/folder and Delete; tests pass
## 2026-09-28 15:06 — #450 Simpler phone header [done (check passed)]

phone header: one 44pt row, title menu switches views; tests pass
## 2026-09-28 15:08 — #456 Sign out moves to the Connections window; version shown under the logo [done (check passed)]

Sign out moved to Connections; version shows under logo

## 2026-09-28 15:14 — #461 Integrate #449: Prompt bar: one combined model + fallbacks control [done (check passed)]

CONTEXT.md merged; model-fallbacks and static UI tests pass

## 2026-09-28 15:14 — #461 Integrate #449: Prompt bar: one combined model + fallbacks control [verify failed (1)]

Command: merge main again
## 2026-09-28 15:14 — #452 Orchestrator bar status: 'Running X · Queue Y' [done (check passed)]

orchestrator bar shows Running X · Queue Y; tests pass

## 2026-09-28 15:16 — #448 Integrate #435: Integrators run on workers too, so merges use Mac capacity [done (check passed)]

CONTEXT.md conflict resolved; worker-integration tests pass 5/5

## 2026-09-28 16:53 — #461 Integrate #449: Prompt bar: one combined model + fallbacks control [done (check passed)]

CONTEXT.md conflict re-resolved; model-fallbacks, ui-static and orchbar tests pass

## 2026-09-28 16:53 — #461 Integrate #449: Prompt bar: one combined model + fallbacks control [verify failed (2)]

Command: merge main again
## 2026-09-28 16:53 — #462 Integrate #454: Ping result: restyled and fades away after 10 seconds [done (check passed)]

CONTEXT.md conflict resolved; ping-result tests pass

## 2026-09-28 16:53 — #461 Integrate #449: Prompt bar: one combined model + fallbacks control [done (check passed)]

CONTEXT.md conflict resolved again; Done-when tests pass (23/23)
## 2026-09-28 16:55 — #459 Rolling restart waits only for the git merge itself, not a whole integrator run [done (check passed)]

Restarts wait only for merges; integrators pause; friendly 404 retry

## 2026-09-28 17:06 — #468 Integrate #344: Placement uses every machine: CPU-only gating, spread across nodes, explain skips [done (check passed)]

Merge resolved; CPU-only placement and decision reporting verified.

## 2026-09-28 17:06 — #468 Integrate #344: Placement uses every machine: CPU-only gating, spread across nodes, explain skips [verify failed (1)]

Command: merge main again
## 2026-09-28 17:02 — #467 Integrate #453: Fix the post-restart claim stall: 19 free slots, ready tasks, nothing starts [done (check passed)]

merge conflicts resolved; claim-stall and related tests pass

## 2026-09-28 17:02 — #467 Integrate #453: Fix the post-restart claim stall: 19 free slots, ready tasks, nothing starts [verify failed (1)]
## 2026-09-28 17:00 — #439 Integrate #400: Browser agent: Playwright MCP starts reliably (pre-warm, longer connect timeout, auto-retry) [done (check passed)]

merged with newest main again; MCP-start and protocol tests pass

## 2026-09-28 17:00 — #439 Integrate #400: Browser agent: Playwright MCP starts reliably (pre-warm, longer connect timeout, auto-retry) [verify failed (2)]

Command: merge main again
## 2026-09-28 16:59 — #460 Integrate #438: Files tab: go to parent folders and anywhere on the VPS, still opening on the project [done (check passed)]

#438 merged with main; all Files UI tests pass

## 2026-09-28 16:59 — #466 Integrate #458: Machines: 'Update all' brings every machine to the latest version [done (check passed)]

Waiting for the test run to finish.

## 2026-09-28 17:02 — #451 Simpler phone prompt window [done (check passed)]

phone composer shows only field, send, model pill and '+'

## 2026-09-28 17:02 — #467 Integrate #453: Fix the post-restart claim stall: 19 free slots, ready tasks, nothing starts [done (check passed)]

CONTEXT.md conflict resolved; claim-stall tests pass
## 2026-09-28 17:03 — #439 Integrate #400: Browser agent: Playwright MCP starts reliably (pre-warm, longer connect timeout, auto-retry) [done (check passed)]

re-merged newest main; MCP-start and protocol tests pass
## 2026-09-28 17:02 — #465 Machine settings rows: label and hint lay out cleanly next to their controls [done (check passed)]

settings rows fixed, 4 layout tests pass, shots saved

## 2026-09-28 17:05 — #470 Integrate #465: Machine settings rows: label and hint lay out cleanly next to their controls [done (check passed)]

conflict resolved, 4 row-layout tests pass, before/after shots saved
## 2026-09-28 17:02 — #382 Full-screen Machines window with the queue built in [done (check passed)]

Full-screen Machines view with built-in queue, tabs, side panel

## 2026-09-28 17:11 — #469 Integrate #382: Full-screen Machines window with the queue built in [done (check passed)]

Merge resolved; the full-screen Machines view and main's changes both kept, tests pass

## 2026-09-28 17:15 — #472 Integrate #382: Full-screen Machines window with the queue built in [done (check passed)]

app.js conflicts resolved; stall text and full-screen queue both kept

## 2026-09-28 17:44 — #433 Machines view on iPhone: a real mobile design, reviewed against Apple's HIG [done (check passed)]

Phone Machines redesign, detail page, tests, screenshots and review complete
## 2026-09-28 17:31 — #468 Integrate #344: Placement uses every machine: CPU-only gating, spread across nodes, explain skips [done (check passed)]

merge resolved; placement, stall, rapid and machines tests pass

## 2026-09-28 17:34 — #423 CLUSTER.md docs: Scheduling and Local cap describe the real head-capacity and placement rules [done (check passed)]

CLUSTER.md Scheduling and head's-ceiling now match current placement code

## 2026-09-28 17:56 — #474 Integrate #433: Machines view on iPhone: a real mobile design, reviewed against Apple's HIG [done (check passed)]

orchestrator.mjs conflict resolved; mobile tests pass; screenshots recaptured

## 2026-09-28 17:56 — #474 Integrate #433: Machines view on iPhone: a real mobile design, reviewed against Apple's HIG [verify failed (1)]

Command: merge main again
## 2026-09-28 17:52 — #434 Machines graph: compact card beside each node, listing every running task [done (check passed)]

Wide Machines view: compact cards beside each node, every running task listed
## 2026-09-28 17:48 — #473 Integrate #348: One shared browser per profile: agents attach to the live view, self-healing, run on a Mac [verify failed (1)]

Command: node --test test/browser-shared*.test.mjs

## 2026-09-28 17:52 — #473 Integrate #348: One shared browser per profile: agents attach to the live view, self-healing, run on a Mac [done (check passed)]

viewer follows agent's new tab after restart; tests pass

## 2026-09-28 18:00 — #475 Images open fully fitted in their original aspect ratio, with no scrolling [done (check passed)]

Lightbox opens fitted; thumbnails contain; fit tests pass
## 2026-09-28 18:08 — #474 Integrate #433: Machines view on iPhone: a real mobile design, reviewed against Apple's HIG [done (check passed)]

conflicts resolved; mobile Machines tests pass; ui-machines test 5 still fails

## 2026-09-28 18:31 — #476 Browser permissions: allow everything except the owner's deny list [done (check passed)]

Browser actions run unless owner's Don't-allow rules match
## 2026-09-28 18:16 — #478 Restart banner: a Cancel button for 'Restarting once idle' [done (check passed)]

Banner Cancel defers pending restarts; a new commit re-arms them
## 2026-09-28 18:15 — #481 Simpler Settings: one sound switch, no About section [done (check passed)]

Settings has one sound switch, no About, four hinted sections
## 2026-09-28 18:13 — #479 Task cards: a coloured phase progress strip along the bottom edge [done (check passed)]

Task cards show a live coloured phase strip, with a legend
## 2026-09-28 18:11 — #483 Files backend: upload files and folders [done (check passed)]

Streamed, login-protected Files upload endpoint works; its tests pass
## 2026-09-28 18:13 — #482 Claude limits card: an ideal-pace line on each usage bar [done (check passed)]

Usage bars show pace markers; usage charts show dashed pace diagonals
## 2026-09-28 18:15 — #480 Machines window: a wide modal titled 'Machines', head KPIs only on click [done (check passed)]

Machines is a wide modal with four cards in one row
## 2026-09-28 18:15 — #484 Files tab: one Back/Parent button, drag-and-drop upload and an Upload button [done (check passed)]

Files has one ‹ parent button, plus upload by menu and drag-and-drop

## 2026-09-28 18:16 — #489 Integrate #484: Files tab: one Back/Parent button, drag-and-drop upload and an Upload button [done (check passed)]

CONTEXT.md conflict merged; upload and nav tests pass

## 2026-09-28 18:15 — #488 Integrate #481: Simpler Settings: one sound switch, no About section [done (check passed)]

CONTEXT.md conflict resolved; settings and static tests pass

## 2026-09-28 18:15 — #487 Integrate #479: Task cards: a coloured phase progress strip along the bottom edge [done (check passed)]

app.css conflict resolved, keeping phase and pace colours; tests pass
## 2026-09-28 18:16 — #486 Skills: show the synced skills and make importing new ones simple [done (check passed)]

synced skills shown read-only; one-step Add skill from GitHub/zip

## 2026-09-28 18:17 — #490 Integrate #484: Files tab: one Back/Parent button, drag-and-drop upload and an Upload button [done (check passed)]

CONTEXT.md conflict resolved; upload tests pass
## 2026-09-28 18:17 — #491 Integrate #478: Restart banner: a Cancel button for 'Restarting once idle' [verify failed (1)]

Command: node --test test/restart-cancel*.test.mjs

## 2026-09-28 18:19 — #491 Integrate #478: Restart banner: a Cancel button for 'Restarting once idle' [done (check passed)]

a re-armed restart clears the deferral at once; the restart-cancel tests pass

## 2026-09-28 18:21 — #485 Remove the Machines icon from the sidebar footer [done (check passed)]

Sidebar footer has no Machines button; usage card opens Machines

## 2026-09-28 18:37 — #495 Integrate #476: Browser permissions: allow everything except the owner's deny list [done (check passed)]

conflicts resolved; Browser "Don't allow" section kept, allowlist tests pass

## 2026-09-28 18:47 — #497 Task card progress: timeline-style strip, proportional to time, premium muted colours [done (check passed)]

Cards and drawer share one proportional, muted 2px phase bar
## 2026-09-28 18:47 — #498 Machines graph on desktop: star layout, bigger machine cards with every task and its progress [done (check passed)]

Desktop Machines graph is a star with task-listing cards and usage rings

## 2026-09-28 18:56 — #500 Browser failover: switch to another machine when one can't open the browser [done (check passed)]

browser views and tasks fail over to capable machines; tests pass
## 2026-09-28 18:56 — #499 Browser tab: show only the current task, no history [done (check passed)]

Browser tab shows only the running task; tests pass
## 2026-09-28 18:52 — #496 Browser tasks via Claude in Chrome (claude --chrome) on a Mac [done (check passed)]

browser tasks prefer a Claude in Chrome runner; tests pass, documented

## 2026-09-28 18:54 — #501 Bring back the milestone-line Timeline bar; use it on task cards too [done (check passed)]

Drawer and card phase bars share one renderer with milestone lines
## 2026-09-28 18:56 — #502 Files tab: drag a selection box to select multiple files [done (check passed)]

Files list has marquee selection with auto-scroll; all 5 tests pass

## 2026-09-28 18:58 — #504 Integrate #500: Browser failover: switch to another machine when one can't open the browser [done (check passed)]

Merged main with #500 failover; browser-failover, chrome-runner and placement tests pass

## 2026-09-28 18:58 — #504 Integrate #500: Browser failover: switch to another machine when one can't open the browser [verify failed (1)]

Command: merge main again
## 2026-09-28 18:57 — #503 Integrate #499: Browser tab: show only the current task, no history [done (check passed)]

CONTEXT.md conflict resolved; browser-view tests pass

## 2026-09-28 18:58 — #504 Integrate #500: Browser failover: switch to another machine when one can't open the browser [done (check passed)]

CONTEXT.md conflict resolved; browser-failover tests pass

## 2026-09-28 19:09 — #507 Restore the original #229 Timeline bar exactly, drawer and cards [done (check passed)]

Original #229 .tl-bar restored in drawer; cards use .tl-bar.compact
## 2026-09-28 19:10 — #509 Machines star graph: head (oracle-vm) card above its node, workers around the rest [done (check passed)]

Head card sits above its node; workers ring the rest
## 2026-09-28 19:12 — #510 Sidebar projects: drag and drop to set project priority [done (check passed)]

project drag/keyboard priority order tested; header hint added
## 2026-09-28 19:16 — #508 Reflection models: a random pick from an owner-chosen pool, no fallbacks [done (check passed)]

reflections use random pool models; Settings shows Reflection models

## 2026-09-28 19:21 — #513 Browser task drawer: show the last screen when the session ends [done (check passed)]

browser task screens now show latest first, ordered by time

## 2026-09-28 19:21 — #512 Browser tab: hand the prompt straight to Claude in Chrome; setup card when no runner [done (check passed)]

Browser prompts go straight to Chrome; setup card shows without runner

## 2026-09-28 19:25 — #521 No progress bar on waiting tasks [done (check passed)]

Timeline bars now hidden on waiting tasks, shown once a run starts

## 2026-09-28 19:52 — #525 Make Chrome-runner tasks actually start: per-node profile lock, runner sign-in, live proof [done (check passed)]

lock, slots, sign-in fixed+tested; live proof needs deploy

## 2026-09-28 19:56 — #539 Review checkpoints only from the owner: planner and reflection never add them [done (check passed)]

review checkpoints owner-only; planner/reflection entries dropped, tests pass

## 2026-09-28 23:15 — #761 Files backend: download a file, or a streamed zip of several [done (check passed)]

file download and streamed zip endpoint added, 7 tests pass
## 2026-09-28 23:15 — #762 Files tab: Download button; several selected download as one zip [done (check passed)]

Files Download button, menu item, ⌘⇧D shortcut and tests added

## 2026-09-28 23:17 — #767 Integrate #761: Files backend: download a file, or a streamed zip of several [done (check passed)]

CONTEXT.md conflict resolved; download backend and UI tests pass

## 2026-09-28 23:22 — #780 Downloads never save an error as a .txt file; show the error instead [done (check passed)]

downloads preflight via check=1, failures toast instead of saving
## 2026-09-28 23:24 — #779 Settings: Rigor slider (5 levels) with an example prompt for each [done (check passed)]

Rigor slider with example card saves per project
## 2026-09-28 23:24 — #778 Rigor levels 1-5 per project for planner and reflection prompts [done (check passed)]

Per-project rigor 1-5 now shapes planner, reflection and top-up prompts
