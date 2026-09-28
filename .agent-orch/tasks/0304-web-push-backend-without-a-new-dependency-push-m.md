# Task #304: Web Push backend without a new dependency: push.mjs with VAPID keys, subscriptions, aes128gcm and send; /api/push routes

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-28 10:55  
- files: push.mjs, server.mjs, test/push.test.mjs, README.md

## Prompt

New feature (BRIEF goal 6, mobile-first PWA): notifications that reach the owner's iPhone while the app is closed. This step is the server side only, with no new npm dependency (BRIEF: minimal deps). Create push.mjs exporting `createPush({ dataDir, log })` that: (1) generates a VAPID P-256 key pair once with node:crypto (`generateKeyPairSync('ec', {namedCurve:'prime256v1'})`), stores it in `<dataDir>/push-vapid.json` and exposes `publicKey()` as the base64url uncompressed point the browser's `applicationServerKey` needs; (2) keeps subscriptions in `<dataDir>/push-subscriptions.json` (`{endpoint, keys:{p256dh, auth}, ua, addedAt}`), with `subscribe(sub)`, `unsubscribe(endpoint)`, `count()`; (3) `send({ title, body, tag, url, badge })` encrypts the JSON payload per RFC 8291 / RFC 8188 (aes128gcm: ECDH with the subscription's p256dh, HKDF with the auth secret, the record header with salt and the server public key, a single record with padding delimiter 0x02) and POSTs it with `Content-Encoding: aes128gcm`, `TTL: 86400`, `Urgency: high`, and an `Authorization: vapid t=<ES256 JWT with aud=endpoint origin, exp now+12h, sub mailto:owner@localhost>, k=<publicKey>` header using node:https/http; a 404 or 410 response removes that subscription; every send is logged; failures never throw. Keep it ~150 lines, terse like the neighbours (read helpers.mjs and gate.mjs for style). server.mjs: create `push` next to `ext`/`stats`, and add routes after the settings routes: `GET /api/push/key` → `{ key, subscribed: count }`, `POST /api/push/subscribe` (body = the PushSubscription JSON, validated: https endpoint, p256dh/auth strings), `DELETE /api/push/subscribe` {endpoint}. Test: test/push.test.mjs (node:test, no network): generate a receiver key pair and auth secret in the test, start a local http server as the fake push endpoint, call `send`, and decrypt the body in the test with the same RFC 8291 steps (implement the decrypt side there) asserting the JSON payload round-trips; verify the vapid JWT signature with the public key; assert a 410 from the endpoint removes the subscription; assert `publicKey()` is stable across two `createPush` calls on the same dataDir. Add a paragraph to README.md under Security notes (VAPID keys live in data/, never tracked). Run `npm test -- test/push.test.mjs test/server.test.mjs`.

## Done when

`npm test -- test/push.test.mjs test/server.test.mjs` passes and `grep -n "'/api/push/key'" server.mjs` prints a line
