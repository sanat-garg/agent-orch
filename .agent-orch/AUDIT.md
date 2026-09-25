# Audit: server, orchestrator, GitHub wrapper, UI

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

### 12. [low] Concurrent `ensureRepo` calls can create duplicate GitHub repos (github.mjs:55-67)
- **What:** `setupRepo` (server.mjs:1013, not awaited) calls `gh.ensureRepo` directly, outside `push`'s `inflight`
  dedupe. If the first chat reply finishes (`syncGit` → `push` → `ensureRepo`) or the 3-minute retry fires before
  setup completes, both calls see no `origin` and both run `gh repo create`. That leaves a stray `name-2` repo or
  an "origin already exists" error in `convo.git.error`.
- **Fix:** Keep a per-dir inflight map in `ensureRepo` itself, like `push`.

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
