# Task #287: AUDIT round 6: cluster protocol and pairing, approvals and audit log, browser live view, extension sync, restart and machines APIs

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 08:13  
- files: .agent-orch/AUDIT.md

## Prompt

Security and correctness audit, findings only (no code changes). .agent-orch/AUDIT.md has rounds 1–5; round 5 (task #177, 2026-09-26) covered HTTP/WS endpoint security. Everything below was added or reworked after it and has never been audited. Read each module's header comment first, then review: (1) cluster-protocol.mjs and cluster.mjs: worker pairing tokens (nodes.token_hash, the pairings table), WSS authentication and message validation, what an unauthenticated or malicious worker could do (claim jobs, post results for another task, push branches, exhaust the DB), self-update and drain/undrain logic; worker.mjs must stay compute-only. (2) approvals.mjs and gate.mjs: the approval gate for outbound MCP calls, the audit log under <DATA>/audit/, path handling of the file-based proxy ↔ host channel, race or bypass possibilities. (3) The browser live view (browser.mjs, public/browser.js, the /ws frame stream and input events): who may drive a task's browser, URL restrictions, take-over semantics. (4) extensions.mjs: extension sync to workers (path traversal in bundle paths, what a worker can write). (5) server.mjs endpoints added since round 5: POST /api/restart-when-idle, the machines/nodes APIs, run_on pinning, the autoRestart setting. For each finding add a numbered row continuing AUDIT.md's numbering (the last is #37) in the same format as earlier rounds: severity, file:line, what is wrong, a concrete exploit or failure, and a one-line suggested fix. Also record what you checked and found sound, briefly, so the next round knows the coverage. Append it as a new section `## Round 6 (2026-09-28, task #<your id>): cluster, approvals, live view, extensions, restart/machines`. Do not fix anything in this task; fixes are queued from your findings by the next reflection. Do not touch the live server on port 3000; if you need a running instance use `PORT=3999 CW_DATA_DIR=$(mktemp -d) node server.mjs` and kill only your own process.

## Done when

`grep -q '^## Round 6' .agent-orch/AUDIT.md`

## Result — done (check passed) (2026-09-28 08:24)

AGENT-ORCH-STATUS: done — AUDIT.md Round 6 added: 16 findings (#37–#52), two high
