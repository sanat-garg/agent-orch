// push.mjs (Web Push): aes128gcm payloads decrypt with the receiver's keys (RFC 8291 done here in reverse), the VAPID
// JWT verifies with the public key, a 410 drops the device, and the key pair survives a restart. No network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createPush, checkSub, TTL, RECORD_SIZE } from '../push.mjs';

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
// A fake push service: records each request and answers with `status`.
async function fakeService(status) {
  const reqs = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { reqs.push({ headers: req.headers, url: req.url, body: Buffer.concat(chunks) }); res.writeHead(status.code); res.end(); });
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

test('the VAPID public key is made once and stable across restarts', () => {
  const dir = path.join(tmp, 'stable');
  const a = createPush({ dataDir: dir }), b = createPush({ dataDir: dir });
  assert.equal(a.publicKey(), b.publicKey());
  assert.equal(Buffer.from(a.publicKey(), 'base64url').length, 65);
  assert.equal(Buffer.from(a.publicKey(), 'base64url')[0], 4);
  assert.equal(fs.statSync(path.join(dir, 'push-vapid.json')).mode & 0o777, 0o600);
  assert.notEqual(createPush({ dataDir: path.join(tmp, 'other') }).publicKey(), a.publicKey());
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
  assert.deepEqual(await push.send(msg), { sent: 1, removed: 0, failed: 0 });
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
  assert.equal(claims.sub, 'mailto:owner@localhost');
  const now = Date.now() / 1000;
  assert.ok(claims.exp > now + 11 * 3600 && claims.exp <= now + 12 * 3600 + 1);
  const pub = Buffer.from(push.publicKey(), 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
  assert.ok(logs.some((l) => /Task #7 done.*201/.test(l)));

  // A 500 is a failure that keeps the device; a 410 means it's gone.
  status.code = 500;
  assert.deepEqual(await push.send(msg), { sent: 0, removed: 0, failed: 1 });
  assert.equal(push.count(), 1);
  status.code = 410;
  assert.deepEqual(await push.send(msg), { sent: 0, removed: 1, failed: 0 });
  assert.equal(push.count(), 0);
  assert.equal(createPush({ dataDir: path.join(tmp, 'send') }).count(), 0, 'the removal is saved');
});

test('send never throws: unreachable endpoints and an unsubscribe', async () => {
  const push = createPush({ dataDir: path.join(tmp, 'down') });
  const rx = receiver();
  push.subscribe({ endpoint: 'http://127.0.0.1:1/x', keys: rx.keys });
  assert.deepEqual(await push.send({ title: 't' }), { sent: 0, removed: 0, failed: 1 });
  assert.equal(push.unsubscribe('http://127.0.0.1:1/x'), 1);
  assert.equal(push.unsubscribe('http://127.0.0.1:1/x'), 0);
  assert.deepEqual(await push.send({ title: 't' }), { sent: 0, removed: 0, failed: 0 });
});
