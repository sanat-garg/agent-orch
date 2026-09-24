# Task #20: Rebrand all user-visible names to agent-orch

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-24 23:37  
- starts after: #19

## Prompt

The product is now named 'agent-orch' (see .ao2/BRIEF.md, goal 4). Replace user-visible 'Claude Web', 'claude-web' and 'AO2' with agent-orch branding in: public/index.html (title, .side-title), public/login.html (title; update the set-password hint path to ~/agent-orch/server.mjs), public/app.js (document.title and any other visible strings), public/manifest.webmanifest (name/short_name), server.mjs (header comment, the startup log line, and the 'Orchestrator Mode (AO2)' comment; in the systemctl status list at ~line 484 use 'agent-orch' instead of 'claude-web' and fix 'claude-term' to 'agent-orch-shell'), github.mjs GIT_ID (user.name=agent-orch, user.email=agent-orch@users.noreply.github.com), package.json (name/description) and README.md (all names and paths → agent-orch and ~/agent-orch; systemd unit names agent-orch.service / agent-orch-shell.service / agent-orch-tmux.service). Display casing: use 'agent-orch' (lowercase) consistently. Do NOT touch the `.ao2/` directory, the ao2-tasks fence, AO2-STATUS or ao2.db in this task; later tasks handle those. 'Claude Code' (the CLI) stays as it is.

## Done when

`grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md` prints nothing and `npm test` passes

## Result — verify failed (1) (2026-09-24 23:38)

Command: grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md

exit 1

## Result — verify failed (2) (2026-09-24 23:38)

Command: grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md

exit 1

## Result — in progress (3) (2026-09-24 23:39)

AO2-STATUS: continue — Check can't pass as written: bare grep exits 1 when clean (AUDIT #16)

## Result — verify failed (4) (2026-09-24 23:39)

Command: grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md

exit 1

## Result — failed (verification) (2026-09-24 23:39)

`grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md` still failing after 4 sessions:
exit 1

## Result — verify failed (1) (2026-09-24 23:45)

Command: grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md

exit 1

## Result — verify failed (2) (2026-09-24 23:45)

Command: grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md

exit 1

## Result — verify failed (3) (2026-09-24 23:45)

Command: grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md

exit 1

## Result — verify failed (4) (2026-09-24 23:45)

Command: grep -rniE 'claude[ -]web' public server.mjs github.mjs package.json README.md

exit 1
