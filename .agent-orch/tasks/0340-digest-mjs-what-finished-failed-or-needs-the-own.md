# Task #340: digest.mjs: what finished, failed or needs the owner since they last looked, per project, with tests

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:52  
- files: digest.mjs, test/digest.test.mjs

## Prompt

New feature backend (BRIEF goal 3 and 6: the phone app opened after hours away should say what happened). Create digest.mjs, a pure read-only module like stats.mjs (own `new DatabaseSync(dbFile, { readOnly: true })`, opened per call and closed; missing DB or tables → an empty digest, never a throw). Export `digest({ dbFile, since, now = Date.now(), limit = 50 })` returning `{ since, at, projects: [{ id, name, done: [...], failed: [...], needsYou: [...] }], counts: { done, failed, needsYou } }` where: done = tasks with status 'done' and finished_at > since (id, title, kind, finished_at, commit_sha, result trimmed to one line ≤ 200 chars, agent/model that ran it: ran_agent/ran_model else agent/model); failed = status in ('failed','needs_integration') with finished_at > since (same shape plus status); needsYou = tasks whose status is 'awaiting_review' or 'paused', or with a pending row in the approvals table (JOIN approvals WHERE status='pending'), regardless of time (shape: id, title, why: 'review'|'paused'|'approval', plus approval id/action when why='approval'). Order newest first, cap each list at `limit`, skip projects with nothing to report, and use only epoch ms numbers (never format times: app.js does that). Read orchestrator.mjs's CREATE TABLE statements (around line 825) and approvals.mjs for the exact columns; tasks.result may be JSON or plain text (take a `summary`/`message` field when JSON parses, else the first line). Tests in a new test/digest.test.mjs: build a temp DB with the same schema (copy the CREATE TABLE text from orchestrator.mjs or create via `createOrchestrator({config})` as scheduler tests do, see CONTEXT.md conventions), insert two projects and tasks covering every bucket plus one older-than-since done task and one project with nothing, and assert the shape, ordering, caps, the one-line result trimming, and that a missing dbFile yields empty lists with counts 0. Do not wire server.mjs or app.js (held by other tasks): add a one-line pointer in the module header saying the route and Queue group come later. Run only `node --test test/digest.test.mjs` while you work.

## Done when

`node --test test/digest.test.mjs` and `grep -q 'export function digest\|export async function digest' digest.mjs`

## Result — done (check passed) (2026-09-28 12:29)

AGENT-ORCH-STATUS: done — digest.mjs reports per-project done/failed/needs-you, tests pass
