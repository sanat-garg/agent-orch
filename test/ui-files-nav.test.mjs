// Files view (files.js) navigation and file operations in a real browser against server.mjs (temporary HOME, data and port;
// no orchestrator), with /api/files/list, /copy, /move, /zip and /unzip mocked by the page: it opens at the project root,
// the path bar and history navigate, the context menu and ⌘C/⌘X/⌘V/⌘A post the contract's bodies, and the menu stays on screen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'files-nav-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, root, home, dataDir, cookie;

const f = (name, size = 10) => ({ name, dir: false, size, mtime: 1.7e12, hidden: name.startsWith('.') });
const d = (name) => ({ name, dir: true, size: null, mtime: 1.7e12, hidden: false });
const TREE = {
  '': [f('README.md'), d('src'), f('a.zip', 300), d('docs')],
  src: [f('app.js'), d('lib')],
  'src/lib': [f('util.js')],
  docs: [f('guide.md')],
};

before(async () => {
  if (skip) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-filesnav-'));
  home = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  for (const x of [home, dataDir, path.join(root, 'proj')]) fs.mkdirSync(x, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: 'c0', title: 'Demo', cwd: path.join(root, 'proj'), mode: 'default', model: '', createdAt: 1, updatedAt: 1 }]));
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (x) => { out += x; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
});
after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

// A page with the files API mocked: `lists` records each listed dir, `ops` each POST as {op, cid, body}. `fail` makes the
// next op answer 400 {error}.
async function open(viewport = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript(() => localStorage.setItem('cw.lastSeen', String(Date.now())));
  const page = await ctx.newPage();
  const errors = [], lists = [], ops = [], mock = { fail: null };
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/files/list?*', (route) => {
    const u = new URL(route.request().url()), dir = u.searchParams.get('dir');
    lists.push(dir);
    if (!(dir in TREE)) return route.fulfill({ status: 404, json: { error: 'Not found' } });
    route.fulfill({ json: { name: dir.split('/').pop() || 'proj', path: dir, entries: TREE[dir], truncated: false } });
  });
  await page.route(/\/api\/files\/(copy|move|zip|unzip)\?/, async (route) => {
    const u = new URL(route.request().url()), op = u.pathname.split('/').pop(), body = route.request().postDataJSON();
    ops.push({ op, cid: u.searchParams.get('cid'), body, method: route.request().method() });
    if (op === 'zip') await new Promise((r) => setTimeout(r, 300)); // long enough to see the progress bar
    if (mock.fail) { const error = mock.fail; mock.fail = null; return route.fulfill({ status: 400, json: { error } }); }
    route.fulfill({ json: op === 'zip' ? { path: 'Archive.zip' } : op === 'unzip' ? { path: 'a' } : { paths: body.paths.map((p) => `${body.dest ? body.dest + '/' : ''}${p.split('/').pop()}`) } });
  });
  await page.goto(`${base}/#c0`);
  await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
  return { page, errors, lists, ops, mock, ctx };
}
const rowSel = (name) => `#fxMain :is([role="option"], [role="treeitem"]):has-text("${name}")`;
const names = (page) => page.$$eval('#fxMain [data-i] :is(.fx-name, .fx-nt)', (ns) => ns.map((n) => n.textContent));
const crumbs = (page) => page.$$eval('#fxPath .fx-crumb', (bs) => bs.map((b) => b.textContent));
const toasts = (page) => page.$$eval('#toasts .toast:not(.toast-out) .toast-msg', (ts) => ts.map((t) => t.textContent));
async function openFiles(page) {
  await page.click('.seg button[data-view="files"]');
  await page.locator('#fxMain [role="listbox"], #fxMain [role="tree"]').waitFor();
}
async function menu(page, target, pick) {
  if (target) await page.click(target, { button: 'right' });
  else { const b = await page.locator('#fxMain').boundingBox(); await page.mouse.click(b.x + b.width - 20, b.y + b.height - 20, { button: 'right' }); }
  await page.locator('#fxMenu').waitFor();
  if (pick) await page.click(`#fxMenu [data-act="${pick}"]`);
}
const until = (fn) => { const t0 = Date.now(); return (async function poll() { const v = await fn(); if (v || Date.now() - t0 > 5000) return v; await new Promise((r) => setTimeout(r, 50)); return poll(); })(); };

