# Task #74: Send pasted sign-in codes with -- and fail if the send fails (AUDIT #25)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 09:09

## Prompt

Fix AUDIT.md item #25 in /home/ubuntu/agent-orch/connections.mjs (submitCode, around lines 183-185). Right now tmux send-keys is called as ['send-keys','-t',target,'-l',code] with no '--', so a code that starts with '-' is read as tmux flags. The send then fails, Enter is still sent, and the API returns 200. Change it to ['send-keys','-t',target,'-l','--',code]. Check the tmux result: if it fails, don't send Enter, and return an error the route turns into a 500 (look at how the /api/connections routes in server.mjs handle errors). Add a test in test/connections.test.mjs, using the existing fake-tmux or fixture approach, that shows a code like '-abc_def' is passed after '--' and that a failed send doesn't send Enter. Mark #25 Fixed in .agent-orch/AUDIT.md.

## Done when

`npm test` passes, including a new connections test for a leading-dash code, and AUDIT.md marks #25 Fixed.

## Result — done (check passed) (2026-09-25 09:12)

AGENT-ORCH-STATUS: done — Codes are sent after `--`; failed sends return 500 without Enter; tests pass
