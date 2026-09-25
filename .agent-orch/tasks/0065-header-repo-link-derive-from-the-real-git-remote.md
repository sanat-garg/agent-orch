# Task #65: Header repo link: derive from the real git remote, not cached convo.repo

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 08:21

## Prompt

Bug: the chat header's GitHub link (public/app.js ~lines 487-510, #repoLink) shows 'claude-web' and 404s, because data/convos.json keeps a stale convo.repo = {full:'sanat-garg/claude-web', url:...} from before the repo moved. The actual `origin` is github.com/sanat-garg/agent-orch. Fix it in server.mjs: whenever convos load at startup, and when a convo's project is (re)attached or setupRepo runs (~lines 592-625), refresh convo.repo from `gh.remoteOf(convo.cwd)` (github.mjs) and persist it if it changed. If the remote is gone, clear convo.repo so the UI falls back to 'Link GitHub'/'Creating repo…'. The /api endpoint at ~line 1178 that returns repos must use the refreshed values too. Don't edit data/ by hand. Add a test in test/ that starts the server with CW_DATA_DIR set to a temp dir, seeds a convos.json with a stale repo for a temp git dir whose origin points elsewhere, and asserts the API returns the origin-derived repo.

## Done when

`npm test` passes including a test showing that a stale convo.repo is replaced by the git origin's repo

## Result — done (check passed) (2026-09-25 08:23)

AGENT-ORCH-STATUS: done — Repo link now comes from git origin; tests pass
