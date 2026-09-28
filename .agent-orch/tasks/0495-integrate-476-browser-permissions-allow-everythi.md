# Task #495: Integrate #476: Browser permissions: allow everything except the owner's deny list

- kind: work  
- source: planner  
- priority: 95 (normal)  
- created: 2026-09-28 18:32  
- files: gate.mjs, approvals.mjs, gate-proxy.mjs, server.mjs, public/app.js, public/index.html, test/browser-allowlist*.test.mjs

## Prompt

Task #476 ("Browser permissions: allow everything except the owner's deny list") finished in its own git worktree, but its branch `agent-orch/task-476` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md, test/ui-static.test.mjs). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #476's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #476's instructions were:

Change the browser/connector approval model (gate.mjs classification, approvals.mjs, gate-proxy.mjs, the Settings UI in public/app.js/index.html) from 'outbound actions need approval' to ALLOW EVERYTHING by default, except what the owner disallows. 1) Settings → Browser gets a 'Don't allow' text box (multiline, one rule per line) with examples as placeholder: 'payments and checkout', 'send email', 'delete', 'bank.example.com', 'post on social media'. Rules match domains/URL patterns, button or element names, and action kinds (send, pay, delete, publish, share, submit, upload, download, and login/credentials). Store them server-side. Parse each line into a matcher (domain → URL host match; known action words → the classifier's action kinds; anything else → a case-insensitive phrase match on the element's accessible name, page title or URL). 2) Behaviour: any action matching a rule is held for approval exactly as today (approval card, screenshot, Approve/Deny); everything else runs without asking. Keep the audit log for every action. Remove the old built-in outbound pattern list as a default gate (it stays only as suggestions shown under the text box). 3) Show the active rules in the browser view's activity panel ('Asks before: payments, send email'). 4) Tests: with no rules, a 'Send' click runs without approval and is audited; with 'send email' a Gmail send is held; a domain rule holds navigation to that domain; a phrase rule matches a button name. Run only the touched test files.

## Done when

`node --test test/browser-allowlist*.test.mjs` passes (no rules → no approval, send-email rule holds, domain and phrase rules match), and Settings has a Browser 'Don't allow' box

## Result — done (check passed) (2026-09-28 18:37)

AGENT-ORCH-STATUS: done — conflicts resolved; Browser "Don't allow" section kept, allowlist tests pass
