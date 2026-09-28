// files.mjs copy/move/zip/unzip (the Files tab's context menu): collisions, a folder into itself, zip round trips,
// zip-slip, path escapes and the read-only data/ and .git/.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { copyPaths, handleFiles, listDir, movePaths, unzipPath, zipPaths } from '../files.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fops-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
// A fresh project: a.txt, src/{app.js,lib/util.js,empty/}, data/secret.json, .git/HEAD, links in and out; plus ../secret.
function project() {
  const base = path.join(tmp, `p${++n}`), root = path.join(base, 'proj'), outside = path.join(base, 'secret');
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); };
  w('a.txt', 'A'); w('src/app.js', 'app'); w('src/lib/util.js', 'util'); w('data/secret.json', '{}'); w('.git/HEAD', 'ref');
  fs.mkdirSync(path.join(root, 'src/empty')); fs.mkdirSync(path.join(root, 'out'));
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'key.txt'), 'top secret');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  fs.symlinkSync('app.js', path.join(root, 'src/app-link.js'));
  return { root, outside, read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'), has: (rel) => fs.existsSync(path.join(root, rel)) };
}
const rejects = (p, status, re) => assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (re) assert.match(e.message, re); return true; });

// A hand-made zip (stored entries) so tests can put in what no honest zipper would. size: a lied-about size.
function makeZip(file, entries) {
  const locals = [], central = [];
  let pos = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), data = Buffer.from(e.data ?? '');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6);
    h.writeUInt32LE(zlib.crc32(data), 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(e.size ?? data.length, 22); h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 20, 4); h.copy(c, 6, 4, 30);
    c.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38); c.writeUInt32LE(pos, 42);
    locals.push(h, name, data); central.push(c, name);
    pos += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.count ?? entries.length, 8); end.writeUInt16LE(entries.count ?? entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(pos, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, end]));
}

test('copy: into another folder, and a name clash becomes "name copy", "name copy 2"; folders come whole', async () => {
  const p = project();
  assert.deepEqual(await copyPaths(p.root, ['a.txt'], ''), { created: ['a copy.txt'] });
  assert.deepEqual(await copyPaths(p.root, ['a.txt'], ''), { created: ['a copy 2.txt'] });
  assert.equal(p.read('a copy 2.txt'), 'A');
  assert.deepEqual(await copyPaths(p.root, ['src', 'a.txt', 'src/app.js'], 'out'), { created: ['out/src', 'out/a.txt'] }, 'src/app.js comes with src');
  assert.equal(p.read('out/src/lib/util.js'), 'util');
  assert.ok(fs.statSync(path.join(p.root, 'out/src/empty')).isDirectory());
  assert.equal(fs.readlinkSync(path.join(p.root, 'out/src/app-link.js')), 'app.js', 'links are copied as they are');
  assert.deepEqual(await copyPaths(p.root, ['src'], 'out'), { created: ['out/src copy'] });
  assert.deepEqual(await copyPaths(p.root, ['data/secret.json'], 'out'), { created: ['out/secret.json'] }, 'data/ can be read');
  assert.ok(p.has('a.txt') && p.has('src/app.js'));
});

test('copy/move: a folder into itself or its own subfolder is refused', async () => {
  const p = project();
  await rejects(copyPaths(p.root, ['src'], 'src'), 400, /into itself/);
  await rejects(copyPaths(p.root, ['src'], 'src/lib'), 400, /into itself/);
  await rejects(movePaths(p.root, ['src'], 'src/lib'), 400, /into itself/);
  await rejects(movePaths(p.root, ['a.txt', 'src'], 'src'), 400, /into itself/);
  assert.ok(p.has('a.txt') && p.has('src/lib/util.js'), 'nothing moved when any item is refused');
  await rejects(movePaths(p.root, [''], 'out'), 400, /not the project itself/);
});

