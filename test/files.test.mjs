// files.mjs (the Files view): listing and serving stay inside the chat's project, whatever the path or symlink says.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { changedFiles, findFiles, FIND_VISIT_MAX, grepFiles, handleFiles, listDir, resolveInside, TEXT_MAX } from '../files.mjs';

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

test('grepFiles: finds lines at any depth, case-insensitive, skips binary and big files, stops at max', async () => {
  const groot = path.join(tmp, 'grepproj');
  fs.mkdirSync(path.join(groot, 'a/b'), { recursive: true });
  fs.mkdirSync(path.join(groot, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(groot, 'a/b/deep.js'), 'const x = 1;\n  // TODO: Needle in a haystack  \r\nlast\n');
  fs.writeFileSync(path.join(groot, 'bin.dat'), Buffer.concat([Buffer.from('needle'), Buffer.from([0, 1, 2])]));
  fs.writeFileSync(path.join(groot, 'big.txt'), 'needle\n' + 'x'.repeat(2000));
  fs.writeFileSync(path.join(groot, 'node_modules/pkg/i.js'), 'needle');
  fs.writeFileSync(path.join(groot, 'long.txt'), 'y'.repeat(500) + 'NEEDLE' + 'z'.repeat(500));
  fs.symlinkSync(path.join(outside, 'key.txt'), path.join(groot, 'key-out.txt'));

  const r = await grepFiles(groot, 'nEEdle', { fileMax: 1500 });
  assert.equal(r.q, 'nEEdle');
  assert.equal(r.truncated, false);
  assert.deepEqual(r.hits.map((h) => [h.path, h.line]), [['long.txt', 1], ['a/b/deep.js', 2]]);
  assert.equal(r.hits[1].text, '// TODO: Needle in a haystack');
  const long = r.hits[0].text;
  assert.equal(long.length, 200);
  assert.ok(long.includes('NEEDLE') && long.startsWith('y') && long.endsWith('z'), 'the snippet is centred on the match');
  assert.equal(r.files, 2, 'big.txt (over fileMax) and bin.dat (binary) are not searched');
  assert.deepEqual((await grepFiles(groot, 'top secret')).hits, [], 'links out of the project are never read');

  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(groot, `m${i}.txt`), 'needle\nneedle\n');
  const capped = await grepFiles(groot, 'needle', { max: 3, fileMax: 1500 });
  assert.deepEqual([capped.hits.length, capped.truncated], [3, true]);
  await assert.rejects(grepFiles(path.join(tmp, 'gone'), 'xx'), (e) => e.status === 404);
});

test('GET /api/files/grep: 2+ characters, only for a known chat', async (t) => {
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    if (!handleFiles(req, res, new URL(req.url, 'http://x'), { rootFor: (cid) => (cid === 'c1' ? root : null), json })) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const grep = (q, cid = 'c1') => fetch(`http://127.0.0.1:${server.address().port}/api/files/grep?cid=${cid}&q=${encodeURIComponent(q)}`);
  const ok = await grep('CONSOLE.log');
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(body.hits, [{ path: 'src/app.js', line: 1, text: 'console.log(1)' }]);
  assert.equal(typeof body.files, 'number');
  assert.equal(body.truncated, false);
  const key = await grep('top secret');
  assert.deepEqual((await key.json()).hits, [], 'links out of the project are never read');
  for (const [q, cid, status] of [['a', 'c1', 400], [' a ', 'c1', 400], ['x'.repeat(201), 'c1', 400], ['console', 'other', 404]]) {
    const r = await grep(q, cid);
    assert.equal(r.status, status, q);
    await r.arrayBuffer();
  }
});

