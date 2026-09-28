// Files view (files.js) Download, run in a vm with the DOM stubbed, fetch answering the …&check=1 preflight, and the click
// on the hidden <a download> recorded (the browser saves GET /api/files/download itself):
// - one selected file → /api/files/download?cid=&path=<file>; three selected → three path params (a zip); a folder → its
//   one path (a zip) with 'Downloading … as a zip';
// - protected files are left out of a multi-selection with 'Skipped 1 protected file'; one protected file alone downloads nothing;
// - the toolbar button is disabled (with a tooltip) without a selection or when only protected files are selected;
// - a failed preflight (403, a bare 404 from an older server, a network error) shows a toast and clicks no link (#780);
// - the context menu and ⌘⇧D / Ctrl+Shift+D offer it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/files.js', import.meta.url), 'utf8');

// check: (url) → the preflight's {status, body} (default ok); fetches records every URL fetched.
function fixture(check = () => ({ status: 200, body: { ok: true, name: 'x', kind: 'file' } })) {
  const clicks = [], toasts = [], fetches = [];
  const btn = { disabled: false, title: '' };
  const elements = { app: { dataset: { view: 'chat' } }, fxDownload: btn };
  const document = {
    addEventListener() {},
    body: { append() {} },
    createElement: (tag) => ({ tag, click() { clicks.push({ href: this.href, download: this.download, hidden: this.hidden }); }, remove() {} }),
  };
  const context = vm.createContext({
    document, window: {}, navigator: { platform: 'MacIntel', userAgent: '' }, matchMedia: () => ({ matches: false }),
    fetch: async (url) => {
      fetches.push(url);
      const { status, body, type = 'application/json', throws } = check(url);
      if (throws) throw new TypeError('Failed to fetch');
      return { status, ok: status >= 200 && status < 300, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? type : null) },
        json: async () => (typeof body === 'string' ? JSON.parse(body) : body), body: { cancel: async () => {} } };
    },
    location: {}, API_UPDATING: 'The server is updating, try again in a moment',
    $: (id) => elements[id], store: { get: () => null, set() {} }, toast: (text, opts) => toasts.push(text),
    el: () => ({}), api: async () => ({}), currentConvo: () => null, copyToClipboard: async () => true,
  });
  vm.runInContext(source, context);
  const run = (code) => vm.runInContext(code, context);
  run(`FX.built = true; FX.cid = 'c1'; FX.proj = '/w/proj'; FX.path = '/w/proj';
    FX.rows = [
      { e: { name: 'a.txt', dir: false }, rel: '/w/proj/a.txt', depth: 0 },
      { e: { name: 'b c.md', dir: false }, rel: '/w/proj/b c.md', depth: 0 },
      { e: { name: 'src', dir: true }, rel: '/w/proj/src', depth: 0 },
      { e: { name: '.env', dir: false, protected: true }, rel: '/w/proj/.env', depth: 0 },
    ];`);
  const pick = (...rels) => { run(`FX.picked = new Set(${JSON.stringify(rels)}); fxDlPaint();`); };
  const download = () => run('fxDownload(fxPickedRows())');
  const params = (href) => new URL(href, 'http://x').searchParams;
  return { run, pick, download, params, clicks, toasts, fetches, btn };
}

test('one selected file downloads directly from the single-path URL', async () => {
  const f = fixture();
  f.pick('/w/proj/b c.md');
  assert.equal(f.btn.disabled, false);
  assert.match(f.btn.title, /Download \(⌘⇧D\)/);
  await f.download();
  assert.equal(f.clicks.length, 1);
  assert.equal(f.clicks[0].href, '/api/files/download?cid=c1&path=%2Fw%2Fproj%2Fb%20c.md');
  assert.equal(f.clicks[0].download, '');
  assert.equal(f.clicks[0].hidden, true);
  assert.deepEqual(f.toasts, [], 'no zip toast for one file');
});

test('three selected build one URL with three path params (a zip)', async () => {
  const f = fixture();
  f.pick('/w/proj/a.txt', '/w/proj/b c.md', '/w/proj/src');
  assert.match(f.btn.title, /as a zip/);
  await f.download();
  assert.equal(f.clicks.length, 1);
  assert.deepEqual(f.params(f.clicks[0].href).getAll('path'), ['/w/proj/a.txt', '/w/proj/b c.md', '/w/proj/src']);
  assert.equal(f.params(f.clicks[0].href).get('cid'), 'c1');
  assert.deepEqual(f.toasts, ['Downloading 3 items as a zip']);
});

test('a folder builds the zip URL of its one path', async () => {
  const f = fixture();
  f.pick('/w/proj/src');
  await f.download();
  assert.equal(f.clicks[0].href, '/api/files/download?cid=c1&path=%2Fw%2Fproj%2Fsrc');
  assert.deepEqual(f.toasts, ['Downloading “src” as a zip']);
});

