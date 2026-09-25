# Task #99: Antigravity connection: show signed-in email and a Disconnect button

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 13:22  
- starts after: #98

## Prompt

In the Connections modal, Antigravity shows as connected without the account email and has no Disconnect button (Claude/Codex/GitHub rows presumably do). In connections.mjs, find how agy stores its login (see .agent-orch/AGENTS.md: credentials under ~/.gemini/antigravity-cli/; inspect the actual files on this machine WITHOUT printing tokens) and derive the account email: from an agy status/whoami command if one exists, else from the stored credential's id_token claims (decode the JWT payload locally, email claim only) or a userinfo field in the file. Implement logout for agy: use its logout command if it exists, otherwise remove only its credential file(s) after confirming the exact paths. Then the UI row shows 'Connected as <email>' and a Disconnect button with a confirm. Add tests with a fixture credential file (fake JWT) asserting email extraction and that logout deletes only the expected file.

## Done when

`npm test` passes with agy email-extraction and logout tests, and GET /api/connections on this machine returns an account email for antigravity
