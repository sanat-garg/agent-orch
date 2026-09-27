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