test('protected files are excluded from a multi-selection with a toast; alone they download nothing', async () => {
  const f = fixture();
  f.pick('/w/proj/a.txt', '/w/proj/.env', '/w/proj/b c.md');
  await f.download();
  assert.deepEqual(f.params(f.clicks[0].href).getAll('path'), ['/w/proj/a.txt', '/w/proj/b c.md']);
  assert.ok(f.toasts.includes('Skipped 1 protected file'), f.toasts.join(' | '));
  const g = fixture();
  g.pick('/w/proj/.env');
  assert.equal(g.btn.disabled, true);
  assert.match(g.btn.title, /🔒 Protected file/);
  await g.download();
  assert.equal(g.clicks.length, 0);
  // a Contents hit downloads its file (not path#Lline), once however many lines hit
  const h = fixture();
  h.run(`FX.rows = [1, 2].map((line) => ({ e: { name: 'x.js', dir: false }, rel: 'lib/x.js#L' + line, file: 'lib/x.js', hit: { line }, depth: 0 }))`);
  h.pick('lib/x.js#L1', 'lib/x.js#L2');
  await h.download();
  assert.equal(h.clicks[0].href, '/api/files/download?cid=c1&path=%2Fw%2Fproj%2Flib%2Fx.js');
});

test('the preflight is the same URL plus check=1; the download link itself has no check', async () => {
  const f = fixture();
  f.pick('/w/proj/a.txt', '/w/proj/b c.md');
  await f.download();
  assert.equal(f.fetches.length, 1);
  assert.equal(f.fetches[0], `${f.clicks[0].href}&check=1`);
  assert.equal(f.params(f.clicks[0].href).get('check'), null);
});

test('a failed preflight shows a toast and creates no download link', async () => {
  const f = fixture(() => ({ status: 403, body: { error: 'dir/id.pem is protected' } }));
  f.pick('/w/proj/a.txt', '/w/proj/b c.md');
  await f.download();
  assert.equal(f.clicks.length, 0);
  assert.deepEqual(f.toasts, ['Download failed: dir/id.pem is protected']);
  const big = fixture(() => ({ status: 413, body: { error: 'Too much to download at once (2 GB at most)' } }));
  big.pick('/w/proj/src');
  await big.download();
  assert.equal(big.clicks.length, 0);
  assert.deepEqual(big.toasts, ['Download failed: Too much to download at once (2 GB at most)']);
  // a server older than the page doesn't know the route: a bare 404 (no JSON error) → the friendly 'updating' message
  const old = fixture(() => ({ status: 404, body: 'Not found', type: 'text/plain' }));
  old.pick('/w/proj/a.txt');
  await old.download();
  assert.equal(old.clicks.length, 0);
  assert.deepEqual(old.toasts, ['The server is updating, try again in a moment']);
  const oldJson = fixture(() => ({ status: 404, body: {} }));
  oldJson.pick('/w/proj/a.txt');
  await oldJson.download();
  assert.deepEqual([oldJson.clicks.length, oldJson.toasts], [0, ['The server is updating, try again in a moment']]);
  const gone = fixture(() => ({ status: 404, body: { error: 'Not found: a.txt' } }));
  gone.pick('/w/proj/a.txt');
  await gone.download();
  assert.deepEqual([gone.clicks.length, gone.toasts], [0, ['Download failed: Not found: a.txt']]);
  const offline = fixture(() => ({ throws: true }));
  offline.pick('/w/proj/a.txt');
  await offline.download();
  assert.deepEqual([offline.clicks.length, offline.toasts], [0, ["Download failed: Couldn't reach the server"]]);
});

test('the button is disabled with a tooltip when nothing is selected', async () => {
  const f = fixture();
  f.pick();
  assert.equal(f.btn.disabled, true);
  assert.equal(f.btn.title, 'Select files or folders to download');
  await f.download();
  assert.equal(f.clicks.length, 0);
});

test('toolbar, context menu and ⌘⇧D / Ctrl+Shift+D offer Download, read-only locations included', () => {
  assert.match(source, /id="fxDownload" disabled>\$\{ICON_DL\}<span>Download<\/span>/);
  assert.match(source, /\['download', 'Download', FX_DL_KEYS, rows\.some\(\(x\) => !x\.e\.protected\)/);
  assert.match(source, /\(e\.metaKey \|\| e\.ctrlKey\) && e\.shiftKey && !e\.altKey && e\.key\.toLowerCase\(\) === 'd'[^\n]*fxDownload\(fxPickedRows\(\)\)/);
  assert.doesNotMatch(source.slice(source.indexOf('function fxDlPaint'), source.indexOf('// Builds and shows a menu')), /fxReadOnly/);
});
