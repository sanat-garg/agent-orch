// files.mjs download (GET /api/files/download): one file as an attachment with its exact bytes; several files, or a
// folder, as a zip streamed on the fly (checked with the system unzip); protected files refused or skipped with a note;
// links kept only inside the selection; caps; a client that disconnects stops the zip.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleFiles, zipStats, DOWNLOAD_NOTE } from '../files.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fdl-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

// A fresh project behind handleFiles on a free port: a.txt, b.bin, dir/{x.txt, sub/y.txt, id.pem, in → x.txt, out → ../a.txt}.
async function serve(t) {
  const root = path.join(tmp, `p${++n}`);
  fs.mkdirSync(path.join(root, 'dir/sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello é');
  fs.writeFileSync(path.join(root, 'b.bin'), crypto.randomBytes(70000));
  fs.writeFileSync(path.join(root, 'dir/x.txt'), 'X');
  fs.writeFileSync(path.join(root, 'dir/sub/y.txt'), 'Y'.repeat(5000));
  fs.writeFileSync(path.join(root, 'dir/id.pem'), 'SECRET');
  fs.symlinkSync('x.txt', path.join(root, 'dir/in'));
  fs.symlinkSync('../a.txt', path.join(root, 'dir/out'));
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    if (!handleFiles(req, res, new URL(req.url, 'http://x'), { rootFor: (cid) => (cid === 'c1' ? root : null), json, readBody: async () => ({}) })) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = (...paths) => `${base}/api/files/download?${new URLSearchParams([['cid', 'c1'], ...paths.map((p) => ['path', p])])}`;
  return { root, base, url, get: (...paths) => fetch(url(...paths)) };
}
// Saves a zip response and unzips it; → {files: {name: content}, list: [names]}.
async function unzipped(r) {
  const dir = fs.mkdtempSync(path.join(tmp, 'z-')), file = path.join(dir, 'a.zip');
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  execFileSync('unzip', ['-t', '-q', file]); // a valid archive, every CRC right
  execFileSync('unzip', ['-q', file, '-d', path.join(dir, 'out')]);
  const out = path.join(dir, 'out'), files = {};
  for (const f of fs.readdirSync(out, { recursive: true }).map(String).sort()) {
    const at = path.join(out, f);
    if (fs.statSync(at).isFile()) files[f] = fs.readFileSync(at, 'utf8');
  }
  return { files, list: Object.keys(files) };
}

test('download: one file streams as an attachment with its type, length and exact bytes', async (t) => {
  const p = await serve(t);
  const r = await p.get('a.txt');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-disposition'), "attachment; filename*=UTF-8''a.txt");
  assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(r.headers.get('content-length'), String(Buffer.byteLength('hello é')));
  assert.equal(await r.text(), 'hello é');
  const abs = path.join(p.root, 'b.bin'), b = await p.get(abs);
  assert.equal(b.headers.get('content-type'), 'application/octet-stream');
  assert.equal(b.headers.get('content-disposition'), "attachment; filename*=UTF-8''b.bin");
  assert.ok(Buffer.from(await b.arrayBuffer()).equals(fs.readFileSync(abs)), 'absolute path, binary bytes intact');
  fs.writeFileSync(path.join(p.root, "it's (1).txt"), 'q');
  assert.equal((await p.get("it's (1).txt")).headers.get('content-disposition'), "attachment; filename*=UTF-8''it%27s%20%281%29.txt");
});

test('download: two files make a valid zip named agent-orch-files.zip, entries relative to their common parent', async (t) => {
  const p = await serve(t);
  const r = await p.get('a.txt', 'dir/sub/y.txt');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.equal(r.headers.get('content-disposition'), "attachment; filename*=UTF-8''agent-orch-files.zip");
  const z = await unzipped(r);
  assert.deepEqual(z.files, { 'a.txt': 'hello é', 'dir/sub/y.txt': 'Y'.repeat(5000) });
  const bin = await unzipped(await p.get('b.bin', 'a.txt'));
  assert.deepEqual(bin.list, ['a.txt', 'b.bin']);
});

test('download: a folder zips recursively as <folder>.zip; secrets and links out of it are skipped with a note', async (t) => {
  const p = await serve(t);
  const r = await p.get('dir');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-disposition'), "attachment; filename*=UTF-8''dir.zip");
  assert.equal(r.headers.get('x-skipped'), '2');
  const z = await unzipped(r);
  assert.deepEqual(z.list, [DOWNLOAD_NOTE, 'dir/in', 'dir/sub/y.txt', 'dir/x.txt']);
  assert.equal(z.files['dir/in'], 'X', 'a link inside the selection is stored as its target');
  assert.match(z.files[DOWNLOAD_NOTE], /dir\/id\.pem \(protected\)/);
  assert.match(z.files[DOWNLOAD_NOTE], /dir\/out \(link to outside the selection\)/);
  const both = await unzipped(await p.get('dir', 'a.txt'));
  assert.equal(both.files['dir/out'], 'hello é', 'the link now points inside the selection');
  const clean = await p.get(path.join(p.root, 'dir/sub'));
  assert.equal(clean.headers.get('x-skipped'), '0');
  assert.deepEqual((await unzipped(clean)).list, ['sub/y.txt']);
});

test('download: protected files are 403; errors are JSON 400/403/404', async (t) => {
  const p = await serve(t);
  const err = async (r) => [r.status, await r.json()];
  assert.deepEqual(await err(await p.get('dir/id.pem')), [403, { error: 'dir/id.pem is protected' }]);
  assert.deepEqual(await err(await p.get('a.txt', 'dir/id.pem')), [403, { error: 'dir/id.pem is protected' }]);
  assert.deepEqual(await err(await p.get('nope.txt')), [404, { error: 'Not found: nope.txt' }]);
  assert.deepEqual(await err(await p.get('../x')), [400, { error: 'Invalid path' }]);
  assert.equal((await p.get()).status, 400);
  assert.equal((await fetch(p.url('a.txt').replace('cid=c1', 'cid=zz'))).status, 404);
  assert.equal((await fetch(p.url('a.txt'), { method: 'POST' })).status, 404, 'GET only');
});

test('download check=1: ok with the name and kind, nothing streamed; errors are the same JSON with no attachment header', async (t) => {
  const p = await serve(t);
  const check = async (...paths) => { const r = await fetch(`${p.url(...paths)}&check=1`); return [r.status, r.headers.get('content-disposition'), await r.json()]; };
  assert.deepEqual(await check('a.txt', 'dir/sub/y.txt'), [200, null, { ok: true, name: 'agent-orch-files.zip', kind: 'zip' }]);
  assert.deepEqual(await check('dir'), [200, null, { ok: true, name: 'dir.zip', kind: 'zip' }]);
  assert.deepEqual(await check('a.txt'), [200, null, { ok: true, name: 'a.txt', kind: 'file', size: Buffer.byteLength('hello é') }]);
  assert.deepEqual(await check('a.txt', 'dir/id.pem'), [403, null, { error: 'dir/id.pem is protected' }]);
  assert.deepEqual(await check('nope.txt'), [404, null, { error: 'Not found: nope.txt' }]);
  for (const bad of [['dir/id.pem'], ['nope.txt'], ['../x'], []]) {
    const r = await p.get(...bad);
    assert.ok(r.status >= 400, bad.join());
    assert.equal(r.headers.get('content-disposition'), null, `no attachment on the ${r.status} error`);
    assert.match(r.headers.get('content-type'), /json/);
  }
});

test('download: over 50k entries is 413 before anything is sent', async (t) => {
  const p = await serve(t);
  const many = path.join(p.root, 'many');
  fs.mkdirSync(many);
  for (let i = 0; i <= 50000; i++) fs.writeFileSync(path.join(many, `f${i}`), '');
  const r = await p.get('many');
  assert.equal(r.status, 413);
  assert.match((await r.json()).error, /50000/);
  const c = await fetch(`${p.url('many')}&check=1`);
  assert.equal(c.status, 413, 'the preflight enforces the caps too');
  assert.match((await c.json()).error, /50000/);
});

test('download: a client that disconnects stops the zip', async (t) => {
  const p = await serve(t);
  const big = path.join(p.root, 'big');
  fs.mkdirSync(big);
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(big, `r${i}.bin`), crypto.randomBytes(4 * 1024 * 1024));
  const before = { ...zipStats };
  await new Promise((resolve, reject) => {
    const req = http.get(p.url('big'), (res) => {
      assert.equal(res.statusCode, 200);
      res.once('data', () => { req.destroy(); resolve(); });
    });
    req.on('error', () => {});
    setTimeout(() => reject(new Error('no data')), 10000);
  });
  for (let i = 0; i < 100 && zipStats.active > before.active; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(zipStats.active, before.active, 'the zip stopped');
  assert.equal(zipStats.aborted, before.aborted + 1);
  assert.equal(zipStats.done, before.done, 'it never ran to the end');
});

test('server.mjs routes the download behind the sign-in check', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs'), 'utf8');
  const auth = src.indexOf('if (!isAuthed(req)) {'), route = src.indexOf('handleFiles(req, res, url,');
  assert.ok(auth > 0 && route > auth);
});
