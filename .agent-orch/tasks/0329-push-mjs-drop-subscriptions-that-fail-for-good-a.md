# Task #329: push.mjs: drop subscriptions that fail for good and honour Retry-After

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 11:43  
- files: push.mjs, test/push.test.mjs

## Prompt

push.mjs createPush(...).send posts to every device; a 404/410 removes the device, anything else counts as failed and is retried on every later send forever. Two reliability gaps: (1) permanent rejections (400, 401, 403, 413: bad subscription, VAPID mismatch, payload too large) keep costing a 15 s network round trip per notification for that device forever; (2) 429 and 503 answers carry Retry-After (seconds or an HTTP date) and we ignore it, hammering the push service. Implement in push.mjs: per subscription keep `fails` (consecutive permanent 4xx count) and `pausedUntil` (epoch ms) in the stored record; a 2xx resets fails; 400/401/403/413 increments it and after 3 consecutive such failures the subscription is removed (counted in `removed`, logged); 429/503 set pausedUntil from Retry-After (cap 1 h, default 60 s when the header is missing or unparsable) and count as failed once; a send skips paused devices (count them in a new `skipped` field) without a network call. `post` must therefore resolve the status code AND the Retry-After header. Keep `send` never throwing and keep the existing result fields; `subscribe` resets fails/pausedUntil for a re-subscribed endpoint. Update the header comment. Extend test/push.test.mjs using its existing local http server pattern: three 403s remove the device on the third send; a 429 with Retry-After: 2 makes the next send within 2 s skip it ({sent:0, removed:0, failed:0, skipped:1}) and a send after it goes through; a 2xx resets the fail count. Do not touch server.mjs.

## Done when

`npm test -- test/push.test.mjs test/push-events.test.mjs` passes and `grep -n 'pausedUntil' push.mjs` prints a line.
