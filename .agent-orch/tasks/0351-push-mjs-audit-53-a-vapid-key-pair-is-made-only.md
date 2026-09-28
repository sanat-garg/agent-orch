# Task #351: push.mjs AUDIT #53: a VAPID key pair is made only when the file is missing; a bad file or PEM turns push off instead of overwriting or throwing

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:31  
- files: push.mjs, test/push.test.mjs

## Prompt

Reliability fix in push.mjs createPush (read the module header and .agent-orch/AUDIT.md Round 7 finding #53). Today readJson returns null on ANY error, so an unreadable push-vapid.json (EACCES, EMFILE) is treated as missing and a NEW key pair overwrites it; every existing subscription was made for the old applicationServerKey, so push services answer 403 for good. A file that parses but holds a bad PEM makes crypto.createPrivateKey throw at server.mjs's top level, which stops the app from booting. Fix: (1) generate a key pair only when the file does not exist (ENOENT); on any other read/parse error, or when createPrivateKey throws, log the reason, keep the file untouched and return a disabled push object: publicKey() returns null, count() returns the saved subscription count, subscribe() throws a plain Error('push is off: <reason>'), send() resolves {sent:0, failed:0, off:true} without any request, and expose `disabled` (the reason string or null) so server.mjs can show it later; (2) checkSub rejects a p256dh that is not a point on P-256 (a trial `createECDH('prime256v1').computeSecret` in a try/catch) with the message 'keys.p256dh must be a P-256 point'; (3) SUBJECT becomes an https URL passed in as `subject` (createPush({dataDir, subject})), defaulting to 'https://agent-orch.local' when absent; do not change server.mjs (it is held by other tasks): the default keeps it working. Add tests to test/push.test.mjs on a temp dir: chmod 000 on push-vapid.json → createPush returns disabled with the same file content and mode afterwards (skip that case when running as root); a file with a bad PEM → disabled, no throw, file unchanged; ENOENT → a key pair is generated as before; checkSub rejects a 65-byte p256dh that is not on the curve (e.g. 0x04 followed by 64 zero bytes) and accepts a real one. AUDIT.md is held by other tasks: do not edit it. Verify with `npm test -- test/push.test.mjs`.

## Done when

`npm test -- test/push.test.mjs` passes and `grep -q 'ENOENT' push.mjs` and `grep -q 'disabled' push.mjs`
