# Task #377: approvals.mjs: the expiry note states the row's real TTL and overdue rows expire at boot

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:54  
- files: approvals.mjs, test/approval-gate.test.mjs

## Prompt

Reliability in approvals.mjs (the head's side of the approval gate; do not edit gate.mjs, orchestrator.mjs or server.mjs). Two small honesty bugs: (1) expire() writes the note `No answer within ${Math.round(ttlMs() / 3600_000)} h` from the CURRENT settings TTL, but a row's own window was `Math.min(ttlMs(), a.ttlMs)` at creation and the owner may have changed the setting since, so a request that expired after 1 h is recorded as 'No answer within 24 h'. Compute it from the row: `expires_at - created_at`, formatted as minutes under 1 h (`No answer within 45 min`) else hours with one decimal when not whole. (2) at boot (`boot: true`) armExpiry() schedules the next expiry but rows whose expires_at already passed while the process was down are only expired when that timer fires (it does fire immediately via setTimeout 0, but any decision in between sees status 'pending'); call expire() synchronously at boot after cancelling controller rows, then armExpiry(). Also make `resend` use each row's own window rather than `2 * ttlMs()` is NOT required; leave it. Update the header comment where it says 'the 24 h expiry'. Tests in test/approval-gate.test.mjs (or its neighbour that constructs createApprovals with a temp DB, copy the setup): a request with ttlMs 3_600_000 that expires yields note 'No answer within 1 h'; one with 2_700_000 → '45 min'; a DB re-opened with boot true and a remote pending row past expiry is 'expired' immediately after createApprovals returns. Run only `npm test -- test/approval-gate.test.mjs`.

## Done when

`npm test -- test/approval-gate.test.mjs` passes and ! grep -q 'ttlMs() / 3600_000' approvals.mjs

## Result — done (check passed) (2026-09-28 13:04)

AGENT-ORCH-STATUS: done — expiry notes show each row's own window; overdue rows expire at boot
