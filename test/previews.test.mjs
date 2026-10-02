import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createPreviews, normalizeSlug, normalizeDomain, caddySubdomains, renderCaddy, detectKind, NOTHING_TO_SERVE } from '../previews.mjs';

const OWNER_CADDY = `greygoose.baby {
	reverse_proxy 127.0.0.1:3000
}

fretbook.greygoose.baby {
	reverse_proxy 127.0.0.1:4310
}
# old.greygoose.baby { }
other.example.com {
	reverse_proxy 127.0.0.1:1
}
`;

// A fake `sudo …` that edits files in the temp dir; caddy validate fails while `bad.fail` is set.
function setup({ ports = [45100 + Math.floor(Math.random() * 400), 45599] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'previews-'));
  const caddyfile = path.join(tmp, 'Caddyfile'), includeFile = path.join(tmp, 'agent-orch-previews.caddy');
  fs.writeFileSync(caddyfile, OWNER_CADDY);
  const calls = [], bad = { fail: false };
  const exec = async (cmd, args) => {
    assert.equal(cmd, 'sudo');
    calls.push(args.join(' '));
    const [c, ...a] = args;
    if (c === 'install') fs.copyFileSync(a[2], a[3]);
    else if (c === 'cp') fs.copyFileSync(a[1], a[2]);
    else if (c === 'rm') fs.rmSync(a[1], { force: true });
    else if (c === 'systemctl') bad.savedAtReload = fs.readFileSync(path.join(tmp, 'data', 'previews.json'), 'utf8');
    else if (c === 'caddy' && bad.fail) return { code: 1, stdout: '', stderr: 'INFO using config\nError: adapting config: bad thing' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const changes = [];
  const pv = createPreviews({ dataDir: path.join(tmp, 'data'), caddyfile, includeFile, exec, ports, debounceMs: 20, healthMs: 15000,
    forbid: [path.join(tmp, 'agent-orch')], onChange: (d) => changes.push(d) });
  return { tmp, caddyfile, includeFile, calls, bad, pv, changes, cleanup: async () => { await pv.stopAll(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}
const get = (url) => new Promise((resolve, reject) => http.get(url, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => resolve({ status: r.statusCode, body: b })); }).on('error', reject));
const until = async (fn, ms = 20000) => { const t = Date.now() + ms; while (!(await fn())) { if (Date.now() > t) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 100)); } };

test('slug and domain normalisation', () => {
  assert.equal(normalizeSlug('My Cool_App!!'), 'my-cool-app');
  assert.equal(normalizeSlug('--a--b--'), 'a-b');
  assert.equal(normalizeSlug('x'.repeat(60)).length, 40);
  assert.equal(normalizeDomain('https://Example.COM/path'), 'example.com');
  assert.equal(normalizeDomain('*.foo.dev'), 'foo.dev');
  assert.equal(normalizeDomain('localhost'), '');
  assert.deepEqual([...caddySubdomains(OWNER_CADDY, 'greygoose.baby')].sort(), ['', 'fretbook']);
});

