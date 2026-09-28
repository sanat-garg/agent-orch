# Task #318: AUDIT #42 outside cluster.mjs: sampleOf clips cpu to 256 cores, metrics read is bounded, pending approvals per run are capped

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:34  
- files: node-metrics.mjs, approvals.mjs, test/node-metrics.test.mjs, test/approval-gate.test.mjs, .agent-orch/AUDIT.md

## Prompt

AUDIT.md finding #42 lists several ways a worker can bloat the controller; the frame budget lives in cluster.mjs, which another task holds, so do only the halves in these files. (1) node-metrics.mjs `sampleOf` (line ~17): keep at most 256 entries of `res.cpu` (a real machine never has more; a frame with 100k entries must not be stored), and coerce each to a number in 0..100. `read(id)` loads the whole jsonl synchronously: if the file is over 8 MB, read only the last 8 MB (open, fstat, read from `size - 8 MB`, drop the partial first line) and log once. (2) approvals.mjs `request()`: if the run already has 20 rows with status 'pending' (`SELECT COUNT(*) ... WHERE run_id=:r AND status='pending'`), insert the new one as `denied` with `decided_by='cap'`, note 'Too many held actions in one run: answer or stop the task', send the deny and `onChange(row, 'decided')` so the UI updates; document the cap in the header comment. Tests: a new test/node-metrics.test.mjs (createMetrics in a temp dir: a frame with 1000 cpu entries stores 256; a file padded past 8 MB still reads its newest samples) and a case in test/approval-gate.test.mjs (copy its createApprovals setup: the 21st pending request for one run comes back denied with by 'cap'). Update AUDIT.md #42 with a note listing what is fixed here and what still waits for cluster.mjs (frame budget, sha from hello, cached gzipped bundle); do not mark it Fixed.

## Done when

`node --test test/node-metrics.test.mjs test/approval-gate.test.mjs` passes and `grep -n "decided_by='cap'\|'cap'" approvals.mjs` prints a line

## Result — done (check passed) (2026-09-28 11:45)

AGENT-ORCH-STATUS: done — Metrics cpu clipped, reads bounded to 8 MB, approvals capped per run
