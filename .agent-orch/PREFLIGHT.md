Verdict: OK

# Preflight: HEAD on a copy of the live data dir

- Date: 2026-09-25 (~09:34–09:40 UTC)
- HEAD: d1614f9588c7c87567b087fe04af4e470fdf3354 (task #80, `CW_NO_ORCHESTRATOR=1`)
- Live service: untouched (port 3000, pid 463209 still listening; `data/` only read and copied).

## 1. Copy
- T=`/tmp/preflight-bu8y`. Copied `data/` except `orchestrator/agent-orch.db*` and `orchestrator/lock`. The run logs (3 MB) were copied too.
- DB: live DB is `journal_mode=wal`. Took the snapshot with node:sqlite `readOnly` and `VACUUM INTO '<T>/orchestrator/agent-orch.db'`, which gave a 250 KB consistent DB.
- `T/auth.json` was replaced with a scrypt salt+hash of a known password, the same way test/server.test.mjs builds it. `T/sessions.json` was reset to `{}`.

## 2. Boot
`CW_NO_ORCHESTRATOR=1 CW_DATA_DIR=$T PORT=3999 node server.mjs`. Full stdout/stderr:
```
[orchestrator] disabled (CW_NO_ORCHESTRATOR=1): not requeueing or scheduling tasks
(node) ExperimentalWarning: SQLite is an experimental feature and might change at any time
agent-orch on 127.0.0.1:3999
[github] linked as sanat-garg
```
No migration errors and no stack traces, then or while all the steps below ran.

## 3. APIs (cookie from POST /api/login → 200)
| Request | Status | Notes |
|---|---|---|
| GET /api/status | 200 | claudeSignedIn true (pro), restartPending false |
| GET /api/convos | 200 | 1 convo (`agent-orch`, orchestrator mode). `repo` was refreshed from `gh` to `sanat-garg/agent-orch`; the live file still says `claude-web`, which is only a stale cache |
| WS `/ws` `{t:'open'}` on the real convo | ok | `history`: 195 events, busy false, orch snapshot with 72 tasks |
| GET /api/projects | 200 | folder picker: `{"root":"/home/ubuntu/workspace","projects":[]}` |
| GET /api/agents | 200 | claude available+logged in. codex available but not logged in |
| GET /api/connections | 200 | claude signed in. codex/antigravity not signed in. github linked |
| GET /api/github, /api/terminals | 200 | |
| GET /api/away?since=0 | 200 | 16.6 KB of finished tasks |
| GET /api/metrics, /api/metrics/history?range=1h | 200 | |
| GET /api/orch/task/{1,80,81} | 200 | detail + logs render. #81 (this task) shows `running` |
| GET /, /app.js | 200 | |
| GET /api/convos/:id, GET /api/orch/project/:id | 404 | expected: those routes only accept PATCH/DELETE or POST |

## 4. UI (headless Chromium, playwright 1.63 installed in /tmp/pf_pw, outside the repo)
- Login form → `/`. The sidebar lists the convo. Opening it rendered 129 message nodes, the orchestrator bar ("Working on 1 task", "69 done") and 70 task cards. Status said "Connected".
- Opening the task drawer (#81) showed the instructions and the live "What happened" stream.
- Console errors / warnings / page errors / failed requests / HTTP ≥400: **none**.
- Screenshots: `/tmp/preflight-bu8y/preflight-chat.png`, `/tmp/preflight-bu8y/preflight-task.png`, `/tmp/preflight-bu8y/preflight-mobile.png`.

## 5. DB before vs after boot (copy)
- Schema changes are additive only: new table `routes`, `runs.agent`, and `tasks.agent/model/ran_agent/ran_model/route_note`. No tables or indexes were removed or changed in any other way.
- Row counts: projects 2→2, tasks 81→81, runs 99→99. Task status changes: none (79 done, 1 failed, 1 running). Project status: 1 paused, 2 active (unchanged).

## 6. Cleanup
Killed only my own pid (567248, `node server.mjs` on 3999). Port 3000 still served by pid 463209.

## Expected on the real restart
Without `CW_NO_ORCHESTRATOR`, boot requeues any task still `running` as an orphan. Restart when no task runs (or use "Restart when idle").