test('move: renames into the destination with the same clash rule; an item already there stays put', async () => {
  const p = project();
  fs.writeFileSync(path.join(p.root, 'out/a.txt'), 'old');
  assert.deepEqual(await movePaths(p.root, ['a.txt'], 'out'), { moved: [{ from: 'a.txt', to: 'out/a copy.txt' }] });
  assert.equal(p.read('out/a copy.txt'), 'A');
  assert.equal(p.read('out/a.txt'), 'old');
  assert.ok(!p.has('a.txt'));
  assert.deepEqual(await movePaths(p.root, ['src/lib', 'out/a.txt'], 'out'),
    { moved: [{ from: 'src/lib', to: 'out/lib' }, { from: 'out/a.txt', to: 'out/a.txt' }] });
  assert.equal(p.read('out/lib/util.js'), 'util');
  fs.mkdirSync(path.join(p.root, 'lib'));
  assert.deepEqual(await movePaths(p.root, ['out/lib'], ''), { moved: [{ from: 'out/lib', to: 'lib copy' }] }, 'folders keep dots in their names');
  assert.deepEqual(await movePaths(p.root, ['src/app-link.js'], ''), { moved: [{ from: 'src/app-link.js', to: 'app-link.js' }] });
  assert.ok(fs.lstatSync(path.join(p.root, 'app-link.js')).isSymbolicLink(), 'a link moves as a link');
  await rejects(movePaths(p.root, ['nope.txt'], 'out'), 404);
});

