# Task #81: Preflight HEAD against a copy of the live data dir and write .agent-orch/PREFLIGHT.md

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-25 09:29  
- starts after: #80

## Prompt

Goal: before the owner restarts the live agent-orch service (it has run since 03:23 UTC 2026-09-25, and ~45 commits including DB migrations are not live yet), prove that HEAD boots cleanly on the real data. Never touch port 3000, the live process, or the files in /home/ubuntu/agent-orch/data/. Only read and copy them.

Steps:
1. Make a temp dir T=$(mktemp -d). Copy data/ into it, but take the SQLite DB (data/orchestrator/agent-orch.db, which runs in WAL mode) as a consistent snapshot: use node:sqlite and `VACUUM INTO '<T>/orchestrator/agent-orch.db'` from a read connection, not a plain cp of the -wal file. Skip the run logs if they are large. Replace T/auth.json with a known password, the same way test/server.test.mjs builds auth.json (scrypt salt+hash).
2. Boot with `CW_NO_ORCHESTRATOR=1 CW_DATA_DIR=$T PORT=3999 node server.mjs` in the background and capture stdout/stderr. Record any migration errors or stack traces.
3. Log in via POST to the login endpoint (see server.mjs) and keep the cookie. Hit the main read APIs the UI uses (conversations list, one real conversation's history, tasks/projects, /api/agents, /api/connections, status). Record status codes and anything odd.
4. Render the UI in headless Chromium. Playwright browsers are in ~/.cache/ms-playwright; install the playwright npm package into a temp dir outside the repo, and never add it to package.json. Log in, open the largest real conversation and the orchestrator/tasks view, and collect console errors and page errors. Save a screenshot to $T and mention its path.
5. Compare the DB schema before and after (sqlite_master) and check that row counts of tasks/projects did not change and no task changed status.
6. Kill only your own 3999 process.

Write .agent-orch/PREFLIGHT.md: date, HEAD sha, a first line that is exactly `Verdict: OK` or `Verdict: NOT OK`, then the evidence per step. If you find a real bug that would break the live app on restart, do not fix it here. Add it to .agent-orch/AUDIT.md as a new numbered item (Round 4) and mark the verdict NOT OK. Commit only the .agent-orch/ files, never data/.

## Done when

`grep -E '^Verdict: (OK|NOT OK)' .agent-orch/PREFLIGHT.md` succeeds

## Result — done (check passed) (2026-09-25 09:35)

AGENT-ORCH-STATUS: done — HEAD boots cleanly on copied live data; PREFLIGHT verdict OK
