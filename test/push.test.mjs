// push.mjs (Web Push): aes128gcm payloads decrypt with the receiver's keys (RFC 8291 done here in reverse), the VAPID
// JWT verifies with the public key, a 410 or three 403s drop the device, a 429 pauses it for its Retry-After, and the key
// pair survives a restart. No network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createPush, checkSub, retryAfterMs, TTL, RECORD_SIZE } from '../push.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-push-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const b64u = (b) => Buffer.from(b).toString('base64url');
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

// The browser's side: a P-256 key pair and a 16-byte auth secret, and RFC 8291 decryption of one aes128gcm body.
function receiver() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } };
}
function decrypt(body, { ecdh, auth }) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20];
  const as = body.subarray(21, 21 + idlen), record = body.subarray(21 + idlen);
  assert.equal(rs, RECORD_SIZE);
  assert.equal(idlen, 65);
  assert.ok(record.length <= rs);
  const ua = ecdh.getPublicKey();
  const ikm = hkdf(auth, ecdh.computeSecret(as), Buffer.concat([Buffer.from('WebPush: info\0'), ua, as]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(record.subarray(-16));
  const plain = Buffer.concat([d.update(record.subarray(0, -16)), d.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--; // strip padding up to the delimiter
  assert.equal(plain[end], 2, 'last-record delimiter');
  return JSON.parse(plain.subarray(0, end).toString());
}
// A fake push service: records each request and answers with `status` ({code, headers}).
async function fakeService(status) {
  const reqs = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { reqs.push({ headers: req.headers, url: req.url, body: Buffer.concat(chunks) }); res.writeHead(status.code, status.headers || {}); res.end(); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  after(() => srv.close());
  return { reqs, url: `http://127.0.0.1:${srv.address().port}` };
}

test('checkSub accepts a PushSubscription and refuses non-https endpoints and bad keys', () => {
  const { keys } = receiver();
  assert.equal(checkSub({ endpoint: 'https://web.push.apple.com/abc', keys }), null);
  assert.match(checkSub({ endpoint: 'http://web.push.apple.com/abc', keys }), /https/);
  assert.match(checkSub({ endpoint: 'nope', keys }), /https/);
  assert.match(checkSub({ endpoint: 'https://x.test/a', keys: { ...keys, p256dh: 5 } }), /p256dh/);
  assert.match(checkSub({ endpoint: 'https://x.test/a', keys: { ...keys, auth: b64u(Buffer.alloc(8)) } }), /auth/);
  assert.match(checkSub({ endpoint: 'https://x.test/a' }), /p256dh/);
});

test('checkSub refuses a 65-byte p256dh that is not a point on P-256', () => {
  const { keys } = receiver();
  const offCurve = b64u(Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]));
  assert.equal(checkSub({ endpoint: 'https://x.test/a', keys: { ...keys, p256dh: offCurve } }), 'keys.p256dh must be a P-256 point');
  assert.equal(checkSub({ endpoint: 'https://x.test/a', keys }), null);
});

// A key file that exists but can't be used turns push off and is left exactly as it was.
function assertOff(push, file, before) {
  assert.equal(typeof push.disabled, 'string');
  assert.equal(push.publicKey(), null);
  assert.throws(() => push.subscribe({ endpoint: 'https://x.test/a', keys: receiver().keys }), /^Error: push is off: /);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
}

test('a key file with a bad PEM turns push off without throwing or touching the file', async () => {
  const dir = path.join(tmp, 'badpem');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'push-vapid.json');
  const before = JSON.stringify({ publicKey: 'x', privateKey: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' });
  fs.writeFileSync(file, before, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'push-subscriptions.json'), JSON.stringify([{ endpoint: 'https://x.test/1', keys: receiver().keys }]));
  const logs = [];
  const push = createPush({ dataDir: dir, log: (m) => logs.push(m) });
  assertOff(push, file, before);
  assert.match(push.disabled, /private key/);
  assert.equal(push.count(), 1, 'the saved devices are still counted');
  assert.deepEqual(await push.send({ title: 't' }), { sent: 0, failed: 0, off: true });
  assert.ok(logs.some((l) => /push is off/.test(l)), logs.join('\n'));
  fs.writeFileSync(file, '{not json');
  assertOff(createPush({ dataDir: dir }), file, '{not json');
});

test('an unreadable key file turns push off and keeps its content and mode', { skip: process.getuid?.() === 0 && 'root reads any file' }, () => {
  const dir = path.join(tmp, 'eacces');
  const first = createPush({ dataDir: dir });
  const file = path.join(dir, 'push-vapid.json');
  const before = fs.readFileSync(file, 'utf8');
  fs.chmodSync(file, 0o000);
  try {
    const push = createPush({ dataDir: dir });
    assert.match(push.disabled, /EACCES/);
    assert.equal(push.publicKey(), null);
    assert.equal(fs.statSync(file).mode & 0o777, 0o000);
  } finally { fs.chmodSync(file, 0o600); }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(createPush({ dataDir: dir }).publicKey(), first.publicKey());
});

test('the VAPID public key is made once and stable across restarts', () => {
  const dir = path.join(tmp, 'stable');
  const a = createPush({ dataDir: dir }), b = createPush({ dataDir: dir });
  assert.equal(a.publicKey(), b.publicKey());
  assert.equal(Buffer.from(a.publicKey(), 'base64url').length, 65);
  assert.equal(Buffer.from(a.publicKey(), 'base64url')[0], 4);
  assert.equal(fs.statSync(path.join(dir, 'push-vapid.json')).mode & 0o777, 0o600);
  assert.notEqual(createPush({ dataDir: path.join(tmp, 'other') }).publicKey(), a.publicKey());
  assert.equal(a.disabled, null);
  assert.equal(b.disabled, null);
});

test('send encrypts per RFC 8291 and signs a VAPID JWT for the endpoint origin', async () => {
  const status = { code: 201 };
  const svc = await fakeService(status);
  const logs = [];
  const push = createPush({ dataDir: path.join(tmp, 'send'), log: (m) => logs.push(m) });
  const rx = receiver();
  push.subscribe({ endpoint: `${svc.url}/push/1`, keys: rx.keys, ua: 'iPhone' });
  push.subscribe({ endpoint: `${svc.url}/push/1`, keys: rx.keys, ua: 'iPhone' }); // same endpoint: replaced, not added
  assert.equal(push.count(), 1);
  const msg = { title: 'Task #7 done', body: 'Merged ✓', tag: 'task-7', url: '/#task-7', badge: 3 };
  assert.deepEqual(await push.send(msg), { sent: 1, removed: 0, failed: 0, skipped: 0 });
  const [r] = svc.reqs;
  assert.equal(r.url, '/push/1');
  assert.equal(r.headers['content-encoding'], 'aes128gcm');
  assert.equal(r.headers.ttl, String(TTL));
  assert.equal(r.headers.urgency, 'high');
  assert.deepEqual(decrypt(r.body, rx), msg);

  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(r.headers.authorization);
  assert.ok(m, r.headers.authorization);
  assert.equal(m[4], push.publicKey());
  assert.deepEqual(JSON.parse(Buffer.from(m[1], 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
  assert.equal(claims.aud, svc.url);
  assert.equal(claims.sub, 'https://agent-orch.local', 'the default subject is an https URL');
  const now = Date.now() / 1000;
  assert.ok(claims.exp > now + 11 * 3600 && claims.exp <= now + 12 * 3600 + 1);
  const pub = Buffer.from(push.publicKey(), 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
  assert.ok(logs.some((l) => /Task #7 done.*201/.test(l)));

  // A 500 is a failure that keeps the device; a 410 means it's gone.
  status.code = 500;
  assert.deepEqual(await push.send(msg), { sent: 0, removed: 0, failed: 1, skipped: 0 });
  assert.equal(push.count(), 1);
  status.code = 410;
  assert.deepEqual(await push.send(msg), { sent: 0, removed: 1, failed: 0, skipped: 0 });
  assert.equal(push.count(), 0);
  assert.equal(createPush({ dataDir: path.join(tmp, 'send') }).count(), 0, 'the removal is saved');
});

test('send never throws: unreachable endpoints and an unsubscribe', async () => {
  const push = createPush({ dataDir: path.join(tmp, 'down') });
  const rx = receiver();
  push.subscribe({ endpoint: 'http://127.0.0.1:1/x', keys: rx.keys });
  assert.deepEqual(await push.send({ title: 't' }), { sent: 0, removed: 0, failed: 1, skipped: 0 });
  assert.equal(push.unsubscribe('http://127.0.0.1:1/x'), 1);
  assert.equal(push.unsubscribe('http://127.0.0.1:1/x'), 0);
  assert.deepEqual(await push.send({ title: 't' }), { sent: 0, removed: 0, failed: 0, skipped: 0 });
});

test('three permanent rejections in a row drop the device; a 2xx in between resets the count', async () => {
  const status = { code: 403 };
  const svc = await fakeService(status);
  const logs = [];
  const dir = path.join(tmp, 'fails');
  const push = createPush({ dataDir: dir, log: (m) => logs.push(m) });
  push.subscribe({ endpoint: `${svc.url}/p`, keys: receiver().keys });
  const stored = () => JSON.parse(fs.readFileSync(path.join(dir, 'push-subscriptions.json'), 'utf8'))[0];
  assert.deepEqual(await push.send({ title: 't' }), { sent: 0, removed: 0, failed: 1, skipped: 0 });
  assert.deepEqual(await push.send({ title: 't' }), { sent: 0, removed: 0, failed: 1, skipped: 0 });
  assert.equal(stored().fails, 2, 'the count is saved');
  status.code = 201;
  assert.deepEqual(await push.send({ title: 't' }), { sent: 1, removed: 0, failed: 0, skipped: 0 });
  assert.equal(stored().fails, 0);
  status.code = 400;
  assert.deepEqual(await push.send({ title: 't' }), { sent: 0, removed: 0, failed: 1, skipped: 0 });
  status.code = 401;
  assert.deepEqual(await push.send({ title: 't' }), { sent: 0, removed: 0, failed: 1, skipped: 0 });
  assert.equal(push.count(), 1, 'two rejections after the reset keep the device');
  push.subscribe({ endpoint: `${svc.url}/p`, keys: receiver().keys });
  assert.equal(stored().fails, 0, 're-subscribing clears the count');
  status.code = 403;
  assert.deepEqual(await push.send({ title: 't' }), { sent: 0, removed: 0, failed: 1, skipped: 0 });
  assert.deepEqual(await push.send({ title: 't' }), { sent: 0, removed: 0, failed: 1, skipped: 0 });
  assert.deepEqual(await push.send({ title: 't' }), { sent: 0, removed: 1, failed: 0, skipped: 0 });
  assert.equal(push.count(), 0);
  assert.equal(createPush({ dataDir: dir }).count(), 0, 'the removal is saved');
  assert.ok(logs.some((l) => /403 \(removed after 3/.test(l)), logs.join('\n'));
  assert.equal(svc.reqs.length, 8);
});

test('a 429 pauses the device for its Retry-After: sends skip it without a request, then it goes through', async () => {
  const status = { code: 429, headers: { 'Retry-After': '2' } };
  const svc = await fakeService(status);
  const dir = path.join(tmp, 'retry');
  const push = createPush({ dataDir: dir });
  push.subscribe({ endpoint: `${svc.url}/p`, keys: receiver().keys });
  const t0 = Date.now();
  assert.deepEqual(await push.send({ title: 't' }), { sent: 0, removed: 0, failed: 1, skipped: 0 });
  const until = JSON.parse(fs.readFileSync(path.join(dir, 'push-subscriptions.json'), 'utf8'))[0].pausedUntil;
  assert.ok(until >= t0 + 2000 && until <= Date.now() + 2000, 'pausedUntil is saved');
  status.code = 201; status.headers = {};
  assert.deepEqual(await push.send({ title: 't' }), { sent: 0, removed: 0, failed: 0, skipped: 1 });
  assert.equal(svc.reqs.length, 1, 'a paused device costs no request');
  assert.equal(push.count(), 1);
  await new Promise((r) => setTimeout(r, until - Date.now() + 50));
  assert.deepEqual(await push.send({ title: 't' }), { sent: 1, removed: 0, failed: 0, skipped: 0 });
  assert.equal(svc.reqs.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'push-subscriptions.json'), 'utf8'))[0].pausedUntil, 0);
});

test('a 503 pause is lifted by re-subscribing', async () => {
  const status = { code: 503 };
  const svc = await fakeService(status);
  const push = createPush({ dataDir: path.join(tmp, 'resub') });
  const keys = receiver().keys;
  push.subscribe({ endpoint: `${svc.url}/p`, keys });
  assert.deepEqual(await push.send({ title: 't' }), { sent: 0, removed: 0, failed: 1, skipped: 0 });
  assert.deepEqual(await push.send({ title: 't' }), { sent: 0, removed: 0, failed: 0, skipped: 1 });
  push.subscribe({ endpoint: `${svc.url}/p`, keys });
  status.code = 201;
  assert.deepEqual(await push.send({ title: 't' }), { sent: 1, removed: 0, failed: 0, skipped: 0 });
});

test('retryAfterMs reads seconds or an HTTP date, defaults to 60 s and caps at 1 h', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  assert.equal(retryAfterMs('2', now), 2000);
  assert.equal(retryAfterMs(' 120 ', now), 120_000);
  assert.equal(retryAfterMs('Mon, 28 Sep 2026 12:00:30 GMT', now), 30_000);
  assert.equal(retryAfterMs('Mon, 28 Sep 2026 11:00:00 GMT', now), 0);
  assert.equal(retryAfterMs(undefined, now), 60_000);
  assert.equal(retryAfterMs('soon', now), 60_000);
  assert.equal(retryAfterMs('-5', now), 60_000);
  assert.equal(retryAfterMs('99999', now), 3600_000);
  assert.equal(retryAfterMs('Tue, 29 Sep 2026 12:00:00 GMT', now), 3600_000);
});
