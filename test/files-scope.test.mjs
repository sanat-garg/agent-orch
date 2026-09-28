// files.mjs over the whole disk: absolute paths anywhere (listing '/' and the project's parent), PROTECTED secrets listed
// but never served, copied or moved, writes only under the project, home and /tmp, and relative paths still the project's.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

// A fake home and data dir (os.homedir() follows HOME), and a project, all under /tmp itself.
const tmp = fs.realpathSync(fs.mkdtempSync('/tmp/cw-scope-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const home = path.join(tmp, 'home'), data = path.join(tmp, 'data'), root = path.join(tmp, 'proj');
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
w(path.join(home, '.ssh/id_ed25519'), 'PRIVATE KEY');
w(path.join(home, 'notes.txt'), 'hello');
w(path.join(data, 'auth.json'), '{"hash":"x"}');
w(path.join(data, 'orchestrator/orch.db'), 'db');
w(path.join(root, 'README.md'), '# proj\n');
w(path.join(root, 'server.pem'), 'CERT');
w(path.join(root, 'src/app.js'), 'console.log("needle")\n');
fs.symlinkSync(path.join(home, '.ssh/id_ed25519'), path.join(root, 'key-link'));
process.env.HOME = home;
process.env.CW_DATA_DIR = data;
const { copyPaths, handleFiles, isSecret, listDir, movePaths, zipPaths, PROTECTED } = await import('../files.mjs');

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => r(JSON.parse(s || '{}'))); });
const server = http.createServer((req, res) => {
  if (!handleFiles(req, res, new URL(req.url, 'http://x'), { rootFor: (cid) => (cid === 'c1' ? root : null), json, readBody })) { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;
const get = (kind, q) => fetch(`${base}/api/files/${kind}?cid=c1&${new URLSearchParams(q)}`);
const post = (kind, body) => fetch(`${base}/api/files/${kind}`, { method: 'POST', body: JSON.stringify({ cid: 'c1', ...body }) });

test('list: "/" and the project\'s parent by absolute path, with places, parent and per-entry flags', async () => {
  const r = await get('list', { dir: '/' });
  assert.equal(r.status, 200);
  const top = await r.json();
  assert.equal(top.dir, '/');
  assert.equal(top.parent, null);
  assert.ok(top.entries.some((e) => e.type === 'dir' && e.path === path.join('/', e.name)), 'absolute entry paths');
  assert.deepEqual(top.places.map((p) => p.label), ['Project', 'Home', '/', '/tmp']);
  assert.deepEqual(top.places.map((p) => p.path), [root, home, '/', '/tmp']);
  const up = await (await get('list', { dir: tmp })).json();
  assert.equal(up.dir, tmp);
  assert.equal(up.parent, path.dirname(tmp));
  const proj = up.entries.find((e) => e.name === 'proj');
  assert.deepEqual([proj.type, proj.path, proj.readable, proj.writable, proj.protected, proj.isSymlink], ['dir', root, true, true, false, false]);
  for (const k of ['name', 'path', 'type', 'size', 'mtime', 'isSymlink', 'readable', 'writable', 'protected']) assert.ok(k in proj, k);
  const etc = (await (await get('list', { dir: '/' })).json()).entries.find((e) => e.name === 'etc');
  assert.equal(etc.writable, false, '/etc is outside the write roots');
});

test('protected files are listed with protected: true, but preview, copy, zip and move are 403', async () => {
  const ssh = await (await get('list', { dir: path.join(home, '.ssh') })).json();
  assert.deepEqual(ssh.entries.map((e) => [e.name, e.protected, e.writable]), [['id_ed25519', true, false]]);
  const d = await (await get('list', { dir: data })).json();
  assert.equal(d.entries.find((e) => e.name === 'auth.json').protected, true);
  const proj = await (await get('list', { dir: root })).json(); // absolute: links out of the project are listed too
  assert.equal(proj.entries.find((e) => e.name === 'server.pem').protected, true);
  assert.equal(proj.entries.find((e) => e.name === 'key-link').protected, true, 'a link to a secret is one');
  assert.equal(proj.entries.find((e) => e.name === 'README.md').protected, false);
  for (const p of [path.join(home, '.ssh/id_ed25519'), path.join(data, 'auth.json'), path.join(data, 'orchestrator/orch.db'), 'server.pem', 'key-link']) {
    const r = await get('raw', { path: p });
    assert.equal(r.status, 403, p);
    assert.doesNotMatch(await r.text(), /PRIVATE KEY|hash|CERT/);
  }
  for (const [kind, body] of [['copy', { paths: [path.join(home, '.ssh/id_ed25519')], dest: tmp }], ['zip', { paths: ['server.pem'] }],
    ['move', { paths: [path.join(data, 'auth.json')], dest: tmp }], ['move', { paths: [path.join(home, '.ssh')], dest: tmp }]]) {
    const r = await post(kind, body);
    assert.equal(r.status, 403, `${kind} ${body.paths}`);
  }
  assert.ok(fs.existsSync(path.join(data, 'auth.json')) && fs.existsSync(path.join(home, '.ssh/id_ed25519')));
  // A copied or zipped folder leaves its secrets out; grep never reads one.
  const c = await (await post('copy', { paths: [home], dest: tmp })).json();
  assert.deepEqual(c.created, [path.join(tmp, 'home copy')]);
  assert.ok(fs.existsSync(path.join(tmp, 'home copy/notes.txt')));
  assert.ok(!fs.existsSync(path.join(tmp, 'home copy/.ssh')));
  fs.appendFileSync(path.join(root, 'server.pem'), 'needle');
  const g = await (await get('grep', { q: 'needle' })).json();
  assert.deepEqual(g.hits.map((h) => h.path), ['src/app.js']);
  assert.ok(Array.isArray(PROTECTED) && isSecret('/any/where/x.key') && isSecret(path.join(home, '.git-credentials')));
});

test('writes: /etc is a read-only location, /tmp and home are fine; move out of /etc is refused too', async () => {
  const etc = await post('copy', { paths: ['README.md'], dest: '/etc' });
  assert.equal(etc.status, 403);
  assert.deepEqual(await etc.json(), { error: 'Read-only location' });
  assert.ok(!fs.existsSync('/etc/README.md'));
  await assert.rejects(zipPaths(root, ['README.md'], { dest: '/etc' }), (e) => e.status === 403 && e.message === 'Read-only location');
  await assert.rejects(movePaths(root, ['/etc/hosts'], tmp), (e) => e.status === 403 && e.message === 'Read-only location');
  // A link in a write root that points to /etc carries no write there.
  fs.symlinkSync('/etc', path.join(tmp, 'etc-link'));
  await assert.rejects(copyPaths(root, ['README.md'], path.join(tmp, 'etc-link')), (e) => e.status === 403);
  // Under /tmp itself: copy, zip and move work, answering absolute paths.
  const out = fs.mkdtempSync('/tmp/cw-scope-out-');
  after(() => fs.rmSync(out, { recursive: true, force: true }));
  const c = await post('copy', { paths: ['README.md'], dest: out });
  assert.equal(c.status, 200);
  assert.deepEqual(await c.json(), { created: [path.join(fs.realpathSync(out), 'README.md')] });
  assert.equal(fs.readFileSync(path.join(out, 'README.md'), 'utf8'), '# proj\n');
  const z = await (await post('zip', { paths: [path.join(out, 'README.md')] })).json();
  assert.equal(z.zip, path.join(fs.realpathSync(out), 'README.md.zip'));
  const m = await (await post('move', { paths: [path.join(out, 'README.md.zip')], dest: home })).json();
  assert.deepEqual(m.moved, [{ from: path.join(fs.realpathSync(out), 'README.md.zip'), to: path.join(home, 'README.md.zip') }]);
  assert.ok(fs.existsSync(path.join(home, 'README.md.zip')));
});

test('relative paths still resolve to the project, and find/grep default to it; dir= narrows them', async () => {
  const d = listDir(root, 'src');
  assert.equal(d.path, 'src');
  assert.equal(d.dir, path.join(root, 'src'));
  assert.deepEqual(d.entries.map((e) => e.path), [path.join(root, 'src/app.js')]);
  assert.equal(listDir(root, '').parent, tmp);
  const rel = await get('list', { dir: '../home' });
  assert.equal(rel.status, 400, 'a relative path never leaves the project');
  assert.equal(await (await get('raw', { path: 'README.md' })).text(), '# proj\n');
  assert.equal(await (await get('raw', { path: path.join(root, 'README.md') })).text(), '# proj\n');
  assert.deepEqual((await (await get('find', { q: 'app' })).json()).entries.map((e) => e.path), ['src/app.js']);
  assert.deepEqual((await (await get('find', { q: 'app', dir: path.join(root, 'src') })).json()).entries.map((e) => e.path), [path.join(root, 'src/app.js')]);
  assert.deepEqual((await (await get('grep', { q: 'needle', dir: 'src' })).json()).hits.map((h) => h.path), ['src/app.js']);
  assert.deepEqual((await (await get('find', { q: 'notes', dir: tmp })).json()).entries.map((e) => e.path).filter((p) => !p.includes(' copy')), [path.join(home, 'notes.txt')]);
  assert.deepEqual(await copyPaths(root, ['README.md'], 'src'), { created: ['src/README.md'] });
  const missing = await get('list', { dir: '/no/such/folder' });
  assert.equal(missing.status, 404);
});

test('a folder the server\'s user can\'t read: listed as unreadable, and listing it is 403 Permission denied', { skip: process.getuid?.() === 0 && 'root reads everything' }, async () => {
  const locked = path.join(tmp, 'locked');
  fs.mkdirSync(locked, { mode: 0o000 });
  after(() => fs.chmodSync(locked, 0o755));
  const up = await (await get('list', { dir: tmp })).json();
  assert.equal(up.entries.find((e) => e.name === 'locked').readable, false);
  const r = await get('list', { dir: locked });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'Permission denied' });
});

test('a huge folder lists its first LIST_MAX entries, flagged truncated', async () => {
  const { LIST_MAX } = await import('../files.mjs');
  const big = path.join(tmp, 'big');
  fs.mkdirSync(big);
  for (let i = 0; i <= LIST_MAX; i++) fs.writeFileSync(path.join(big, `f${i}`), '');
  const d = await (await get('list', { dir: big })).json();
  assert.equal(LIST_MAX, 5000);
  assert.equal(d.entries.length, LIST_MAX);
  assert.equal(d.truncated, true);
  assert.equal((await (await get('list', { dir: tmp })).json()).truncated, false);
});
