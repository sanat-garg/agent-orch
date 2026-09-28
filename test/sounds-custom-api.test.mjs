// Custom finish sounds over HTTP (#432): uploads within the limits are stored and listed, over the size or length limit or
// not audio they are refused, GET serves them (login-protected, cached for good), PATCH/PUT default/DELETE work, the URL
// import refuses non-https and private addresses; and a node row accepts a custom sound (cluster.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedPath } from './helpers/isolated-path.mjs';
import { createCluster, LOCAL_NODE } from '../cluster.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'sounds-custom-password';
let child, base, dataDir, home, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
// 8 kHz 8-bit mono PCM: 8000 bytes a second.
function wav(seconds, rate = 8000) {
  const data = Math.round(seconds * rate), b = Buffer.alloc(44 + data, 0x80);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + data, 4); b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36, 'latin1'); b.writeUInt32LE(data, 40);
  return b;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sounds-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sounds-home-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH: isolatedPath(bin), PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const ok = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = ok.headers.get('set-cookie').split(';')[0];
  await ok.arrayBuffer();
});

after(() => {
  child?.kill('SIGKILL');
  for (const d of [dataDir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const call = async (p, method = 'GET', body) => {
  const r = await fetch(base + p, { method, headers: { cookie, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: JSON.parse(await r.text()) };
};
const upload = async (buf, { type = 'audio/wav', name = 'ding.wav', duration } = {}) => {
  const r = await fetch(base + '/api/sounds', { method: 'POST', body: buf,
    headers: { cookie, 'content-type': type, 'x-file-name': encodeURIComponent(name), ...(duration != null && { 'x-sound-duration': String(duration) }) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

test('uploads: accepted within 1 MB and 10 s, refused over the limits or when not audio', async () => {
  assert.deepEqual((await call('/api/sounds')).body, { sounds: [], default: null });
  const ding = wav(1.5);
  let r = await upload(ding, { name: 'Ding ding.wav' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body.sound;
  assert.match(s.id, /^[a-f0-9]{24}$/);
  assert.deepEqual({ ...s, at: 0 }, { id: s.id, key: `custom:${s.id}`, name: 'Ding ding', ext: 'wav', type: 'audio/wav', size: ding.length,
    duration: 1.5, volume: 100, at: 0, url: `/api/sounds/${s.id}` }, 'a wav is measured from its header');
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'sounds', `${s.id}.wav`)), ding, 'stored under <DATA>/sounds/<sha>.<ext>');
  assert.equal((await upload(ding)).body.sound.id, s.id, 'the same bytes again: the same sound');

  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4000, 1)]);
  r = await upload(mp3, { type: 'audio/mpeg', name: 'pop.mp3', duration: 2.25 });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.sound.ext, r.body.sound.duration, r.body.sound.type], ['mp3', 2.25, 'audio/mpeg']);
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(300, 2)]), m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(300, 3)]);
  assert.equal((await upload(ogg, { type: 'audio/ogg', duration: 1 })).body.sound.ext, 'ogg');
  assert.equal((await upload(m4a, { type: 'audio/x-m4a', duration: 1 })).body.sound.ext, 'm4a');

  assert.equal((await upload(Buffer.alloc(1024 * 1024 + 10, 0xff), { type: 'audio/mpeg' })).status, 413, 'over 1 MB');
  assert.equal((await upload(wav(10.5))).status, 400, 'a wav over 10 s');
  assert.equal((await upload(mp3, { type: 'audio/mpeg', duration: 12 })).status, 400, 'measured over 10 s by the browser');
  assert.equal((await upload(Buffer.from('<html><body>not audio at all</body></html>'), { type: 'audio/mpeg' })).status, 415, 'magic bytes');
  assert.equal((await upload(Buffer.from('not audio at all, just words'), { type: 'text/plain' })).status, 415, 'type');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
  assert.equal((await upload(png, { type: 'image/png' })).status, 415);
  assert.equal((await upload(mp3, { type: 'image/png' })).status, 415, 'audio bytes claimed as an image');
  assert.equal((await call('/api/sounds')).body.sounds.length, 4);
});

test('GET serves the stored file (login only, cached for good); PATCH, default and DELETE', async () => {
  const [s, other] = (await call('/api/sounds')).body.sounds;
  let res = await fetch(base + s.url, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.match(res.headers.get('cache-control'), /max-age=31536000/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(path.join(dataDir, 'sounds', `${s.id}.wav`)));
  res = await fetch(base + s.url);
  assert.equal(res.status, 401, 'login-protected'); await res.arrayBuffer();
  assert.equal((await call('/api/sounds/0123456789abcdef01234567')).status, 404);

  assert.equal((await call(`/api/sounds/${s.id}`, 'PATCH', { name: 'Doorbell', volume: 40 })).body.sound.name, 'Doorbell');
  for (const bad of [{ volume: 101 }, { volume: -1 }, { volume: 0.5 }, { name: '  ' }]) assert.equal((await call(`/api/sounds/${s.id}`, 'PATCH', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await call(`/api/sounds/${other.id}`, 'PATCH', { duration: 11 })).status, 400);
  assert.equal((await call(`/api/sounds/${other.id}`, 'PATCH', { duration: 3.5 })).body.sound.duration, 3.5);
  let list = (await call('/api/sounds')).body;
  assert.deepEqual([list.sounds[0].name, list.sounds[0].volume], ['Doorbell', 40]);

  assert.equal((await call('/api/sounds/default', 'PUT', { id: 'ffffffffffffffffffffffff' })).status, 404);
  assert.deepEqual((await call('/api/sounds/default', 'PUT', { id: s.id })).body, { ok: true, default: s.id });
  assert.equal((await call('/api/sounds')).body.default, s.id);

  const del = await call(`/api/sounds/${s.id}`, 'DELETE');
  assert.deepEqual(del.body, { ok: true, key: `custom:${s.id}`, default: null }, 'deleting the sound for all machines clears it');
  list = (await call('/api/sounds')).body;
  assert.equal(list.default, null);
  assert.ok(!list.sounds.some((x) => x.id === s.id));
  assert.equal(fs.existsSync(path.join(dataDir, 'sounds', `${s.id}.wav`)), false);
  res = await fetch(base + s.url, { headers: { cookie } });
  assert.equal(res.status, 404); await res.arrayBuffer();
  assert.equal((await call(`/api/sounds/${s.id}`, 'DELETE')).status, 404);
});

test('URL import: https to a public address only', async () => {
  for (const url of ['http://example.com/a.mp3', 'https://127.0.0.1/a.mp3', 'https://localhost/a.mp3', 'https://[::1]/a.mp3', 'https://10.1.2.3/a.mp3', 'https://169.254.169.254/latest', 'nope']) {
    const r = await call('/api/sounds/import', 'POST', { url });
    assert.equal(r.status, 400, url);
    assert.match(r.body.error, /https|public|valid/, url);
  }
  assert.equal((await call('/api/sounds/import', 'POST', {})).status, 400);
});

test('a node row takes a custom sound as its pick', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sounds-node-'));
  try {
    const hub = createCluster({ dbFile: path.join(dir, 'orch.db') });
    assert.equal(hub.update(LOCAL_NODE, { sound: 'custom:0123456789abcdef01234567' }).node.sound, 'custom:0123456789abcdef01234567');
    assert.equal(hub.update(LOCAL_NODE, { sound: 'custom:../../etc' }).status, 400);
    assert.equal(hub.update(LOCAL_NODE, { sound: null }).node.sound, null);
    hub.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
