// files.mjs (the Files view): listing and serving stay inside the chat's project, whatever the path or symlink says.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { findFiles, FIND_VISIT_MAX, handleFiles, listDir, resolveInside, TEXT_MAX } from '../files.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-files-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const root = path.join(tmp, 'proj'), outside = path.join(tmp, 'secret');
fs.mkdirSync(path.join(root, 'src/deep'), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'key.txt'), 'top secret');
fs.writeFileSync(path.join(root, 'README.md'), '# Hi\n');
fs.writeFileSync(path.join(root, '.env'), 'X=1');
fs.writeFileSync(path.join(root, 'src/app.js'), 'console.log(1)\n');
fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
fs.writeFileSync(path.join(root, 'big.txt'), 'a'.repeat(TEXT_MAX + 10));
fs.symlinkSync(outside, path.join(root, 'escape'));
fs.symlinkSync(path.join(outside, 'key.txt'), path.join(root, 'key-link.txt'));
fs.symlinkSync(path.join(root, 'src'), path.join(root, 'src-link'));

test('resolveInside: .. is refused, links out of the project are 403, missing paths 404', () => {
  assert.equal(resolveInside(root, '').rel, '');
  assert.equal(resolveInside(root, 'src//deep/').rel, 'src/deep');
  assert.throws(() => resolveInside(root, '../secret'), (e) => e.status === 400);
  assert.throws(() => resolveInside(root, 'src/../../secret'), (e) => e.status === 400);
  assert.throws(() => resolveInside(root, 'escape/key.txt'), (e) => e.status === 403);
  assert.throws(() => resolveInside(root, 'key-link.txt'), (e) => e.status === 403);
  assert.throws(() => resolveInside(root, 'nope'), (e) => e.status === 404);
  // An absolute path is still read inside the project (<project>/etc/passwd, which doesn't exist), never /etc/passwd.
  assert.throws(() => resolveInside(root, '/etc/passwd'), (e) => e.status === 404);
});

test('listDir: files and folders with sizes and dates; links out of the project are left out', () => {
  const d = listDir(root, '');
  const names = d.entries.map((e) => e.name).sort();
  assert.deepEqual(names, ['.env', 'README.md', 'big.txt', 'blob.bin', 'logo.png', 'src', 'src-link']);
  const src = d.entries.find((e) => e.name === 'src');
  assert.deepEqual([src.dir, src.size, src.hidden], [true, null, false]);
  assert.equal(d.entries.find((e) => e.name === '.env').hidden, true);
  assert.equal(d.entries.find((e) => e.name === 'README.md').size, 5);
  assert.deepEqual(listDir(root, 'src/deep').crumbs.map((c) => c.path), ['', 'src', 'src/deep']);
  assert.equal(listDir(root, 'src/deep').crumbs[0].name, 'proj');
  assert.throws(() => listDir(root, 'README.md'), (e) => e.status === 400);
});

test('GET /api/files/*: images as themselves, text capped, binary refused, sandboxed, 304 when unchanged, only for a known chat', async (t) => {
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    if (!handleFiles(req, res, new URL(req.url, 'http://x'), { rootFor: (cid) => (cid === 'c1' ? root : null), json })) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (kind, p, cid = 'c1', headers = {}) => fetch(`${base}/api/files/${kind}?cid=${cid}&path=${encodeURIComponent(p)}`, { headers });

  const list = await get('list', 'src');
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).entries.map((e) => e.name).sort(), ['app.js', 'deep']);
  assert.equal((await get('list', '', 'other')).status, 404);
  for (const bad of ['../secret', 'escape', 'key-link.txt', 'src/../../secret/key.txt']) {
    const r = await get('raw', bad);
    assert.ok([400, 403].includes(r.status), `${bad}: ${r.status}`);
    assert.doesNotMatch(await r.text(), /top secret/);
  }

  const png = await get('raw', 'logo.png');
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.match(png.headers.get('content-security-policy'), /^sandbox;/);
  await png.arrayBuffer();
  const js = await get('raw', 'src-link/app.js');
  assert.equal(js.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await js.text(), 'console.log(1)\n');
  const html = path.join(root, 'page.html');
  fs.writeFileSync(html, '<script>alert(1)</script>');
  const page = await get('raw', 'page.html');
  assert.equal(page.headers.get('content-type'), 'text/plain; charset=utf-8', 'never served as a page');
  await page.text();
  const big = await get('raw', 'big.txt');
  assert.equal(big.headers.get('x-truncated'), '1');
  assert.equal((await big.text()).length, TEXT_MAX);
  const bin = await get('raw', 'blob.bin');
  assert.equal(bin.status, 415);
  await bin.arrayBuffer();
  const readme = await get('raw', 'README.md');
  await readme.text();
  const again = await get('raw', 'README.md', 'c1', { 'If-Modified-Since': readme.headers.get('last-modified') });
  assert.equal(again.status, 304);
  assert.equal((await get('raw', 'src')).status, 400);
});

