# Task #23: Write one-shot script to move install to ~/agent-orch

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-24 23:37  
- starts after: #22

## Prompt

Write bin/rename-install.sh, a bash script the OWNER runs once (with sudo available) to move the live install from /home/ubuntu/claude-web to /home/ubuntu/agent-orch. DO NOT run it for real yourself, because it restarts the service you are running under. It must, in order: 1) stop claude-web.service; 2) mv /home/ubuntu/claude-web /home/ubuntu/agent-orch; 3) rename the systemd units claude-web → agent-orch, claude-shell → agent-orch-shell and claude-tmux → agent-orch-tmux (write the new unit files in /etc/systemd/system with paths updated, e.g. ttyd's ExecStart points at /home/ubuntu/agent-orch/bin/term-attach.sh; disable and remove the old units); 4) with node (node:sqlite, no sqlite3 CLI exists), update the orchestrator DB: projects.path and projects.name for the old path become /home/ubuntu/agent-orch and 'agent-orch', and any task/session cwd columns holding the old path prefix get updated too; 5) update data/convos.json entries whose cwd starts with the old path; 6) rename ~/.claude/projects/-home-ubuntu-claude-web to -home-ubuntu-agent-orch so chat sessions can still resume; 7) systemctl daemon-reload, then enable and start the new units, and print their status. It must be idempotent (safe to re-run) and support `--dry-run`, which prints every action without doing it. Check the Caddyfile for old paths (currently none). Document the script in README.md.

## Done when

`bash -n bin/rename-install.sh && bash bin/rename-install.sh --dry-run` exits 0 and prints the planned mv, systemd, DB and convos.json actions without changing anything

## Result — done (2026-09-24 23:51)

AO2-STATUS: done — bin/rename-install.sh ready; dry-run and sandbox re-runs pass
