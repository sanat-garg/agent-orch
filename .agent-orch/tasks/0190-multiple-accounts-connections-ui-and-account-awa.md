# Task #190: Multiple accounts: Connections UI and account-aware fallbacks and limits

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 12:52  
- starts after: #189  
- files: public/app.js, public/app.css, public/index.html, orchestrator.mjs, delegate.mjs, test/ui-*.test.mjs

## Prompt

UI for multiple accounts per CLI (backend: accounts.mjs, /api/accounts, model refs 'agent@account:model'). 1) Connections modal: each agent row expands to its accounts (label, signed-in email/login, status, limits summary), with '+ Add account' (asks for a label, then runs the sign-in flow in the modal), rename and remove (with confirmation). An agent with one account looks as it does today. 2) Model picker and fallback editor: when an agent has several accounts, a model entry shows its account label ('GPT-6 Sol · work'), and the add-model picker offers 'any account' or a specific one. 3) The Usage window and the sidebar usage card show limits per account. 4) Delegation and parallel spreading treat each account as separate capacity (a second Claude account is used when the first is limited and it's allowed by the fallback list; 'any account' entries rotate to accounts with usage left). Screenshots via bin/shot.mjs on desktop and 390px.

## Done when

`node --check public/app.js && npm test` passes, and the Connections modal renders an '+ Add account' action per agent