test('findFiles: matches at any depth, skips node_modules/.git/hidden folders, ignores links out, stops at the cap', () => {
  const froot = path.join(tmp, 'findproj');
  fs.mkdirSync(path.join(froot, 'a/b/c'), { recursive: true });
  for (const d of ['node_modules/pkg', '.git/objects', '.cache', '.agent-orch-worktrees/x']) fs.mkdirSync(path.join(froot, d), { recursive: true });
  for (const f of ['Widget.js', 'a/widget.test.js', 'a/b/c/deep-WIDGET.md', 'node_modules/pkg/widget.js', '.git/objects/widget', '.cache/widget.txt',
    '.agent-orch-worktrees/x/widget.js', 'a/other.txt']) fs.writeFileSync(path.join(froot, f), 'x');
  fs.mkdirSync(path.join(froot, 'widgets'));
  fs.writeFileSync(path.join(outside, 'widget-secret.js'), 'top secret');
  fs.symlinkSync(outside, path.join(froot, 'out-dir'));
  fs.symlinkSync(path.join(outside, 'widget-secret.js'), path.join(froot, 'widget-out.js'));
  fs.symlinkSync(path.join(froot, 'a'), path.join(froot, 'a-link')); // inside, but never descended (no duplicates, no loops)

  const r = findFiles(froot, 'WIDGET');
  assert.equal(r.q, 'WIDGET');
  assert.equal(r.truncated, false);
  assert.deepEqual(r.entries.map((e) => e.path), ['Widget.js', 'widgets', 'a/widget.test.js', 'a/b/c/deep-WIDGET.md']);
  const deep = r.entries.at(-1);
  assert.deepEqual([deep.name, deep.dir, deep.size, typeof deep.mtime], ['deep-WIDGET.md', false, 1, 'number']);
  assert.equal(r.entries.find((e) => e.name === 'widgets').dir, true);
  // A query starting with '.' looks inside hidden folders (still never .git or node_modules).
  assert.deepEqual(findFiles(froot, '.cache').entries.map((e) => e.path), ['.cache']);
  assert.throws(() => findFiles(path.join(tmp, 'gone'), 'x'), (e) => e.status === 404);

  const capped = findFiles(froot, 'widget', { max: 2 });
  assert.deepEqual([capped.entries.length, capped.truncated], [2, true]);
  const many = path.join(tmp, 'many');
  fs.mkdirSync(many);
  for (let i = 0; i <= FIND_VISIT_MAX; i++) fs.writeFileSync(path.join(many, `f${i}`), '');
  const walked = findFiles(many, 'nothing-like-this');
  assert.deepEqual([walked.entries.length, walked.truncated], [0, true]);
});

test('GET /api/files/find: 2+ characters, only for a known chat', async (t) => {
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    if (!handleFiles(req, res, new URL(req.url, 'http://x'), { rootFor: (cid) => (cid === 'c1' ? root : null), json })) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const find = (q, cid = 'c1') => fetch(`http://127.0.0.1:${server.address().port}/api/files/find?cid=${cid}&q=${encodeURIComponent(q)}`);
  const ok = await find('app');
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).entries.map((e) => e.path), ['src/app.js']);
  const key = await find('key');
  assert.deepEqual((await key.json()).entries, [], 'links out of the project are never listed or walked');
  for (const [q, cid, status] of [['a', 'c1', 400], [' a ', 'c1', 400], ['app', 'other', 404]]) {
    const r = await find(q, cid);
    assert.equal(r.status, status, q);
    await r.arrayBuffer();
  }
});
