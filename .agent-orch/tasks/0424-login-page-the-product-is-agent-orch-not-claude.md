# Task #424: login page: the product is agent-orch, not Claude Code (goal 4)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 14:14  
- files: public/login.html

## Prompt

Goal: BRIEF.md goal 4 says no user-visible "Claude Web"/"Claude Code" branding should remain for the product itself (Claude Code stays only where the CLI is meant). public/login.html's subtitle still reads "Sign in to Claude Code on <host>". Change it to "Sign in to agent-orch on <host>" (keep the #host span and the script that fills it). While there, keep the page otherwise as it is; the only other allowed edits are the same wording fix if it appears in public/login.css or the page's <title>/aria text. Do not change the hidden username field's value (password managers match on it). Check the page in a browser or with `node --check`-style sanity (it's HTML: just make sure the script block is intact) and that test/security-headers.test.mjs still passes, since it fetches the login page.

## Done when

`grep -c "Sign in to agent-orch on" public/login.html` prints 1 and `! grep -q "Claude Code" public/login.html` and `npm test -- test/security-headers.test.mjs`
