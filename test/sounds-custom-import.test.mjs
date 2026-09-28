// The URL import (sounds.mjs download + createSounds.importUrl): the head fetches the file once over https and keeps
// its own copy, so it still plays after the source is gone; the same limits as an upload (size, type, magic bytes);
// private addresses and endless redirects are refused. A local https server with a throwaway certificate plays the web.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createSounds, download, MAX_SOUND_BYTES, privateAddress } from '../sounds.mjs';

let dir, server, base, ca, hits = 0;
const routes = new Map();
function wav(seconds, rate = 8000) {
  const data = Math.round(seconds * rate), b = Buffer.alloc(44 + data, 0x80);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + data, 4); b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36, 'latin1'); b.writeUInt32LE(data, 40);
  return b;
}
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(5000, 7)]);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sounds-import-'));
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  ca = fs.readFileSync(cert);
  routes.set('/ding.wav', ['audio/wav', wav(2)]);
  routes.set('/pop.mp3', ['audio/mpeg', mp3]);
  routes.set('/page.html', ['text/html', Buffer.from('<html>nope</html>')]);
  routes.set('/fake.mp3', ['audio/mpeg', Buffer.from('this is not an mp3 file at all')]);
  routes.set('/long.wav', ['audio/wav', wav(11)]);
  routes.set('/big.mp3', ['audio/mpeg', Buffer.concat([Buffer.from('ID3'), Buffer.alloc(MAX_SOUND_BYTES)])]);
  server = https.createServer({ key: fs.readFileSync(key), cert: ca }, (req, res) => {
    hits++;
    if (req.url === '/moved') { res.writeHead(302, { Location: '/pop.mp3' }); return res.end(); }
    if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); return res.end(); }
    if (req.url === '/chunked-big') { // no Content-Length: the limit is enforced while it streams
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.write(Buffer.from('ID3'));
      for (let i = 0; i < 20; i++) res.write(Buffer.alloc(64 * 1024));
      return res.end();
    }
    const r = routes.get(req.url);
    if (!r) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': r[0], 'Content-Length': r[1].length });
    res.end(r[1]);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `https://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const opts = () => ({ allowPrivate: true, ca });

test('an https URL is downloaded once and stored locally; it plays from the copy after the source is gone', async () => {
  const sounds = createSounds(path.join(dir, 'data'));
  const before = hits;
  const r = await sounds.importUrl(`${base}/ding.wav`, {}, opts());
  assert.ok(r.sound, JSON.stringify(r));
  assert.equal(hits - before, 1, 'fetched exactly once');
  assert.deepEqual([r.sound.name, r.sound.ext, r.sound.duration, r.sound.url], ['ding', 'wav', 2, `/api/sounds/${r.sound.id}`]);
  const stored = sounds.get(r.sound.id);
  assert.equal(stored.file, path.join(dir, 'data', 'sounds', `${r.sound.id}.wav`));
  routes.delete('/ding.wav');
  assert.deepEqual(fs.readFileSync(stored.file), wav(2), 'the local copy, not a link');
  assert.equal(hits - before, 1, 'nothing fetched at play time');
  assert.deepEqual(sounds.list().sounds.map((s) => s.id), [r.sound.id]);

  const moved = await sounds.importUrl(`${base}/moved`, { name: 'Popper' }, opts());
  assert.deepEqual([moved.sound.name, moved.sound.ext, moved.sound.duration], ['Popper', 'mp3', null], 'a redirect is followed; an mp3 is measured by the browser');
  assert.deepEqual(fs.readFileSync(sounds.get(moved.sound.id).file), mp3);
});

test('an import has the upload limits: size, type, magic bytes and length', async () => {
  const sounds = createSounds(path.join(dir, 'limits'));
  const err = async (url, re, status) => {
    const r = await sounds.importUrl(url, {}, opts());
    assert.match(r.error || '', re, url);
    if (status) assert.equal(r.status, status, url);
  };
  await err(`${base}/page.html`, /Not an audio file/);
  await err(`${base}/fake.mp3`, /Not an mp3/, 415);
  await err(`${base}/long.wav`, /longer than 10 s/, 400);
  await err(`${base}/big.mp3`, /over 1 MB/, 413);
  await err(`${base}/chunked-big`, /over 1 MB/, 413);
  await err(`${base}/loop`, /Too many redirects/);
  await err(`${base}/missing.mp3`, /answered 404/);
  assert.deepEqual(sounds.list().sounds, [], 'nothing stored');
  assert.equal(fs.existsSync(path.join(dir, 'limits', 'sounds')), false);
});

test('only https, and only public addresses unless the caller allows them', async () => {
  await assert.rejects(download(`${base.replace('https', 'http')}/pop.mp3`), /Only https/);
  await assert.rejects(download(`${base}/pop.mp3`, { ca }), /not on the public internet/);
  await assert.rejects(download(`https://localhost:${server.address().port}/pop.mp3`, { ca }), /not on the public internet/);
  for (const ip of ['127.0.0.1', '10.0.0.8', '172.20.1.1', '192.168.1.5', '169.254.169.254', '100.100.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0'])
    assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['1.1.1.1', '140.82.112.3', '2606:4700::1111']) assert.equal(privateAddress(ip), false, ip);
});
