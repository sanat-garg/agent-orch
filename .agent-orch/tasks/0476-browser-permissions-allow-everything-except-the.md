# Task #476: Browser permissions: allow everything except the owner's deny list

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 18:10  
- files: gate.mjs, approvals.mjs, gate-proxy.mjs, server.mjs, public/app.js, public/index.html, test/browser-allowlist*.test.mjs

## Prompt

Change the browser/connector approval model (gate.mjs classification, approvals.mjs, gate-proxy.mjs, the Settings UI in public/app.js/index.html) from 'outbound actions need approval' to ALLOW EVERYTHING by default, except what the owner disallows. 1) Settings → Browser gets a 'Don't allow' text box (multiline, one rule per line) with examples as placeholder: 'payments and checkout', 'send email', 'delete', 'bank.example.com', 'post on social media'. Rules match domains/URL patterns, button or element names, and action kinds (send, pay, delete, publish, share, submit, upload, download, and login/credentials). Store them server-side. Parse each line into a matcher (domain → URL host match; known action words → the classifier's action kinds; anything else → a case-insensitive phrase match on the element's accessible name, page title or URL). 2) Behaviour: any action matching a rule is held for approval exactly as today (approval card, screenshot, Approve/Deny); everything else runs without asking. Keep the audit log for every action. Remove the old built-in outbound pattern list as a default gate (it stays only as suggestions shown under the text box). 3) Show the active rules in the browser view's activity panel ('Asks before: payments, send email'). 4) Tests: with no rules, a 'Send' click runs without approval and is audited; with 'send email' a Gmail send is held; a domain rule holds navigation to that domain; a phrase rule matches a button name. Run only the touched test files.

## Done when

`node --test test/browser-allowlist*.test.mjs` passes (no rules → no approval, send-email rule holds, domain and phrase rules match), and Settings has a Browser 'Don't allow' box