test('zip then unzip gives back the same files, and the names default sensibly', async () => {
  const p = project();
  const bin = Buffer.from(Array.from({ length: 70000 }, (_, i) => (i * 7) & 255));
  fs.writeFileSync(path.join(p.root, 'src/lib/blob.bin'), bin);
  fs.writeFileSync(path.join(p.root, 'src/run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(p.root, 'src/ünï cödé.txt'), 'utf8 name');
  assert.deepEqual(await zipPaths(p.root, ['src']), { zip: 'src.zip' });
  assert.deepEqual(await zipPaths(p.root, ['src/app.js', 'src/lib']), { zip: 'src/Archive.zip' }, 'several: Archive.zip in their common folder');
  assert.deepEqual(await zipPaths(p.root, ['src/app.js', 'src/lib/util.js']), { zip: 'src/Archive 2.zip' }, 'common parent of different depths');
  assert.deepEqual(await zipPaths(p.root, ['a.txt'], { dest: 'out', name: 'mine' }), { zip: 'out/mine.zip' });
  await rejects(zipPaths(p.root, ['src/lib/util.js', 'out/../src/lib/util.js']), 400);
  fs.mkdirSync(path.join(p.root, 'other')); fs.writeFileSync(path.join(p.root, 'other/app.js'), 'x');
  await rejects(zipPaths(p.root, ['src/app.js', 'other/app.js']), 409, /both named app.js/);
  assert.ok(!fs.readdirSync(path.join(p.root, 'src')).some((f) => f.endsWith('.partial')), 'no partial zip left behind');

  assert.deepEqual(await unzipPath(p.root, 'src.zip', { dest: 'out' }), { extracted: 'out/src', skipped: 0 });
  assert.ok(!fs.existsSync(path.join(p.root, 'out/src/src/app-link.js')), 'the zip left the link out');
  const same = (a, b) => assert.deepEqual(fs.readFileSync(path.join(p.root, a)), fs.readFileSync(path.join(p.root, b)), a);
  for (const f of ['app.js', 'lib/util.js', 'lib/blob.bin', 'run.sh', 'ünï cödé.txt']) same(`src/${f}`, `out/src/src/${f}`);
  assert.ok(fs.statSync(path.join(p.root, 'out/src/src/empty')).isDirectory(), 'empty folders survive');
  assert.ok(fs.statSync(path.join(p.root, 'out/src/src/run.sh')).mode & 0o100, 'the executable bit survives');
  assert.deepEqual(await unzipPath(p.root, 'src.zip'), { extracted: 'src 2', skipped: 0 }, 'next to the zip; a clash gets a number');
  same('src/lib/blob.bin', 'src 2/src/lib/blob.bin');
  assert.deepEqual(await unzipPath(p.root, 'src/Archive.zip', { dest: '' }), { extracted: 'Archive', skipped: 0 });
  assert.deepEqual(fs.readdirSync(path.join(p.root, 'Archive')).sort(), ['app.js', 'lib']);
  await rejects(unzipPath(p.root, 'a.txt'), 400, /Not a zip/);
  await rejects(unzipPath(p.root, 'src'), 400, /Not a zip/);
  assert.ok(!fs.readdirSync(p.root).some((f) => f.endsWith('.unzip')), 'no staging folder left behind');
});

test('zips interoperate with the system zip/unzip when they are installed', async (t) => {
  const has = (bin) => { try { execFileSync(bin, ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } };
  if (!has('unzip') || !has('zip')) return t.skip('no system zip/unzip');
  const p = project();
  await zipPaths(p.root, ['src']);
  assert.match(execFileSync('unzip', ['-t', path.join(p.root, 'src.zip')], { encoding: 'utf8' }), /No errors detected/);
  execFileSync('zip', ['-qr', path.join(p.root, 'sys.zip'), 'src', '-x', 'src/app-link.js'], { cwd: p.root });
  assert.deepEqual(await unzipPath(p.root, 'sys.zip'), { extracted: 'sys', skipped: 0 });
  assert.equal(p.read('sys/src/lib/util.js'), 'util');
});

test('unzip: zip-slip, symlink entries, lies about sizes and zip bombs are refused before anything lands', async () => {
  const p = project(), zip = (name, entries) => { makeZip(path.join(p.root, name), entries); return name; };
  for (const bad of ['../evil.txt', 'ok/../../evil.txt', '/abs/evil.txt', 'C:/evil.txt', '..\\evil.txt', 'a\\..\\..\\evil.txt']) {
    await rejects(unzipPath(p.root, zip('slip.zip', [{ name: 'fine.txt', data: 'ok' }, { name: bad, data: 'pwned' }])), 400, /Unsafe path/);
  }
  assert.ok(!fs.existsSync(path.join(p.root, '..', 'evil.txt')) && !fs.existsSync(path.join(p.root, 'evil.txt')) && !fs.existsSync('/abs/evil.txt'));
  assert.ok(!p.has('slip'), 'nothing extracted from a refused zip');
  assert.ok(!fs.readdirSync(p.root).some((f) => f.endsWith('.unzip')));

  const r = await unzipPath(p.root, zip('links.zip', [
    { name: 'link', data: '/etc', mode: 0o120777 }, { name: 'link/passwd', data: 'x' }, { name: '.git/config', data: '[core]' }, { name: 'keep.txt', data: 'k' }]));
  assert.deepEqual(r, { extracted: 'links', skipped: 2 });
  assert.deepEqual(fs.readdirSync(path.join(p.root, 'links')).sort(), ['keep.txt', 'link']);
  assert.ok(!fs.lstatSync(path.join(p.root, 'links/link')).isSymbolicLink(), 'a symlink entry never becomes a link');

  await rejects(unzipPath(p.root, zip('lie.zip', [{ name: 'x.txt', data: 'much more than two bytes', size: 2 }])), 400, /larger than the zip says/);
  await rejects(unzipPath(p.root, zip('bomb.zip', [{ name: 'a', data: 'a', size: 300 * 1024 ** 2 }, { name: 'b', data: 'b', size: 300 * 1024 ** 2 }])), 413, /500 MB/);
  await rejects(unzipPath(p.root, zip('many.zip', Object.assign([{ name: 'a', data: 'a' }], { count: 20001 }))), 413, /20000/);
  await rejects(unzipPath(p.root, zip('dup.zip', [{ name: 'd', data: 'a' }, { name: 'd/x', data: 'b' }])), 400, /clash/);
  fs.writeFileSync(path.join(p.root, 'junk.zip'), 'not a zip at all');
  await rejects(unzipPath(p.root, 'junk.zip'), 400, /Not a zip/);
  assert.ok(!fs.readdirSync(p.root).some((f) => f.endsWith('.unzip')));
});

test('paths that leave the project are refused for every op', async () => {
  const p = project();
  for (const bad of ['../secret/key.txt', 'escape/key.txt', 'src/../../secret/key.txt']) {
    await assert.rejects(copyPaths(p.root, [bad], 'out'), (e) => [400, 403].includes(e.status), bad);
    await assert.rejects(movePaths(p.root, [bad], 'out'), (e) => [400, 403].includes(e.status), bad);
    await assert.rejects(zipPaths(p.root, [bad], { dest: 'out' }), (e) => [400, 403].includes(e.status), bad);
    await assert.rejects(unzipPath(p.root, bad, { dest: 'out' }), (e) => [400, 403].includes(e.status), bad);
  }
  // An absolute destination is the whole-disk scope (files-scope.test.mjs): /etc is a read-only location.
  for (const bad of ['..', '../secret', 'escape', '/etc']) {
    await assert.rejects(copyPaths(p.root, ['a.txt'], bad), (e) => [400, 403, 404].includes(e.status), bad);
    await assert.rejects(movePaths(p.root, ['a.txt'], bad), (e) => [400, 403, 404].includes(e.status), bad);
    await assert.rejects(zipPaths(p.root, ['a.txt'], { dest: bad }), (e) => [400, 403, 404].includes(e.status), bad);
  }
  for (const name of ['../x', 'a/b', '..']) await rejects(zipPaths(p.root, ['a.txt'], { name }), 400, /Invalid name/);
  assert.deepEqual(fs.readdirSync(p.outside), ['key.txt']);
  // A link to the outside inside a copied folder stays a link (nothing from outside is copied in); zip leaves it out.
  fs.symlinkSync(p.outside, path.join(p.root, 'src/out-link'));
  await copyPaths(p.root, ['src'], 'out');
  assert.ok(fs.lstatSync(path.join(p.root, 'out/src/out-link')).isSymbolicLink());
  await zipPaths(p.root, ['src']);
  await unzipPath(p.root, 'src.zip', { dest: 'out' });
  assert.ok(!fs.existsSync(path.join(p.root, 'out/src 2/src/out-link')));
});

test('data/ and .git/ are read-only: never moved, never a destination, and nothing new lands there', async () => {
  const p = project();
  await rejects(movePaths(p.root, ['data/secret.json'], 'out'), 403, /read-only/);
  await rejects(movePaths(p.root, ['data'], 'out'), 403, /read-only/);
  await rejects(movePaths(p.root, ['.git/HEAD'], 'out'), 403, /read-only/);
  await rejects(copyPaths(p.root, ['a.txt'], 'data'), 403, /read-only/);
  await rejects(movePaths(p.root, ['a.txt'], 'data'), 403, /read-only/);
  await rejects(copyPaths(p.root, ['a.txt'], '.git'), 403, /read-only/);
  await rejects(zipPaths(p.root, ['data/secret.json']), 403, /read-only/); // the default dest: data/ itself
  await rejects(zipPaths(p.root, ['a.txt'], { dest: 'data' }), 403, /read-only/);
  assert.deepEqual(await zipPaths(p.root, ['data/secret.json'], { dest: 'out' }), { zip: 'out/secret.json.zip' });
  await rejects(unzipPath(p.root, 'out/secret.json.zip', { dest: 'data' }), 403, /read-only/);
  // Nothing new named data (or .git) at the top: an empty project's data/ is protected before it exists.
  fs.rmSync(path.join(p.root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(p.root, 'out/data'));
  await rejects(movePaths(p.root, ['out/data'], ''), 403, /read-only/);
  makeZip(path.join(p.root, 'out/data.zip'), [{ name: 'x', data: 'x' }]);
  await rejects(unzipPath(p.root, 'out/data.zip', { dest: '' }), 403, /read-only/);
  assert.ok(!p.has('data'));
  assert.deepEqual(fs.readdirSync(path.join(p.root, '.git')), ['HEAD']);
});

test('HTTP: POST /api/files/{copy,move,zip,unzip} answer JSON with a clear status; list?dir= has type and isSymlink', async (t) => {
  const p = project();
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => {
    let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { reject(Object.assign(new Error('Bad JSON body'), { status: 400 })); } });
  });
  const server = http.createServer((req, res) => {
    if (!handleFiles(req, res, new URL(req.url, 'http://x'), { rootFor: (cid) => (cid === 'c1' ? p.root : null), json, readBody })) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (op, body) => { const r = await fetch(`${base}/api/files/${op}`, { method: 'POST', body: JSON.stringify({ cid: 'c1', ...body }) }); return [r.status, await r.json()]; };

  assert.deepEqual(await post('copy', { paths: ['a.txt'], dest: '' }), [200, { created: ['a copy.txt'] }]);
  assert.deepEqual(await post('move', { paths: ['a copy.txt'], dest: 'out' }), [200, { moved: [{ from: 'a copy.txt', to: 'out/a copy.txt' }] }]);
  assert.deepEqual(await post('zip', { paths: ['out'] }), [200, { zip: 'out.zip' }]);
  assert.deepEqual(await post('unzip', { path: 'out.zip', dest: 'src' }), [200, { extracted: 'src/out', skipped: 0 }]);
  assert.equal(p.read('src/out/out/a copy.txt'), 'A');
  assert.deepEqual(await post('move', { paths: ['src'], dest: 'src/lib' }), [400, { error: "Can't move src into itself" }]);
  assert.deepEqual(await post('move', { paths: ['data'], dest: 'out' }), [403, { error: 'data is read-only' }]);
  assert.equal((await post('copy', { paths: ['../secret/key.txt'], dest: 'out' }))[0], 400);
  assert.equal((await post('copy', { paths: ['a.txt'] }))[0], 400, 'copy needs a destination');
  assert.equal((await post('copy', { cid: 'other', paths: ['a.txt'], dest: '' }))[0], 404);
  assert.equal((await fetch(`${base}/api/files/copy?cid=c1`)).status, 404, 'the ops are POST only');
  fs.chmodSync(path.join(p.root, 'out'), 0o555);
  t.after(() => fs.chmodSync(path.join(p.root, 'out'), 0o755));
  if (process.getuid?.() !== 0) assert.deepEqual(await post('copy', { paths: ['a.txt'], dest: 'out' }), [403, { error: 'Permission denied' }]);

  const list = await (await fetch(`${base}/api/files/list?cid=c1&dir=src`)).json();
  const e = Object.fromEntries(list.entries.map((x) => [x.name, x]));
  assert.deepEqual([e.lib.type, e.lib.isSymlink, e['app.js'].type, e['app-link.js'].isSymlink, e['app-link.js'].size], ['dir', false, 'file', true, 3]);
  assert.equal(typeof e['app.js'].mtime, 'number');
  assert.deepEqual(listDir(p.root, 'src').entries.length, list.entries.length);
});

test('server.mjs routes the file ops only after the sign-in check, with the JSON body reader', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs'), 'utf8');
  const auth = src.indexOf('if (!isAuthed(req)) {'), route = src.indexOf('handleFiles(req, res, url,');
  assert.ok(auth > 0 && route > auth, 'handleFiles is behind the login');
  assert.match(src.slice(route, route + 200), /readBody/);
});
