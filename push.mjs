// Web Push with no dependency: VAPID (RFC 8292) ES256 JWTs and aes128gcm payloads (RFC 8291 / RFC 8188) on node:crypto,
// so notifications reach the owner's phone while the app is closed. The VAPID key pair is made once and kept in
// <dataDir>/push-vapid.json (0600); subscribed devices in <dataDir>/push-subscriptions.json
// [{endpoint, keys, ua, addedAt, fails, pausedUntil}].
//   createPush({dataDir, subject, log}) → { publicKey(), subscribe(sub), unsubscribe(endpoint), count(), send(msg), disabled }
// `subject` is the JWT `sub` (an https URL; default https://agent-orch.local). A key pair is made only when the key file
// does not exist (ENOENT). Any other read error, bad JSON or a bad PEM leaves the file untouched and turns push off:
// `disabled` holds the reason (null when on), publicKey() is null, subscribe() throws, send() resolves {sent:0, failed:0, off:true}.
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
const DEFAULT_SUBJECT = 'https://agent-orch.local';
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
  try { const e = crypto.createECDH('prime256v1'); e.generateKeys(); e.computeSecret(unb64u(p256dh)); }
  catch { return 'keys.p256dh must be a P-256 point'; }
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

// The saved VAPID key pair and its signing key, or {off: reason}. Only a missing file (ENOENT) makes a new pair; anything
// else is left alone, since a new key would orphan every existing subscription (push services answer 403 for good).
function loadVapid(keyFile, log) {
  let text;
  try { text = fs.readFileSync(keyFile, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') return { off: `can't read ${path.basename(keyFile)}: ${e.code || e.message}` };
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const { x, y } = publicKey.export({ format: 'jwk' });
    const vapid = { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(x), unb64u(y)])),
      privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), createdAt: Date.now() };
    writeJson(keyFile, vapid);
    log('made a new VAPID key pair');
    return { vapid, signer: privateKey };
  }
  let vapid;
  try { vapid = JSON.parse(text); } catch (e) { return { off: `${path.basename(keyFile)} is not valid JSON: ${e.message}` }; }
  if (typeof vapid?.publicKey !== 'string' || typeof vapid?.privateKey !== 'string') return { off: `${path.basename(keyFile)} has no key pair` };
  try { return { vapid, signer: crypto.createPrivateKey(vapid.privateKey) }; } catch (e) {
    return { off: `${path.basename(keyFile)} holds a bad private key: ${e.code || e.message}` };
  }
}

export function createPush({ dataDir, subject = DEFAULT_SUBJECT, log = () => {} }) {
  const keyFile = path.join(dataDir, 'push-vapid.json'), subFile = path.join(dataDir, 'push-subscriptions.json');
  let subs = Array.isArray(readJson(subFile)) ? readJson(subFile) : [];
  const save = () => writeJson(subFile, subs);
  function unsubscribe(endpoint) {
    const n = subs.length;
    subs = subs.filter((x) => x.endpoint !== endpoint);
    if (subs.length !== n) { save(); log(`unsubscribed a device (${subs.length} left)`); }
    return n - subs.length;
  }
  const { vapid, signer, off } = loadVapid(keyFile, log);
  if (off) {
    log(`push is off: ${off}`);
    return {
      disabled: off,
      publicKey: () => null,
      count: () => subs.length,
      subscribe() { throw new Error(`push is off: ${off}`); },
      unsubscribe,
      send: async () => ({ sent: 0, failed: 0, off: true }),
    };
  }

  // `vapid t=<ES256 JWT for the endpoint's origin>, k=<public key>` (RFC 8292).
  function authorization(endpoint) {
    const enc = (o) => b64u(JSON.stringify(o));
    const data = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + JWT_TTL_S, sub: subject })}`;
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
    disabled: null,
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
    unsubscribe,
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

// Pacing for pushes, so the phone buzzes rarely but nothing that needs the owner is lost:
//   createNotifier(send, {tagMs, budget, budgetMs, now, setTimer, clearTimer, log}) → { notify(n), pending(), close() }
// notify(n) sends at once when its tag (n.tag || '') has not gone out within tagMs and fewer than `budget` pushes went
// out in the last budgetMs; it returns that send's promise (a throw resolves {sent:0, failed:1}), else undefined.
// A message on a tag still inside its minute is kept (the newest replaces an older kept one) and sent when the minute
// ends. Past the budget, a new message is only counted, and one summary push "<N> more need you" goes out when the
// window frees, before the kept messages flush in the order they were first kept. A send that throws or reaches no
// device ({sent: 0, failed > 0}) neither uses up its tag's minute nor the budget.
export function createNotifier(send, { tagMs = 60_000, budget = 5, budgetMs = 600_000, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} } = {}) {
  const sentAt = new Map(); // tag → {at} of its last push that did not fail
  const kept = new Map(); // tag → newest held-back message, in first-kept order
  const tagTimers = new Map(); // tag → timer for the end of its minute
  let stamps = []; // {at} of each push inside the budget window, oldest first
  let over = 0, budgetTimer = null;

  const tagWait = (key, t) => (sentAt.has(key) ? Math.max(0, sentAt.get(key).at + tagMs - t) : 0);
  function budgetWait(t) {
    stamps = stamps.filter((s) => t - s.at < budgetMs);
    return stamps.length < budget ? 0 : Math.max(0, stamps[stamps.length - budget].at + budgetMs - t);
  }
  const timer = (fn, ms) => { const h = setTimer(fn, ms); h?.unref?.(); return h; };

  function fire(key, n, t, onFail) {
    const stamp = { at: t };
    sentAt.set(key, stamp); stamps.push(stamp);
    for (const [k, s] of sentAt) if (t - s.at >= tagMs) sentAt.delete(k);
    const fail = (why) => {
      if (sentAt.get(key) === stamp) sentAt.delete(key);
      stamps = stamps.filter((s) => s !== stamp);
      log(`push "${String(n.title || '').slice(0, 60)}" failed (${why}); its tag stays free`);
      onFail?.();
      pump();
    };
    let p;
    try { p = Promise.resolve(send(n)); } catch (e) { p = Promise.reject(e); }
    return p.then((r) => {
      if (r && r.sent === 0 && r.failed > 0) fail(`${r.failed} device${r.failed === 1 ? '' : 's'} failed`);
      return r;
    }, (e) => { fail(e?.message || String(e)); return { sent: 0, failed: 1 }; });
  }

  // Send what is due now (the summary first, then kept messages in order) and arm timers for the rest.
  function pump() {
    const t = now();
    if (over && !budgetWait(t)) {
      const count = over;
      over = 0;
      log(`${count} push${count === 1 ? '' : 'es'} over the budget → one summary`);
      fire('summary', { title: 'agent-orch', body: `${count} more need you`, tag: 'summary', url: '/' }, t, () => { over += count; });
    }
    for (const [key, n] of kept) {
      if (budgetWait(t)) break;
      if (tagWait(key, t)) continue;
      kept.delete(key);
      if (tagTimers.has(key)) { clearTimer(tagTimers.get(key)); tagTimers.delete(key); }
      fire(key, n, t);
    }
    let needBudget = over > 0;
    for (const key of kept.keys()) {
      const wait = tagWait(key, t);
      if (!wait) needBudget = true;
      else if (!tagTimers.has(key)) tagTimers.set(key, timer(() => { tagTimers.delete(key); pump(); }, wait));
    }
    if (budgetTimer) { clearTimer(budgetTimer); budgetTimer = null; }
    if (needBudget) budgetTimer = timer(() => { budgetTimer = null; pump(); }, budgetWait(t));
  }

  return {
    notify(n) {
      if (over || kept.size) pump();
      const key = n?.tag || '', t = now();
      if (kept.has(key) || tagWait(key, t)) { kept.set(key, n); pump(); return undefined; }
      if (budgetWait(t)) { over++; pump(); return undefined; }
      return fire(key, n, t);
    },
    pending: () => [...kept.values()],
    close() {
      for (const h of tagTimers.values()) clearTimer(h);
      tagTimers.clear();
      if (budgetTimer) clearTimer(budgetTimer);
      budgetTimer = null;
    },
  };
}
