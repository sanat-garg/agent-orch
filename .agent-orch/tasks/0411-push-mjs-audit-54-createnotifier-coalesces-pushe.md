# Task #411: push.mjs AUDIT #54: createNotifier coalesces pushes per tag, keeps the newest dropped one, and caps bursts with one summary

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 14:00  
- files: push.mjs, test/push.test.mjs

## Prompt

AUDIT #54 (.agent-orch/AUDIT.md, read it): server.mjs `notify` (lines ~731-740, do NOT edit server.mjs: it is held; the wiring is a later task) sends at most one push per tag per 60 s and silently drops the rest, spends the minute even when the send failed, and has no global cap, so a different message that shares a tag (`waiting` for the memory warning right after 'not signed in') is lost for good, and 15 tasks failing in a row buzz the phone 15 times. Add to push.mjs an export `createNotifier(send, {tagMs = 60_000, budget = 5, budgetMs = 600_000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log} = {})` returning `{notify(n), pending(), close()}`: notify(n) sends at once when the tag (n.tag || '') has not been sent within tagMs and the budget allows; otherwise it keeps the NEWEST message for that tag and arms one timer to send it when the tag's minute ends (an older kept message is replaced, never queued behind); a send whose result has sent === 0 and failed > 0 (or that throws) does not mark the tag as sent, so the next notify for it goes out at once; a global budget of `budget` sends per rolling budgetMs window: past it, messages are counted and one summary push `{title: 'agent-orch', body: '<N> more need you', tag: 'summary', url: '/'}` goes out when the window frees (and pending per-tag messages then flush in order, still one per tag); pending() returns the kept messages for tests; close() clears timers. send is awaited but notify itself returns the promise of the immediate send or undefined. Keep push.mjs dependency-free. Tests in test/push.test.mjs (existing file, add a describe block) with a fake send and fake timers: the second message on a tag within the minute is kept and sent at the minute mark with the newest body; a failed first send does not block the second; 8 different tags in a burst send 5 and one summary '3 more need you' after the window; an old kept message is replaced by a newer one on the same tag. Run only that test file.

## Done when

`npm test -- test/push.test.mjs` passes and `grep -c 'export function createNotifier' push.mjs` prints 1
