// Web Push with no dependency: VAPID (RFC 8292) ES256 JWTs and aes128gcm payloads (RFC 8291 / RFC 8188) on node:crypto,
// so notifications reach the owner's phone while the app is closed. The VAPID key pair is made once and kept in
// <dataDir>/push-vapid.json (0600); subscribed devices in <dataDir>/push-subscriptions.json
// [{endpoint, keys, ua, addedAt, fails, pausedUntil}].
//   createPush({dataDir, log}) → { publicKey(), subscribe(sub), unsubscribe(endpoint), count(), send(msg) }
// send({title, body, tag, url, badge}) posts to every device and resolves {sent, removed, failed, skipped}; it never throws.
// A 404 or 410 means the device is gone, so that subscription is dropped. 400/401/403/413 (bad subscription, VAPID
// mismatch, payload too large) count as `fails`; a 2xx resets it and the third in a row drops the device. A 429 or 503
// pauses the device until its Retry-After (seconds or an HTTP date; 60 s when missing, at most 1 h), and sends meanwhile
// skip it without a network call. subscribe() clears both for a re-subscribed endpoint.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export const TTL = 86400;
export const JWT_TTL_S = 12 * 3600;
export const RECORD_SIZE = 4096;
const SUBJECT = 'mailto:owner@localhost';
const TIMEOUT_MS = 15_000;
export const MAX_FAILS = 3;
const PERMANENT = new Set([400, 401, 403, 413]);
const RETRY_DEFAULT_MS = 60_000, RETRY_MAX_MS = 3600_000;

// A Retry-After header (delta seconds or an HTTP date) → ms to wait: 60 s when missing or unparsable, capped at 1 h.
export function retryAfterMs(h, now = Date.now()) {
  const v = String(h ?? '').trim();
  let ms = NaN;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else if (/[a-z]/i.test(v)) { const t = Date.parse(v); if (Number.isFinite(t)) ms = Math.max(0, t - now); }
  return Number.isFinite(ms) ? Math.min(ms, RETRY_MAX_MS) : RETRY_DEFAULT_MS;
}

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const B64U_RE = /^[A-Za-z0-9_-]+={0,2}$/;
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2), { mode: 0o600 });
  fs.renameSync(f + '.tmp', f);
}

// Why a browser's PushSubscription JSON can't be stored (null: fine). Endpoints must be https; p256dh is an
// uncompressed P-256 point (65 bytes), auth a 16-byte secret, both base64url.
export function checkSub(sub) {
  let u;
  try { u = new URL(sub?.endpoint); } catch { return 'endpoint must be an https URL'; }
  if (u.protocol !== 'https:') return 'endpoint must be an https URL';
  const { p256dh, auth } = sub.keys || {};
  if (typeof p256dh !== 'string' || !B64U_RE.test(p256dh) || unb64u(p256dh).length !== 65) return 'keys.p256dh must be a base64url P-256 key';
  if (typeof auth !== 'string' || !B64U_RE.test(auth) || unb64u(auth).length !== 16) return 'keys.auth must be a base64url 16-byte secret';
  return null;
}

// RFC 8291: one aes128gcm record for the subscription's keys. Returns the full request body (header + record).
export function encrypt(payload, p256dh, auth, { salt = crypto.randomBytes(16), ecdh } = {}) {
  const ua = unb64u(p256dh);
  if (!ecdh) { ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); }
  const as = ecdh.getPublicKey();
  const ikm = hkdf(unb64u(auth), ecdh.computeSecret(ua), Buffer.concat([Buffer.from('WebPush: info\0'), ua, as]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0); head.writeUInt32BE(RECORD_SIZE, 16); head[20] = as.length;
  return Buffer.concat([head, as, record]);
}

