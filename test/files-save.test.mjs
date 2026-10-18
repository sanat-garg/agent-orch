// files.mjs save (POST /api/files/save, the Files tab's code editor): replaces a file in place keeping its mode, the
// raw read's X-Mtime guards against overwriting a newer version (409 changed), and the guards match uploads'.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handleFiles, SAVE_MAX, TEXT_MAX } from '../files.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fsave-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

// A fresh project (a.sh, data/x.txt, .git/config, sub/) behind handleFiles; save(query, body) → [status, json].
async function serve(t) {
  const root = path.join(tmp, `p${++n}`);
  for (const d of ['sub', 'data', '.git']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.sh'), 'echo hi\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'data/x.txt'), 'x');
  fs.writeFileSync(path.join(root, '.git/config'), '[core]');
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    if (!handleFiles(req, res, new URL(req.url, 'http://x'), { rootFor: (cid) => (cid === 'c1' ? root : null), json, readBody: async () => ({}) })) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const save = async (q, body = 'x') => {
    const r = await fetch(`${base}/api/files/save?${new URLSearchParams({ cid: 'c1', ...q })}`, { method: 'POST', body });
    return [r.status, await r.json()];
  };
  const raw = (rel, edit) => fetch(`${base}/api/files/raw?cid=c1&path=${encodeURIComponent(rel)}${edit ? '&edit=1' : ''}`);
  return { root, save, raw, read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'), base };
}

test('save: the text replaces the file, its mode stays, and the answer carries the new mtime', async (t) => {
  const p = await serve(t);
  const mtime = (await p.raw('a.sh')).headers.get('x-mtime');
  assert.ok(mtime);
  const [status, body] = await p.save({ path: 'a.sh', mtime }, 'echo bye\n');
  assert.equal(status, 200);
  assert.equal(body.saved, 'a.sh');
  assert.equal(body.size, 9);
  assert.equal(body.mtime, fs.statSync(path.join(p.root, 'a.sh')).mtimeMs);
  assert.equal(p.read('a.sh'), 'echo bye\n');
  assert.equal(fs.statSync(path.join(p.root, 'a.sh')).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(p.root).filter((f) => f.includes('.save-')), [], 'no temp file is left');
  // the next save goes against the version just written
  assert.equal((await p.save({ path: 'a.sh', mtime: String(body.mtime) }, 'echo 2\n'))[0], 200);
  assert.equal(p.read('a.sh'), 'echo 2\n');
});

test('save: a file changed since it was opened is 409 changed; without mtime it overwrites', async (t) => {
  const p = await serve(t);
  const mtime = (await p.raw('a.sh')).headers.get('x-mtime');
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(path.join(p.root, 'a.sh'), 'agent edit\n');
  fs.utimesSync(path.join(p.root, 'a.sh'), later, later);
  const [status, body] = await p.save({ path: 'a.sh', mtime }, 'mine\n');
  assert.equal(status, 409);
  assert.equal(body.error, 'changed');
  assert.equal(body.mtime, fs.statSync(path.join(p.root, 'a.sh')).mtimeMs);
  assert.equal(p.read('a.sh'), 'agent edit\n', 'nothing was written');
  assert.equal((await p.save({ path: 'a.sh' }, 'mine\n'))[0], 200);
  assert.equal(p.read('a.sh'), 'mine\n');
});

test('save: only existing files, never secrets, data/, .git or read-only places', async (t) => {
  const p = await serve(t);
  assert.equal((await p.save({ path: 'new.txt' }))[0], 404, 'save never creates a file');
  assert.deepEqual(await p.save({ path: 'sub' }), [400, { error: 'Not a file' }]);
  assert.equal((await p.save({ path: 'data/x.txt' }))[0], 403);
  assert.equal((await p.save({ path: '.git/config' }))[0], 403);
  assert.equal(p.read('.git/config'), '[core]');
  fs.writeFileSync(path.join(p.root, 'server.key'), 'k');
  assert.deepEqual(await p.save({ path: 'server.key' }), [403, { error: 'This file is protected' }]);
  assert.equal((await p.save({ path: '../escape' }))[0], 400);
  assert.equal((await p.save({ path: '/etc/hostname' }))[0], 403, 'outside the project, home and /tmp is read-only');
  assert.equal((await fetch(`${p.base}/api/files/save?cid=c1&path=a.sh`)).status, 404, 'save is POST only');
  assert.equal((await p.save({ path: 'a.sh' }, Buffer.alloc(SAVE_MAX + 1, 97)))[0], 413);
  assert.equal(p.read('a.sh'), 'echo hi\n');
});

test('raw edit=1 reads up to the save limit; a plain read stops at the preview cap', async (t) => {
  const p = await serve(t);
  fs.writeFileSync(path.join(p.root, 'big.txt'), 'a'.repeat(TEXT_MAX + 10));
  const plain = await p.raw('big.txt');
  assert.equal(plain.headers.get('x-truncated'), '1');
  assert.equal((await plain.text()).length, TEXT_MAX);
  const full = await p.raw('big.txt', true);
  assert.equal(full.headers.get('x-truncated'), null);
  assert.equal((await full.text()).length, TEXT_MAX + 10);
});
