# Task #11: Write README.md with setup and security notes

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-24 23:31

## Prompt

Create README.md at the repo root for github.com/sanat-garg/agent-orch. Read server.mjs, orchestrator.mjs, github.mjs and bin/term-attach.sh to cover: what Claude Web + AO2 are; requirements (node 22+, Claude Code CLI at ~/.local/bin/claude signed in with a subscription, gh CLI, ttyd, Caddy proxying /term/); every env var the code reads (grep process.env); how to run it (and as a systemd service); what data/ holds and why it's gitignored; and security notes (subscription-only auth via API_ENV stripping, agents run with bypassPermissions). Keep it concise and factual. Don't invent features.

## Done when

README.md exists and lists every env var found by `grep -ho 'process.env.[A-Z_]*' *.mjs | sort -u`