export function createPush({ dataDir, log = () => {} }) {
  const keyFile = path.join(dataDir, 'push-vapid.json'), subFile = path.join(dataDir, 'push-subscriptions.json');
  let vapid = readJson(keyFile);
  if (!vapid?.publicKey || !vapid?.privateKey) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const { x, y } = publicKey.export({ format: 'jwk' });
    vapid = { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(x), unb64u(y)])),
      privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), createdAt: Date.now() };
    writeJson(keyFile, vapid);
    log('made a new VAPID key pair');
  }
  const signer = crypto.createPrivateKey(vapid.privateKey);
  let subs = Array.isArray(readJson(subFile)) ? readJson(subFile) : [];
  const save = () => writeJson(subFile, subs);

  // `vapid t=<ES256 JWT for the endpoint's origin>, k=<public key>` (RFC 8292).
  function authorization(endpoint) {
    const enc = (o) => b64u(JSON.stringify(o));
    const data = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + JWT_TTL_S, sub: SUBJECT })}`;
    const sig = crypto.sign('sha256', Buffer.from(data), { key: signer, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${data}.${b64u(sig)}, k=${vapid.publicKey}`;
  }
  // One POST → {code, retryAfter}: the status code (0 on a network error or timeout) and the Retry-After header.
  function post(sub, body) {
    return new Promise((resolve) => {
      let req;
      try {
        const u = new URL(sub.endpoint);
        req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', timeout: TIMEOUT_MS, headers: {
          'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', 'Content-Length': body.length,
          TTL: String(TTL), Urgency: 'high', Authorization: authorization(sub.endpoint) } }, (res) => {
          const done = () => resolve({ code: res.statusCode, retryAfter: res.headers['retry-after'] });
          res.resume(); res.on('end', done); res.on('error', done);
        });
      } catch { return resolve({ code: 0 }); }
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => resolve({ code: 0 }));
      req.end(body);
    });
  }

  return {
    publicKey: () => vapid.publicKey,
    count: () => subs.length,
    subscribe(sub) {
      const s = { endpoint: String(sub.endpoint), keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) },
        ua: String(sub.ua || '').slice(0, 300), addedAt: Date.now(), fails: 0, pausedUntil: 0 };
      subs = [...subs.filter((x) => x.endpoint !== s.endpoint), s];
      save();
      log(`subscribed ${new URL(s.endpoint).host} (${subs.length} device${subs.length === 1 ? '' : 's'})`);
      return subs.length;
    },
    unsubscribe(endpoint) {
      const n = subs.length;
      subs = subs.filter((x) => x.endpoint !== endpoint);
      if (subs.length !== n) { save(); log(`unsubscribed a device (${subs.length} left)`); }
      return n - subs.length;
    },
    async send({ title, body, tag, url, badge } = {}) {
      const r = { sent: 0, removed: 0, failed: 0, skipped: 0 };
      let dirty = false;
      try {
        const payload = JSON.stringify({ title: String(title || 'agent-orch').slice(0, 200), body: String(body || '').slice(0, 1000), tag, url, badge });
        await Promise.all(subs.map(async (sub) => {
          if ((sub.pausedUntil || 0) > Date.now()) { r.skipped++; return; }
          let code = 0, retryAfter;
          try { ({ code, retryAfter } = await post(sub, encrypt(payload, sub.keys.p256dh, sub.keys.auth))); } catch {}
          const host = (() => { try { return new URL(sub.endpoint).host; } catch { return '?'; } })();
          const drop = () => { r.removed++; dirty = true; subs = subs.filter((x) => x.endpoint !== sub.endpoint); };
          let note = '';
          if (code >= 200 && code < 300) {
            r.sent++;
            if (sub.fails || sub.pausedUntil) { sub.fails = 0; sub.pausedUntil = 0; dirty = true; }
          } else if (code === 404 || code === 410) { drop(); note = ' (removed)'; }
          else if (PERMANENT.has(code)) {
            sub.fails = (sub.fails || 0) + 1; dirty = true;
            if (sub.fails >= MAX_FAILS) { drop(); note = ` (removed after ${sub.fails} rejections)`; }
            else { r.failed++; note = ` (${sub.fails}/${MAX_FAILS})`; }
          } else if (code === 429 || code === 503) {
            const wait = retryAfterMs(retryAfter);
            sub.pausedUntil = Date.now() + wait; dirty = true; r.failed++;
            note = ` (paused ${Math.round(wait / 1000)} s)`;
          } else r.failed++;
          log(`send "${String(title || '').slice(0, 60)}" → ${host}: ${code || 'network error'}${note}`);
        }));
        if (dirty) save();
      } catch (e) { log(`send failed: ${e.message}`); }
      return r;
    },
  };
}
