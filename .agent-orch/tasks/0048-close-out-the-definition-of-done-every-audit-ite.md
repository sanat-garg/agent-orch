# Task #48: Close out the Definition of Done: every AUDIT item Fixed or Deferred, README verified

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 03:55  
- starts after: #47

## Prompt

Check the Definition of Done in .agent-orch/BRIEF.md. (1) Every `### N.` item in .agent-orch/AUDIT.md must have a `- **Fixed** (task #N)` or `- **Deferred**: reason` line. For any that lack one, check the code: if it's actually fixed, mark it Fixed with the task/commit reference from git log; otherwise mark it Deferred with a concrete reason. Don't fix code in this task. (2) Read README.md against the actual code and live setup (server.mjs env vars such as PORT, CW_DATA_DIR and CW_WS_KEEPALIVE_MS; systemd unit names agent-orch, agent-orch-shell and agent-orch-tmux; Caddy at /shell/; ttyd on 127.0.0.1:7682; the data/ file list) and fix any stale statements in README.md. (3) Add a short 'Status' line at the top of AUDIT.md summarizing how many items are fixed and how many deferred. Only edit README.md and .agent-orch/*.md.

## Done when

`test $(grep -c '^### ' .agent-orch/AUDIT.md) -eq $(grep -cE '^- \*\*(Fixed|Deferred)' .agent-orch/AUDIT.md) && npm test`
