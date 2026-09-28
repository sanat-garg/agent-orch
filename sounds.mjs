// Custom task-finished sounds (#432): audio files the owner adds (an upload, or an https URL the head downloads once, so
// nothing is hotlinked at play time), stored by content hash at <DATA>/sounds/<id>.<ext> (id: the first 24 hex of its
// sha256) with their names, lengths and volumes in <DATA>/sounds/custom.json, plus the one used for all machines
// (`default`). A machine picks one as node.sound = 'custom:<id>' (cluster.mjs); public/app.js plays it with Web Audio.
// Limits: MAX_SOUND_BYTES and a format known from the magic bytes (mp3, aac, m4a, wav, ogg), never the claimed type;
// the length (MAX_SOUND_SECONDS) is measured by the browser (decodeAudioData) and, for wav, from its header here.
//   createSounds(dataDir) → { list(), get(id), add(buf, {name, type, duration}), importUrl(url, meta, fetchOpts),
//     update(id, {name, volume, duration}), remove(id), setDefault(id | null) }; errors come back as {error, status}.
//   download(url, {allowPrivate, ca, timeoutMs}) → {buf, type}: https only, public addresses only, ≤ 3 redirects.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { safeName } from './uploads.mjs';

export const MAX_SOUND_BYTES = 1024 * 1024;
export const MAX_SOUND_SECONDS = 10;
export const MAX_SOUNDS = 50;
export const SOUND_ID_RE = /^[a-f0-9]{24}$/;
export const SOUND_TYPES = { mp3: 'audio/mpeg', aac: 'audio/aac', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg' };
// A claimed type that may carry audio; anything else (text/html, image/png…) is refused before the bytes are looked at.
const AUDIO_TYPE_RE = /^(audio\/[\w.+-]+|application\/(octet-stream|ogg)|binary\/octet-stream|video\/(mp4|ogg))$/i;
export const audioType = (t) => !t || AUDIO_TYPE_RE.test(String(t).split(';')[0].trim());

// The format from the bytes: ID3 or an MPEG frame sync (mp3; layer bits 00 = AAC in ADTS), ftyp (m4a), RIFF…WAVE, OggS.
export function sniffAudio(b) {
  if (!b || b.length < 12) return null;
  const s = (a, z) => b.toString('latin1', a, z);
  if (s(0, 3) === 'ID3') return 'mp3';
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'aac';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06)) return 'mp3';
  if (s(4, 8) === 'ftyp') return 'm4a';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'wav';
  if (s(0, 4) === 'OggS') return 'ogg';
  return null;
}

// A wav's length from its fmt byte rate and data size; null when the header doesn't say.
export function wavSeconds(b) {
  let rate = 0;
  for (let i = 12; i + 8 <= b.length;) {
    const id = b.toString('latin1', i, i + 4), size = b.readUInt32LE(i + 4);
    if (id === 'fmt ' && i + 20 <= b.length) rate = b.readUInt32LE(i + 16);
    if (id === 'data') return rate ? size / rate : null;
    i += 8 + size + (size & 1);
  }
  return null;
}

const PRIVATE = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) PRIVATE.addSubnet(a, n, 'ipv4');
for (const [a, n] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVATE.addSubnet(a, n, 'ipv6');
export function privateAddress(ip) {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (v4) return PRIVATE.check(v4, 'ipv4');
  const fam = net.isIP(ip);
  return fam ? PRIVATE.check(ip, fam === 6 ? 'ipv6' : 'ipv4') : true;
}

// Fetches a sound over https once: public addresses only (checked on every lookup, so a redirect or a DNS answer can't
// reach this machine's network), at most MAX_SOUND_BYTES, 15 s in all.
export function download(url, { allowPrivate = false, ca, timeoutMs = 15000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('Not a valid URL')); }
    if (u.protocol !== 'https:') return reject(new Error('Only https URLs can be imported'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && (net.isIP(host) ? privateAddress(host) : /^localhost$|\.localhost$/i.test(host))) return reject(new Error('That address is not on the public internet'));
    const lookup = (hostname, opts, cb) => dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!allowPrivate && addrs.some((a) => privateAddress(a.address))) return cb(new Error('That address is not on the public internet'));
      return opts.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
    });
    const req = https.get(u, { lookup, ca, headers: { 'User-Agent': 'agent-orch', Accept: 'audio/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (!redirects) return reject(new Error('Too many redirects'));
        return download(new URL(res.headers.location, u).href, { allowPrivate, ca, timeoutMs, redirects: redirects - 1 }).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`The URL answered ${res.statusCode}`)); }
      const type = res.headers['content-type'] || '';
      if (!audioType(type)) { res.destroy(); return reject(new Error(`Not an audio file (${type.split(';')[0]})`)); }
      if (Number(res.headers['content-length']) > MAX_SOUND_BYTES) { res.destroy(); return reject(Object.assign(new Error(tooBig), { status: 413 })); }
      const chunks = []; let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > MAX_SOUND_BYTES) { res.destroy(); reject(Object.assign(new Error(tooBig), { status: 413 })); } else chunks.push(c);
      });
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), type }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('The URL took too long to answer')));
    req.on('error', reject);
  });
}
const tooBig = `The sound is over ${MAX_SOUND_BYTES / 1024 / 1024} MB`;