test('check: too short, reserved, owner sites, duplicates, own folder, unknown domain', async () => {
  const { pv, tmp, cleanup } = setup();
  try {
    assert.match(pv.check('ab').error, /at least 3/);
    assert.match(pv.check('www').error, /reserved/);
    assert.match(pv.check('Fretbook').error, /another site/);
    assert.match(pv.check('shop', path.join(tmp, 'agent-orch')).error, /own folder/);
    assert.match(pv.check('shop', null, 'nope.dev').error, /isn't one of your/);
    const ok = pv.check('My Shop');
    assert.deepEqual(ok, { ok: true, slug: 'my-shop', domain: 'greygoose.baby', url: 'https://my-shop.greygoose.baby' });
    const a = path.join(tmp, 'a'), b = path.join(tmp, 'b');
    fs.mkdirSync(a); fs.mkdirSync(b);
    assert.equal((await pv.set(a, 'my-shop')).ok, true);
    assert.match(pv.check('my-shop', b).error, /Taken by a/);
    assert.equal(pv.check('my-shop', a).ok, true); // its own slug is fine
    // The same name on another domain is free.
    await pv.addDomain('example.dev');
    assert.equal(pv.check('my-shop', b, 'example.dev').ok, true);
  } finally { await cleanup(); }
});

test('caddy: include generated, import added once with a backup, validate failure rolls back', async () => {
  const { pv, tmp, caddyfile, includeFile, calls, bad, cleanup } = setup();
  try {
    const a = path.join(tmp, 'a'), b = path.join(tmp, 'b');
    fs.mkdirSync(a); fs.mkdirSync(b);
    const r = await pv.set(a, 'alpha');
    assert.equal(r.ok, true);
    assert.equal(r.status === 'stopped' || r.status === 'waiting' || r.status === 'building', true);
    const inc = fs.readFileSync(includeFile, 'utf8');
    assert.match(inc, new RegExp(`alpha\\.greygoose\\.baby \\{\\n\\tencode gzip\\n\\treverse_proxy 127\\.0\\.0\\.1:${r.port}\\n\\}`));
    const main = fs.readFileSync(caddyfile, 'utf8');
    assert.ok(main.startsWith(OWNER_CADDY), 'owner blocks untouched');
    assert.equal(main.split(`import ${includeFile}`).length, 2);
    assert.equal(fs.readFileSync(`${caddyfile}.bak-agent-orch`, 'utf8'), OWNER_CADDY);
    assert.ok(calls.includes('systemctl reload caddy'));
    // Saved before the reload: a Caddy reload once crashed the server mid-request and lost the entry.
    assert.match(bad.savedAtReload, /"slug": "alpha"/);

    await pv.addDomain('example.dev');
    assert.equal((await pv.set(b, 'beta', 'example.dev')).ok, true);
    assert.equal(fs.readFileSync(caddyfile, 'utf8').split(`import ${includeFile}`).length, 2, 'import added once');
    assert.match(fs.readFileSync(includeFile, 'utf8'), /beta\.example\.dev \{/);
    assert.equal(pv.removeDomain('example.dev').error, '1 preview uses example.dev: move or remove it first.');

    // A config Caddy rejects: both files go back, the preview isn't saved, the error is reported.
    const before = fs.readFileSync(includeFile, 'utf8'), reloads = calls.filter((c) => c.startsWith('systemctl')).length;
    bad.fail = true;
    const c = path.join(tmp, 'c'); fs.mkdirSync(c);
    const f = await pv.set(c, 'gamma');
    assert.match(f.error, /rolled back.*bad thing/);
    assert.equal(fs.readFileSync(includeFile, 'utf8'), before);
    assert.equal(pv.view(c), null);
    assert.doesNotMatch(fs.readFileSync(path.join(tmp, 'data', 'previews.json'), 'utf8'), /gamma/);
    assert.equal(calls.filter((x) => x.startsWith('systemctl')).length, reloads);
    bad.fail = false;

    await pv.remove(b);
    assert.doesNotMatch(fs.readFileSync(includeFile, 'utf8'), /beta/);
    assert.equal(pv.removeDomain('example.dev').ok, true);
    assert.deepEqual(pv.domains().map((d) => d.domain), ['greygoose.baby']);
  } finally { await cleanup(); }
});

test('renderCaddy sorts hosts and detectKind reads node/static/php/nothing', () => {
  assert.equal(renderCaddy([{ slug: 'b', domain: 'x.dev', port: 2 }, { slug: 'a', domain: 'x.dev', port: 1 }]).indexOf('a.x.dev') <
    renderCaddy([{ slug: 'b', domain: 'x.dev', port: 2 }, { slug: 'a', domain: 'x.dev', port: 1 }]).indexOf('b.x.dev'), true);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kind-'));
  try {
    const mk = (name, files) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); } return d; };
    assert.equal(detectKind(mk('n', { 'package.json': '{"scripts":{"start":"node s.js","build":"x"}}' })).kind, 'node');
    assert.equal(detectKind(mk('n', { 'package.json': '{"scripts":{"start":"node s.js","build":"x"}}' })).build, true);
    assert.deepEqual(detectKind(mk('v', { 'package.json': '{"scripts":{"build":"vite build"}}' })).roots, ['dist', 'build', 'out']);
    assert.equal(detectKind(mk('s', { 'index.html': '<h1>hi</h1>' })).kind, 'static');
    assert.deepEqual(detectKind(mk('p', { 'public/index.html': 'x' })).roots, ['public']);
    assert.equal(detectKind(mk('php', { 'index.php': '<?php echo 1;' })).kind, 'php');
    assert.equal(detectKind(mk('e', { 'README.md': 'x' })), null);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('static site is served; empty folder waits; a node app redeploys after a commit', async () => {
  const { pv, tmp, cleanup } = setup();
  try {
    const empty = path.join(tmp, 'empty'); fs.mkdirSync(empty);
    await pv.set(empty, 'empty-one');
    await until(() => pv.view(empty).status === 'waiting');
    assert.equal(pv.view(empty).error, NOTHING_TO_SERVE);

    const site = path.join(tmp, 'site'); fs.mkdirSync(site);
    fs.writeFileSync(path.join(site, 'index.html'), '<h1>static hi</h1>');
    const s = await pv.set(site, 'site-one');
    await until(() => pv.view(site).status === 'running');
    assert.equal(pv.view(site).kind, 'static');
    assert.equal((await get(`http://127.0.0.1:${s.port}/`)).body, '<h1>static hi</h1>');
    assert.equal((await get(`http://127.0.0.1:${s.port}/some/route`)).body, '<h1>static hi</h1>'); // SPA fallback
    assert.equal((await get(`http://127.0.0.1:${s.port}/..%2f..%2fetc/passwd`)).status, 403);

    const app = path.join(tmp, 'app'); fs.mkdirSync(app);
    const write = (msg) => fs.writeFileSync(path.join(app, 'server.js'),
      `require('http').createServer((q, r) => r.end(${JSON.stringify(msg)})).listen(process.env.PORT, '127.0.0.1');`);
    fs.writeFileSync(path.join(app, 'package.json'), '{"name":"app","scripts":{"start":"node server.js"}}');
    write('v1');
    const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: app });
    git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'v1');
    const n = await pv.set(app, 'node-app');
    await until(() => pv.view(app).status === 'running');
    assert.equal(pv.view(app).kind, 'node');
    assert.equal((await get(`http://127.0.0.1:${n.port}/`)).body, 'v1');
    assert.match(pv.logs(app), /\$ |npm start|node server\.js/);

    // Redeploy with HEAD unchanged is a no-op; after a commit it serves the new code.
    write('v2'); git('commit', '-qam', 'v2');
    pv.redeploy(app);
    await until(async () => (await get(`http://127.0.0.1:${n.port}/`).catch(() => ({}))).body === 'v2');
    await until(() => pv.view(app).status === 'running');
  } finally { await cleanup(); }
});
