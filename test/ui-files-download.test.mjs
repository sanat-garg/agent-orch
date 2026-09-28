// Files view (files.js) Download, run in a vm with the DOM stubbed and the click on the hidden <a download> recorded (the
// browser saves GET /api/files/download itself; nothing is fetched):
// - one selected file → /api/files/download?cid=&path=<file>; three selected → three path params (a zip); a folder → its
//   one path (a zip) with 'Downloading … as a zip';
// - protected files are left out of a multi-selection with 'Skipped 1 protected file'; one protected file alone downloads nothing;
// - the toolbar button is disabled (with a tooltip) without a selection or when only protected files are selected;
// - the context menu and ⌘⇧D / Ctrl+Shift+D offer it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/files.js', import.meta.url), 'utf8');

function fixture() {
  const clicks = [], toasts = [];
  const btn = { disabled: false, title: '' };
  const elements = { app: { dataset: { view: 'chat' } }, fxDownload: btn };
  const document = {
    addEventListener() {},
    body: { append() {} },
    createElement: (tag) => ({ tag, click() { clicks.push({ href: this.href, download: this.download, hidden: this.hidden }); }, remove() {} }),
  };
  const context = vm.createContext({
    document, window: {}, navigator: { platform: 'MacIntel', userAgent: '' }, matchMedia: () => ({ matches: false }),
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
  return { run, pick, download, params, clicks, toasts, btn };
}

test('one selected file downloads directly from the single-path URL', () => {
  const f = fixture();
  f.pick('/w/proj/b c.md');
  assert.equal(f.btn.disabled, false);
  assert.match(f.btn.title, /Download \(⌘⇧D\)/);
  f.download();
  assert.equal(f.clicks.length, 1);
  assert.equal(f.clicks[0].href, '/api/files/download?cid=c1&path=%2Fw%2Fproj%2Fb%20c.md');
  assert.equal(f.clicks[0].download, '');
  assert.equal(f.clicks[0].hidden, true);
  assert.deepEqual(f.toasts, [], 'no zip toast for one file');
});

test('three selected build one URL with three path params (a zip)', () => {
  const f = fixture();
  f.pick('/w/proj/a.txt', '/w/proj/b c.md', '/w/proj/src');
  assert.match(f.btn.title, /as a zip/);
  f.download();
  assert.equal(f.clicks.length, 1);
  assert.deepEqual(f.params(f.clicks[0].href).getAll('path'), ['/w/proj/a.txt', '/w/proj/b c.md', '/w/proj/src']);
  assert.equal(f.params(f.clicks[0].href).get('cid'), 'c1');
  assert.deepEqual(f.toasts, ['Downloading 3 items as a zip']);
});

test('a folder builds the zip URL of its one path', () => {
  const f = fixture();
  f.pick('/w/proj/src');
  f.download();
  assert.equal(f.clicks[0].href, '/api/files/download?cid=c1&path=%2Fw%2Fproj%2Fsrc');
  assert.deepEqual(f.toasts, ['Downloading “src” as a zip']);
});

test('protected files are excluded from a multi-selection with a toast; alone they download nothing', () => {
  const f = fixture();
  f.pick('/w/proj/a.txt', '/w/proj/.env', '/w/proj/b c.md');
  f.download();
  assert.deepEqual(f.params(f.clicks[0].href).getAll('path'), ['/w/proj/a.txt', '/w/proj/b c.md']);
  assert.ok(f.toasts.includes('Skipped 1 protected file'), f.toasts.join(' | '));
  const g = fixture();
  g.pick('/w/proj/.env');
  assert.equal(g.btn.disabled, true);
  assert.match(g.btn.title, /🔒 Protected file/);
  g.download();
  assert.equal(g.clicks.length, 0);
  // a Contents hit downloads its file (not path#Lline), once however many lines hit
  const h = fixture();
  h.run(`FX.rows = [1, 2].map((line) => ({ e: { name: 'x.js', dir: false }, rel: 'lib/x.js#L' + line, file: 'lib/x.js', hit: { line }, depth: 0 }))`);
  h.pick('lib/x.js#L1', 'lib/x.js#L2');
  h.download();
  assert.equal(h.clicks[0].href, '/api/files/download?cid=c1&path=%2Fw%2Fproj%2Flib%2Fx.js');
});

test('the button is disabled with a tooltip when nothing is selected', () => {
  const f = fixture();
  f.pick();
  assert.equal(f.btn.disabled, true);
  assert.equal(f.btn.title, 'Select files or folders to download');
  f.download();
  assert.equal(f.clicks.length, 0);
});

test('toolbar, context menu and ⌘⇧D / Ctrl+Shift+D offer Download, read-only locations included', () => {
  assert.match(source, /id="fxDownload" disabled>\$\{ICON_DL\}<span>Download<\/span>/);
  assert.match(source, /\['download', 'Download', FX_DL_KEYS, rows\.some\(\(x\) => !x\.e\.protected\)/);
  assert.match(source, /\(e\.metaKey \|\| e\.ctrlKey\) && e\.shiftKey && !e\.altKey && e\.key\.toLowerCase\(\) === 'd'[^\n]*fxDownload\(fxPickedRows\(\)\)/);
  assert.doesNotMatch(source.slice(source.indexOf('function fxDlPaint'), source.indexOf('// Builds and shows a menu')), /fxReadOnly/);
});