export function createSounds(dataDir) {
  const dir = path.join(dataDir, 'sounds'), indexFile = path.join(dir, 'custom.json');
  const read = () => { try { const d = JSON.parse(fs.readFileSync(indexFile, 'utf8')); return { default: d.default ?? null, sounds: d.sounds || [] }; } catch { return { default: null, sounds: [] }; } };
  const write = (d) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(indexFile + '.tmp', JSON.stringify(d)); fs.renameSync(indexFile + '.tmp', indexFile); };
  const view = (s) => ({ id: s.id, key: `custom:${s.id}`, name: s.name, ext: s.ext, type: SOUND_TYPES[s.ext], size: s.size,
    duration: s.duration ?? null, volume: s.volume, at: s.at, url: `/api/sounds/${s.id}` });
  const seconds = (v) => (v == null || v === '' ? null : Number(v));
  const badSeconds = (d) => d != null && !(Number.isFinite(d) && d > 0 && d <= MAX_SOUND_SECONDS + 0.05);

  function add(buf, { name, type, duration } = {}) {
    if (!buf?.length) return { error: 'The file is empty', status: 400 };
    if (buf.length > MAX_SOUND_BYTES) return { error: tooBig, status: 413 };
    if (!audioType(type)) return { error: 'Not an audio file', status: 415 };
    const ext = sniffAudio(buf);
    if (!ext) return { error: 'Not an mp3, m4a/aac, wav or ogg file', status: 415 };
    let secs = seconds(duration);
    if (ext === 'wav') secs = wavSeconds(buf) ?? secs;
    if (badSeconds(secs)) return { error: `The sound is longer than ${MAX_SOUND_SECONDS} s`, status: 400 };
    const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24), d = read();
    const old = d.sounds.find((s) => s.id === id);
    if (old) return { sound: view(old) };
    if (d.sounds.length >= MAX_SOUNDS) return { error: `At most ${MAX_SOUNDS} custom sounds`, status: 400 };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.${ext}`), buf);
    const s = { id, ext, name: safeName(name || 'Sound').replace(/\.(mp3|m4a|aac|wav|ogg)$/i, '').slice(0, 60) || 'Sound',
      size: buf.length, duration: secs == null ? null : Math.round(secs * 100) / 100, volume: 100, at: Date.now() };
    d.sounds.push(s);
    write(d);
    return { sound: view(s) };
  }
  const get = (id) => {
    const s = SOUND_ID_RE.test(String(id)) && read().sounds.find((x) => x.id === id);
    return s ? { ...view(s), file: path.join(dir, `${s.id}.${s.ext}`) } : null;
  };
  return {
    list: () => { const d = read(); return { sounds: d.sounds.map(view), default: d.default }; },
    get, add,
    async importUrl(url, meta = {}, opts = {}) {
      let got;
      try { got = await download(url, opts); } catch (e) { return { error: e.message, status: e.status || 400 }; }
      let name = meta.name;
      if (!name) try { name = decodeURIComponent(path.posix.basename(new URL(url).pathname)) || new URL(url).hostname; } catch {}
      return add(got.buf, { ...meta, name, type: got.type });
    },
    update(id, body = {}) {
      const d = read(), s = d.sounds.find((x) => x.id === id);
      if (!s) return { error: 'No such sound', status: 404 };
      if (body.name !== undefined) {
        const n = String(body.name).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
        if (!n) return { error: 'The name is empty', status: 400 };
        s.name = n;
      }
      if (body.volume !== undefined) {
        if (!(Number.isInteger(body.volume) && body.volume >= 0 && body.volume <= 100)) return { error: 'volume must be an integer 0-100', status: 400 };
        s.volume = body.volume;
      }
      if (body.duration !== undefined && s.ext !== 'wav') {
        const secs = seconds(body.duration);
        if (secs == null || badSeconds(secs)) return { error: `duration must be 0-${MAX_SOUND_SECONDS} s`, status: 400 };
        s.duration = Math.round(secs * 100) / 100;
      }
      write(d);
      return { sound: view(s) };
    },
    remove(id) {
      const d = read(), s = d.sounds.find((x) => x.id === id);
      if (!s) return { error: 'No such sound', status: 404 };
      d.sounds = d.sounds.filter((x) => x !== s);
      if (d.default === id) d.default = null;
      write(d);
      fs.rmSync(path.join(dir, `${s.id}.${s.ext}`), { force: true });
      return { ok: true, key: `custom:${id}`, default: d.default };
    },
    setDefault(id) {
      const d = read();
      if (id !== null && !d.sounds.some((x) => x.id === id)) return { error: 'No such sound', status: 404 };
      d.default = id;
      write(d);
      return { ok: true, default: id };
    },
  };
}
