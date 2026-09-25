# Audit: server, orchestrator, GitHub wrapper, UI

**Status (2026-09-25, task #71):** items 1-21 fixed (rounds 1-2); round 3 (#22-26) open.

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

### 25. [low] A pasted Claude code that starts with `-` is read as tmux flags, and the UI says it was sent (connections.mjs:183-185)
- **What:** `send-keys -t … -l <code>` doesn't put `--` before the code, so tmux's getopt parses a leading `-` as
  options. Claude's OAuth codes are base64url, so about 1 in 64 start with `-`. The send fails, `submitCode` ignores
  the tmux result and still sends a bare `Enter` to the CLI, and it returns 200, so the panel says "Code sent,
  checking…" until the 10-minute timeout.
- **Repro (verified, tmux 3.6):** `tmux send-keys -t =t: -l '-abc_def'` → `command send-keys: unknown flag -a`, exit 1.
- **Fix:** Send `['send-keys', '-t', target, '-l', '--', code]`. If the send fails, return 500 (the session is gone)
  and don't send Enter.

### 26. [low] Old limit notices read "at your usage limit until now" when the chat history is reloaded (public/app.js:1773-1775)
- **What:** `withUntil` formats `{until}` when the event is rendered. Persisted notices are replayed on every chat
  open, and `fmtResetAt` returns `'now'` for a past time. So yesterday's notice reads "…until now; the orchestrator
  answers then.", "Retrying around now." or "it resets now.", which looks like a current limit.
- **Fix:** When `until` is in the past, render the absolute time (e.g. "until Thu 3:10 PM") without the relative
  part, or add "(passed)".
