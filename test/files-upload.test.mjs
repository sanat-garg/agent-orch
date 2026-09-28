// files.mjs upload (POST /api/files/upload, the Files tab's drop/upload): into a subfolder, a folder upload's nested
// path creating folders, 409 on an existing file without overwrite, unsafe names and writes outside the allowed roots.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handleFiles } from '../files.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fup-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

// A fresh project (a.txt, sub/, data/, .git/) behind handleFiles on a free port; up(query, body) → [status, json].
async function serve(t) {
  const root = path.join(tmp, `p${++n}`);
  for (const d of ['sub', 'data', '.git']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'A');
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    if (!handleFiles(req, res, new URL(req.url, 'http://x'), { rootFor: (cid) => (cid === 'c1' ? root : null), json, readBody: async () => ({}) })) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const up = async (q, body = 'x') => {
    const r = await fetch(`${base}/api/files/upload?${new URLSearchParams({ cid: 'c1', ...q })}`, { method: 'POST', body });
    return [r.status, await r.json()];
  };
  return { root, up, read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'), has: (rel) => fs.existsSync(path.join(root, rel)), base };
}
const leftovers = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).includes('.upload-'));

test('upload: a file lands in a subfolder, streamed from the raw body; absolute dir answers absolute', async (t) => {
  const p = await serve(t);
  assert.deepEqual(await p.up({ dir: 'sub', path: 'b.txt' }, 'hello'), [200, { saved: 'sub/b.txt' }]);
  assert.equal(p.read('sub/b.txt'), 'hello');
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  assert.deepEqual(await p.up({ dir: 'sub', path: 'big.bin' }, big), [200, { saved: 'sub/big.bin' }]);
  assert.ok(fs.readFileSync(path.join(p.root, 'sub/big.bin')).equals(big));
  const abs = fs.realpathSync(path.join(p.root, 'sub'));
  assert.deepEqual(await p.up({ dir: abs, path: 'c.txt' }, 'C'), [200, { saved: path.join(abs, 'c.txt') }]);
  assert.deepEqual(await p.up({ path: 'top.txt' }, 'T'), [200, { saved: 'top.txt' }], 'dir defaults to the project');
  assert.deepEqual(leftovers(p.root), []);
  assert.equal((await fetch(`${p.base}/api/files/upload?cid=c1&path=x`)).status, 404, 'upload is POST only');
});

test('upload: a nested folder path creates the folders on the way', async (t) => {
  const p = await serve(t);
  assert.deepEqual(await p.up({ dir: 'sub', path: 'folder/deep/er/a.txt' }, '1'), [200, { saved: 'sub/folder/deep/er/a.txt' }]);
  assert.deepEqual(await p.up({ dir: 'sub', path: 'folder/deep/b.txt' }, '2'), [200, { saved: 'sub/folder/deep/b.txt' }], 'an existing folder is reused');
  assert.equal(p.read('sub/folder/deep/er/a.txt'), '1');
  assert.equal(p.read('sub/folder/deep/b.txt'), '2');
  assert.deepEqual(await p.up({ dir: 'sub', path: 'folder/deep/b.txt/x.txt' }), [409, { error: 'sub/folder/deep/b.txt is not a folder' }]);
});

test('upload: an existing file is 409 {error: exists, path} without overwrite and replaced with overwrite=1', async (t) => {
  const p = await serve(t);
  assert.deepEqual(await p.up({ path: 'a.txt', overwrite: '0' }, 'new'), [409, { error: 'exists', path: 'a.txt' }]);
  assert.deepEqual(await p.up({ path: 'a.txt' }, 'new'), [409, { error: 'exists', path: 'a.txt' }], 'overwrite defaults to 0');
  assert.equal(p.read('a.txt'), 'A');
  assert.deepEqual(await p.up({ path: 'a.txt', overwrite: '1' }, 'new'), [200, { saved: 'a.txt' }]);
  assert.equal(p.read('a.txt'), 'new');
  assert.deepEqual(await p.up({ path: 'sub', overwrite: '1' }), [409, { error: 'sub is not a file' }], 'a folder is never replaced');
  assert.deepEqual(leftovers(p.root), []);
});

test('upload: unsafe names, read-only places and writes outside the project, home and /tmp are refused', async (t) => {
  const p = await serve(t);
  for (const bad of ['../x.txt', 'a/../../x.txt', '/etc/x.txt', 'a\0b', '', '.', 'a/./b', 'a\\..\\b']) {
    assert.equal((await p.up({ dir: 'sub', path: bad }))[0], 400, `path ${JSON.stringify(bad)}`);
  }
  assert.equal((await p.up({ dir: '../', path: 'x.txt' }))[0], 400, 'a relative dir may not climb out');
  assert.deepEqual(await p.up({ dir: '/usr', path: 'x.txt' }), [403, { error: 'Read-only location' }]);
  assert.deepEqual(await p.up({ dir: '/', path: 'x.txt' }), [403, { error: 'Read-only location' }]);
  assert.deepEqual(await p.up({ dir: 'data', path: 'x.txt' }), [403, { error: 'data is read-only' }]);
  assert.deepEqual(await p.up({ path: 'data/x.txt' }), [403, { error: 'data is read-only' }]);
  assert.deepEqual(await p.up({ path: '.git/config' }), [403, { error: '.git is read-only' }]);
  assert.equal((await p.up({ dir: 'a.txt', path: 'x.txt' }))[0], 404, 'dir must be a folder');
  assert.equal((await p.up({ dir: 'nope', path: 'x.txt' }))[0], 404);
  assert.ok(!p.has('x.txt') && !p.has('sub/x.txt') && !fs.existsSync('/usr/x.txt'));
});
