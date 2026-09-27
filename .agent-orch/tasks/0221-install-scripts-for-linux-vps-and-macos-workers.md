# Task #221: Install scripts for Linux VPS and macOS workers, plus an 'Add machine' wizard

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-27 11:58  
- starts after: #219  
- files: bin/install-worker.sh, bin/install-worker-macos.sh, README.md, public/app.js, public/app.css, public/index.html, test/install-worker*.test.mjs

## Prompt

Make adding a machine a copy-paste job. 1) bin/install-worker.sh (Linux, systemd) and bin/install-worker-macos.sh (macOS, launchd): install Node 22 if missing (nvm, or the official tarball for arm64/x64), clone or update agent-orch from github.com/sanat-garg/agent-orch into ~/agent-orch-worker (use the gh login, and prompt `gh auth login` if missing), npm ci, optionally install the chosen agent CLIs (flags --agents claude,codex,…, using the same install commands as .agent-orch/AGENTS.md), run `node worker.mjs pair --controller <url> --code <code> --name <name>`, and install a service (a systemd unit agent-orch-worker.service with Restart=always, MemoryHigh set to leave headroom; a launchd plist ~/Library/LaunchAgents/com.agent-orch.worker.plist with KeepAlive and running only while logged in). The macOS script STRONGLY recommends and supports running under a dedicated standard user ('agentorch'): it can create it with sysadminctl when run with sudo, and explains why (autonomous agents shouldn't see your personal files). Idempotent; with --uninstall. 2) UI: Server details (or a new 'Machines' entry in the sidebar) gets 'Add machine', which calls POST /api/cluster/pair and shows a one-line command per OS with the code embedded (copyable, with the click-to-copy style), a live 'Waiting for the machine to connect…' that flips to 'Connected: <name>' when the node claims the code, then a prompt to sign agents in on that machine (the next task handles remote sign-in). 3) README section 'Adding machines'. Tests: `bash -n` on both scripts, --dry-run output checks, and the pairing wizard's API flow.

## Done when

`bash -n bin/install-worker.sh && bash -n bin/install-worker-macos.sh` passes, both support --dry-run (exit 0), `npm test` passes, and the UI 'Add machine' flow shows a command containing a fresh pairing code

## Result — done (check passed) (2026-09-27 13:55)

The full test suite is still running; I'll check the result when it finishes.