test('changedFiles and GET /api/files/changed|diff: M/?/D/R against HEAD with counts, diffs per file, notGit outside git', async (t) => {
  const repo = path.join(tmp, 'gitrepo');
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe' });
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'mod.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'a\nb\n');
  fs.writeFileSync(path.join(repo, 'old.txt'), 'same\n');
  fs.writeFileSync(path.join(repo, 'sub/in.txt'), 'x\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'mod.txt'), 'one\nTWO\nthree\nfour\n');
  fs.rmSync(path.join(repo, 'gone.txt'));
  git('mv', 'old.txt', 'new.txt');
  fs.writeFileSync(path.join(repo, 'fresh.txt'), 'hello\nworld\n');
  fs.writeFileSync(path.join(repo, 'fresh.bin'), Buffer.from([1, 0, 2]));
  fs.mkdirSync(path.join(repo, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules/pkg/i.js'), 'x');
  fs.symlinkSync(path.join(outside, 'key.txt'), path.join(repo, 'key-out.txt'));
  fs.writeFileSync(path.join(repo, 'sub/in.txt'), 'y\n');

  const r = await changedFiles(repo);
  assert.equal(typeof r.branch, 'string');
  assert.equal(r.truncated, false);
  assert.deepEqual(r.entries.map((e) => [e.path, e.status, e.add, e.del, e.binary]), [
    ['fresh.bin', '?', 0, 0, true], ['fresh.txt', '?', 2, 0, false], ['gone.txt', 'D', 0, 2, false], ['mod.txt', 'M', 2, 1, false],
    ['new.txt', 'R', 0, 0, false], ['sub/in.txt', 'M', 1, 1, false]]);
  assert.equal(r.entries.find((e) => e.status === 'R').from, 'old.txt');
  assert.deepEqual((await changedFiles(repo, { max: 2 })).truncated, true);
  // A project that is a subfolder of the repo: paths relative to it, nothing from outside it.
  assert.deepEqual((await changedFiles(path.join(repo, 'sub'))).entries.map((e) => e.path), ['in.txt']);
  assert.deepEqual(await changedFiles(root), { branch: null, entries: [], notGit: true });

  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const roots = { c1: repo, c2: path.join(repo, 'sub'), c3: root };
  const server = http.createServer((req, res) => {
    if (!handleFiles(req, res, new URL(req.url, 'http://x'), { rootFor: (cid) => roots[cid] || null, json })) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const diff = (p, cid = 'c1') => fetch(`${base}/api/files/diff?cid=${cid}&path=${encodeURIComponent(p)}`);

  const changed = await fetch(`${base}/api/files/changed?cid=c1`);
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).entries.length, 6);
  const notGit = await fetch(`${base}/api/files/changed?cid=c3`);
  assert.deepEqual([notGit.status, (await notGit.json()).notGit], [200, true]);

  const mod = await diff('mod.txt');
  assert.equal(mod.status, 200);
  assert.equal(mod.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(mod.headers.get('content-security-policy'), /^sandbox;/);
  const modText = await mod.text();
  assert.match(modText, /^@@ .* @@/m);
  assert.match(modText, /^-two$/m);
  assert.match(modText, /^\+TWO$/m);
  assert.match(modText, /^\+four$/m);
  const fresh = await (await diff('fresh.txt')).text();
  assert.match(fresh, /^--- \/dev\/null$/m);
  assert.match(fresh, /^\+hello$/m);
  assert.match(await (await diff('gone.txt')).text(), /^-b$/m);
  assert.match(await (await diff('in.txt', 'c2')).text(), /^\+y$/m);
  for (const [p, cid, status] of [['README.md', 'c3', 404], ['sub/in.txt', 'c2', 404], ['old.txt', 'c1', 404], ['nope.txt', 'c1', 404],
    ['key-out.txt', 'c1', 404], ['node_modules/pkg/i.js', 'c1', 404], ['../secret/key.txt', 'c1', 404]]) {
    const res = await diff(p, cid);
    assert.equal(res.status, status, p);
    assert.doesNotMatch(await res.text(), /top secret/);
  }
  const bigRepo = path.join(tmp, 'gitbig');
  fs.mkdirSync(bigRepo);
  execFileSync('git', ['-C', bigRepo, 'init', '-q']);
  fs.writeFileSync(path.join(bigRepo, 'huge.txt'), 'line\n'.repeat(60000));
  roots.c4 = bigRepo;
  const huge = await diff('huge.txt', 'c4');
  assert.equal(huge.headers.get('x-truncated'), '1');
  assert.equal((await huge.arrayBuffer()).byteLength, 200 * 1024);
});
