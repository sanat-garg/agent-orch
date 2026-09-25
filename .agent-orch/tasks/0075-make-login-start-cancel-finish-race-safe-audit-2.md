# Task #75: Make login start/cancel/finish race-safe (AUDIT #22)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 09:09  
- starts after: #74

## Prompt

Fix AUDIT.md item #22 in /home/ubuntu/agent-orch/connections.mjs (start/cancel/finish, around lines 150-195). Read the full finding in .agent-orch/AUDIT.md first. Put a placeholder login entry {state:'waiting',...} into `logins` synchronously, before the first await in start(), so a second start() for the same id sees it and returns the existing login instead of killing the session. finish(id, state, err, l) should act only when logins.get(id) === l. The poll interval, the deadline timer and the probe callbacks must pass their own `l`, so an orphaned timer can never finish a newer login. If cancel() arrives while start() is still in flight, it must mark the placeholder cancelled, and start() must then kill the tmux session it just created and not go on to waiting. Add tests in test/connections.test.mjs using a fake tmux and a short timeoutMs: (a) two start() calls at once make only one session and one poller; (b) start, cancel, start again: the second login is not failed by the first login's deadline; (c) a cancel during start leaves the state not 'waiting'. Mark #22 Fixed in AUDIT.md.

## Done when

`npm test` passes, including the three new race tests in test/connections.test.mjs, and AUDIT.md marks #22 Fixed.