test('opens at the project root, folders first; the path bar, Enter, Backspace, Alt+Up and Back/Forward navigate; the folder is remembered', { skip, timeout: 60000 }, async () => {
  const { page, errors, lists, ctx } = await open();
  await openFiles(page);
  assert.equal(lists[0], '', 'the first listing is the root');
  assert.deepEqual(await names(page), ['docs', 'src', 'a.zip', 'README.md']);
  assert.deepEqual(await crumbs(page), ['proj']);

  await page.dblclick(rowSel('src'));
  await page.waitForFunction(() => document.querySelectorAll('#fxPath .fx-crumb').length === 2);
  await page.click(rowSel('lib'));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#fxPath .fx-crumb').length === 3);
  assert.deepEqual(await crumbs(page), ['proj', 'src', 'lib']);
  assert.deepEqual(await names(page), ['util.js']);

  await page.click('#fxPath .fx-crumb:has-text("proj")');
  await page.waitForFunction(() => document.querySelectorAll('#fxPath .fx-crumb').length === 1);
  assert.deepEqual(await names(page), ['docs', 'src', 'a.zip', 'README.md']);
  await page.click('#fxBack');
  await page.waitForFunction(() => document.querySelectorAll('#fxPath .fx-crumb').length === 3);
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => document.querySelectorAll('#fxPath .fx-crumb').length === 2);
  assert.equal(await page.getAttribute(rowSel('lib'), 'aria-selected'), 'true', 'the folder backed out of stays selected');
  await page.click('#fxBack');
  await page.waitForFunction(() => document.querySelectorAll('#fxPath .fx-crumb').length === 3);
  await page.click('#fxFwd');
  await page.waitForFunction(() => document.querySelectorAll('#fxPath .fx-crumb').length === 2);
  assert.deepEqual(await crumbs(page), ['proj', 'src']);
  await page.keyboard.press('Alt+ArrowUp');
  await page.waitForFunction(() => document.querySelectorAll('#fxPath .fx-crumb').length === 1);
  await page.dblclick(rowSel('docs'));
  await page.waitForFunction(() => document.querySelectorAll('#fxPath .fx-crumb').length === 2);

  await page.reload();
  await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
  await openFiles(page);
  assert.deepEqual(await crumbs(page), ['proj', 'docs'], 'the last folder of this project is remembered');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('context menu: copy then paste into a folder, cut (dimmed) then paste as move, compress, extract, errors', { skip, timeout: 60000 }, async () => {
  const { page, errors, ops, mock, ctx } = await open();
  await openFiles(page);
  await menu(page, rowSel('README.md'));
  const labels = await page.$$eval('#fxMenu .cm-opt', (bs) => bs.map((b) => [b.dataset.act, b.disabled]));
  assert.deepEqual(labels, [['open', false], ['copy', false], ['cut', false], ['paste', true], ['zip', false], ['rename', false], ['newfile', true], ['newdir', true], ['delete', false], ['path', false], ['ask', false]],
    'no Extract for a non-zip; Paste waits for the clipboard; New file/folder only on a folder or the background');
  assert.match(await page.textContent('#fxMenu [data-act="copy"]'), /(⌘|Ctrl\+)C/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#fxMenu').count(), 0, 'Esc closes it');
  await menu(page, rowSel('README.md'));
  await page.click('#fxTitle');
  assert.equal(await page.locator('#fxMenu').count(), 0, 'an outside click closes it');

  await menu(page, rowSel('README.md'), 'copy');
  await menu(page, rowSel('src'));
  assert.match(await page.textContent('#fxMenu [data-act="paste"]'), /Paste into “src”/);
  await page.click('#fxMenu [data-act="paste"]');
  await until(() => ops.length === 1);
  assert.deepEqual(ops[0], { op: 'copy', cid: 'c0', body: { paths: ['README.md'], dest: 'src' }, method: 'POST' });
  await until(async () => (await toasts(page)).some((t) => /Copied “README.md” to src/.test(t)));

  await menu(page, rowSel('a.zip'), 'cut');
  await page.waitForFunction(() => document.querySelector('.fx-cut')?.textContent.includes('a.zip'));
  await page.dblclick(rowSel('docs'));
  await page.waitForFunction(() => document.querySelectorAll('#fxPath .fx-crumb').length === 2);
  await menu(page, null, 'paste'); // the folder's background: paste into the current folder
  await until(() => ops.length === 2);
  assert.deepEqual(ops[1].body, { paths: ['a.zip'], dest: 'docs' });
  assert.equal(ops[1].op, 'move');
  await page.click('#fxPath .fx-crumb:has-text("proj")');
  await page.waitForFunction(() => document.querySelectorAll('#fxPath .fx-crumb').length === 1);
  assert.equal(await page.locator('.fx-cut').count(), 0, 'nothing is dimmed after the move');
  await menu(page, rowSel('README.md'));
  assert.equal(await page.isDisabled('#fxMenu [data-act="paste"]'), true, 'a cut is pasted once');
  await page.keyboard.press('Escape');

  await page.click(rowSel('README.md'));
  await page.click(rowSel('src'), { modifiers: ['ControlOrMeta'] });
  await menu(page, rowSel('src'), 'zip');
  await page.locator('#fxBusy:not([hidden])').waitFor();
  assert.match(await page.textContent('#fxBusy'), /Compressing 2 items/);
  await until(() => ops.length === 3);
  assert.deepEqual(ops[2], { op: 'zip', cid: 'c0', body: { paths: ['src', 'README.md'], dest: '' }, method: 'POST' });
  await page.locator('#fxBusy').waitFor({ state: 'hidden' });
  await until(async () => (await toasts(page)).some((t) => /Created “Archive.zip”/.test(t)));

  await menu(page, rowSel('a.zip'), 'unzip');
  await until(() => ops.length === 4);
  assert.deepEqual(ops[3], { op: 'unzip', cid: 'c0', body: { path: 'a.zip', dest: '' }, method: 'POST' });
  await until(async () => (await toasts(page)).some((t) => /Extracted “a.zip”/.test(t)));

  mock.fail = 'Disk full';
  await menu(page, rowSel('docs'), 'zip');
  await until(() => ops.length === 5);
  await until(async () => (await page.$$eval('#toasts .toast-error .toast-msg', (ts) => ts.map((t) => t.textContent))).includes('Disk full'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('keyboard: ⌘A, Shift-click ranges, ⌘C/⌘X/⌘V with the list focused; the ⋯ button and the menu stay on screen', { skip, timeout: 60000 }, async () => {
  const { page, errors, ops, ctx } = await open({ width: 900, height: 560 });
  await openFiles(page);
  const picked = () => page.$$eval('#fxMain [data-i][aria-selected="true"] :is(.fx-name, .fx-nt)', (ns) => ns.map((n) => n.textContent));
  await page.click(rowSel('docs'));
  await page.keyboard.press('ControlOrMeta+a');
  assert.deepEqual(await picked(), ['docs', 'src', 'a.zip', 'README.md']);
  await page.click(rowSel('src'));
  await page.click(rowSel('README.md'), { modifiers: ['Shift'] });
  assert.deepEqual(await picked(), ['src', 'a.zip', 'README.md']);
  await page.click(rowSel('a.zip'), { modifiers: ['ControlOrMeta'] });
  assert.deepEqual(await picked(), ['src', 'README.md']);

  await page.click(rowSel('README.md'));
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('ControlOrMeta+v');
  await until(() => ops.length === 1);
  assert.deepEqual(ops[0].body, { paths: ['README.md'], dest: '' });
  assert.equal(ops[0].op, 'copy');

  await page.click(rowSel('a.zip'));
  await page.keyboard.press('ControlOrMeta+x');
  await page.waitForFunction(() => document.querySelector('.fx-cut')?.textContent.includes('a.zip'));
  await page.dblclick(rowSel('src'));
  await page.waitForFunction(() => document.querySelectorAll('#fxPath .fx-crumb').length === 2);
  await page.keyboard.press('ControlOrMeta+v');
  await until(() => ops.length === 2);
  assert.deepEqual(ops[1], { op: 'move', cid: 'c0', body: { paths: ['a.zip'], dest: 'src' }, method: 'POST' });

  // The ⋯ button opens the same menu; near the corner the menu flips to stay inside the viewport.
  await page.click(`${rowSel('app.js')} .fx-more`);
  await page.locator('#fxMenu').waitFor();
  assert.equal(await page.textContent('#fxMenu [data-act="copy"]').then((t) => /Copy/.test(t)), true);
  await page.keyboard.press('Escape');
  await menu(page, null); // the folder's bottom-right corner
  const box = await page.locator('#fxMenu').boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 900 && box.y + box.height <= 560, `menu inside the viewport: ${JSON.stringify(box)}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});
