# Task #198: Multiple accounts: Connections UI and account-aware fallbacks and limits

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 14:32  
- starts after: #197  
- files: public/app.js, public/app.css, public/index.html, orchestrator.mjs, delegate.mjs, test/ui-accounts*.test.mjs

## Prompt

UI for multiple accounts per CLI (backend: accounts.mjs, /api/accounts, model refs 'agent@account:model'). 1) Connections modal: each agent row expands to its accounts (label, signed-in email/login, status, limits summary), with '+ Add account' (asks for a label, then runs the sign-in flow in the modal), rename and remove (with confirmation). An agent with one account looks as it does today. 2) Model picker, fallback editors (composer, task drawer, reflection): when an agent has several accounts, entries show the account label ('GPT-6 Sol · work'), and the add picker offers 'any account' or a specific one. 3) The Usage window and the sidebar usage card show limits per account. 4) Delegation and parallel slot-filling (orchestrator.mjs/delegate.mjs) treat each account as separate capacity: 'any account' entries rotate to accounts with usage left. Screenshots via bin/shot.mjs on desktop and 390px.

## Done when

`node --check public/app.js && npm test` passes, and the Connections modal renders an '+ Add account' action per agent
