// Files view (files.js) across the whole disk in a real browser against server.mjs (temporary HOME, data and port; no
// orchestrator), with /api/files/list, /raw and /copy mocked by the page to the whole-disk contract (absolute paths, the
// project at /home/u/proj): it opens at the project (again after a reload), ↑ Parent climbs to '/' and stops, Places and a
// typed path (⌘L, with completion) navigate, a permission-denied folder says so inline, a protected file shows a lock and
// 'Protected file: contents hidden' without being fetched, and a read-only location shows a tag and disables write actions.
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
import { findBrowser } from '../browser.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'files-scope-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch {
  try { browser = await chromium.launch({ executablePath: findBrowser() || undefined }); } catch (e) { skip = `no Chromium: ${e.message.split('\n')[0]}`; }
}
let child, base, root, home, dataDir, cookie;

const P = '/home/u/proj';
const f = (name, o = {}) => ({ name, dir: false, type: 'file', size: 10, mtime: 1.7e12, hidden: name.startsWith('.'), isSymlink: false, readable: true, writable: true, protected: false, ...o });
const d = (name, o = {}) => ({ ...f(name, o), dir: true, type: 'dir', size: null });
const RO = { writable: false };
const TREE = {
  '/': [d('etc', RO), d('home', RO), d('root', { readable: false, writable: false }), d('tmp')],
  '/etc': [f('hosts', RO), f('passwd', RO)],
  '/home': [d('u')],
  '/home/u': [d('proj'), d('docs'), d('.ssh', { protected: true, writable: false })],
  [P]: [f('README.md'), d('src'), f('server.pem', { protected: true, writable: false })],
  [`${P}/src`]: [f('app.js'), d('lib')],
  [`${P}/src/lib`]: [f('util.js')],
  '/tmp': [f('scratch.txt')],
};
const PLACES = [{ label: 'Project', path: P }, { label: 'Home', path: '/home/u' }, { label: '/', path: '/' }, { label: '/tmp', path: '/tmp' }];

before(async () => {
  if (skip) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-filesscope-'));
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

// A page with the files API mocked: `lists` records each listed dir ('' = the project), `raws` each file fetched, `ops`
// each POST as {op, body}.
async function open(viewport = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript(() => localStorage.setItem('cw.lastSeen', String(Date.now())));
  const page = await ctx.newPage();
  const errors = [], lists = [], raws = [], ops = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/files/list?*', (route) => {
    const asked = new URL(route.request().url()).searchParams.get('dir'), dir = asked || P;
    lists.push(asked);
    if (dir === '/root') return route.fulfill({ status: 403, json: { error: 'Permission denied' } });
    if (!(dir in TREE)) return route.fulfill({ status: 404, json: { error: 'Not found' } });
    route.fulfill({ json: { dir, parent: dir === '/' ? null : dir.replace(/\/[^/]*$/, '') || '/', places: PLACES, truncated: false,
      entries: TREE[dir].map((e) => ({ ...e, path: `${dir === '/' ? '' : dir}/${e.name}` })), name: dir.split('/').pop() || '/', path: dir } });
  });
  await page.route('**/api/files/raw?*', (route) => { raws.push(new URL(route.request().url()).searchParams.get('path')); route.fulfill({ body: 'secret', contentType: 'text/plain' }); });
  await page.route(/\/api\/files\/(copy|move|zip|unzip)\?/, (route) => {
    ops.push({ op: new URL(route.request().url()).pathname.split('/').pop(), body: route.request().postDataJSON() });
    route.fulfill({ json: {} });
  });
  await page.goto(`${base}/#c0`);
  await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
  return { page, errors, lists, raws, ops, ctx };
}
const rowSel = (name) => `#fxMain :is([role="option"], [role="treeitem"]):has-text("${name}")`;
const crumbs = (page) => page.$$eval('#fxPath .fx-crumb', (bs) => bs.map((b) => b.textContent));
const at = (page, ...parts) => page.waitForFunction((want) => [...document.querySelectorAll('#fxPath .fx-crumb')].map((b) => b.textContent).join('|') === want, parts.join('|'), { timeout: 5000 });
const until = (fn) => { const t0 = Date.now(); return (async function poll() { const v = await fn(); if (v || Date.now() - t0 > 5000) return v; await new Promise((r) => setTimeout(r, 50)); return poll(); })(); };
async function openFiles(page) {
  if (await page.locator('.seg button[data-view="files"]').isVisible()) await page.click('.seg button[data-view="files"]');
  else { await page.click('#viewBtn'); await page.click('#viewMenu [data-view="files"]'); } // phones switch views from the title's menu (#450)
  await page.locator('#fxMain [role="listbox"], #fxMain [role="tree"]').waitFor();
}
async function place(page, label) {
  await page.click('#fxPlaces');
  await page.locator('#fxMenu').waitFor();
  await page.locator('#fxMenu [data-act="place"]').filter({ has: page.locator('.cm-l', { hasText: new RegExp(`^${label}$`) }) }).click();
}
async function menuActs(page, target) {
  await page.click(target, { button: 'right' });
  await page.locator('#fxMenu').waitFor();
  return page.$$eval('#fxMenu .cm-opt', (bs) => Object.fromEntries(bs.map((b) => [b.dataset.act, { on: !b.disabled, title: b.title }])));
}

test('opens at the project; ↑ Parent, Alt+↑ and Backspace climb to / and stop there; a reload opens the project again', { skip, timeout: 60000 }, async () => {
  const { page, errors, lists, ctx } = await open();
  await openFiles(page);
  assert.equal(lists[0], '', 'the first listing is the project');
  await at(page, '/', 'home', 'u', 'proj');
  assert.equal(await page.textContent('#fxTitle'), 'proj');
  assert.equal(await page.getAttribute('#fxPath .fx-crumb:last-child', 'title'), `${P} (project)`);

  await page.click('#fxUp');
  await at(page, '/', 'home', 'u');
  assert.equal(await page.getAttribute(rowSel('proj'), 'aria-selected'), 'true', 'the folder climbed out of stays selected');
  await page.keyboard.press('Alt+ArrowUp');
  await at(page, '/', 'home');
  await page.keyboard.press('Backspace');
  await at(page, '/');
  assert.equal(await page.isDisabled('#fxUp'), true, 'no parent above /');
  assert.equal(await page.textContent('#fxTitle'), '/');
  const n = lists.length;
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Alt+ArrowUp');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(lists.length, n, 'nothing is listed above /');
  await at(page, '/');

  // The last folder is kept while the page lives (leaving the tab and coming back) but not across a reload.
  await page.click('#fxPath .fx-crumb:has-text("/")'); // same folder: a no-op
  await page.dblclick(rowSel('tmp'));
  await at(page, '/', 'tmp');
  await page.click('.seg button[data-view="chat"]');
  await openFiles(page);
  await at(page, '/', 'tmp');
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
  await openFiles(page);
  await at(page, '/', 'home', 'u', 'proj');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Places and a typed path (⌘L, with completion) navigate; a missing or forbidden folder says why inline', { skip, timeout: 60000 }, async () => {
  const { page, errors, ctx } = await open();
  await openFiles(page);
  await at(page, '/', 'home', 'u', 'proj');
  await page.click('#fxPlaces');
  await page.locator('#fxMenu').waitFor();
  assert.deepEqual(await page.$$eval('#fxMenu .cm-opt .cm-l', (ls) => ls.map((l) => l.textContent)), ['Project', 'Home', '/', '/tmp', 'Go to folder…']);
  await page.locator('#fxMenu [data-act="place"]').filter({ has: page.locator('.cm-l', { hasText: /^\/tmp$/ }) }).click();
  await at(page, '/', 'tmp');
  await place(page, 'Home');
  await at(page, '/', 'home', 'u');
  await place(page, 'Project');
  await at(page, '/', 'home', 'u', 'proj');

  await page.keyboard.press('ControlOrMeta+l');
  await page.locator('#fxGotoBar:not([hidden])').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'fxGoto');
  assert.equal(await page.inputValue('#fxGoto'), '~/proj/', 'it starts at this folder');
  await page.fill('#fxGoto', '~/');
  await page.waitForFunction(() => document.querySelectorAll('#fxSugg .fx-sug').length === 2);
  assert.deepEqual(await page.$$eval('#fxSugg .fx-sug', (s) => s.map((x) => x.textContent)), ['docs', 'proj'], 'folders of ~, hidden ones left out');
  await page.fill('#fxGoto', '~/pr');
  await page.waitForFunction(() => document.querySelectorAll('#fxSugg .fx-sug').length === 1);
  await page.keyboard.press('Tab');
  assert.equal(await page.inputValue('#fxGoto'), '~/proj/');
  await page.waitForFunction(() => [...document.querySelectorAll('#fxSugg .fx-sug')].map((x) => x.textContent).join() === 'src');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await at(page, '/', 'home', 'u', 'proj', 'src');
  assert.equal(await page.locator('#fxGotoBar').isHidden(), true);

  await page.keyboard.press('ControlOrMeta+l');
  await page.fill('#fxGoto', '/etc');
  await page.keyboard.press('Enter');
  await at(page, '/', 'etc');
  await page.keyboard.press('ControlOrMeta+l');
  await page.fill('#fxGoto', `${P}/src/lib`);
  await page.keyboard.press('Enter');
  await at(page, '/', 'home', 'u', 'proj', 'src', 'lib');
  await page.keyboard.press('ControlOrMeta+l');
  await page.fill('#fxGoto', '../..');
  await page.keyboard.press('Enter');
  await at(page, '/', 'home', 'u', 'proj');

  await page.keyboard.press('ControlOrMeta+l');
  await page.fill('#fxGoto', '/nope');
  await page.keyboard.press('Enter');
  await page.locator('#fxMain .fx-empty:has-text("Couldn\'t open this folder")').waitFor();
  assert.match(await page.textContent('#fxMain'), /Not found/);
  await at(page, '/', 'nope');

  await place(page, '/');
  await at(page, '/');
  assert.equal(await page.getAttribute(rowSel('root'), 'class').then((c) => c.includes('fx-noread')), true, 'an unreadable folder is dimmed');
  await page.dblclick(rowSel('root'));
  await page.locator('#fxMain .fx-denied').waitFor();
  assert.match(await page.textContent('#fxMain .fx-denied'), /Permission denied/);
  await at(page, '/', 'root');
  await page.click('#fxUp');
  await at(page, '/');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a protected file shows a lock and opening it says "Protected file: contents hidden" without fetching it', { skip, timeout: 60000 }, async () => {
  const { page, errors, raws, ctx } = await open();
  await openFiles(page);
  await page.locator(`${rowSel('server.pem')} .fx-lock`).waitFor();
  assert.equal(await page.locator(`${rowSel('README.md')} .fx-lock`).count(), 0);
  await page.dblclick(rowSel('server.pem'));
  await page.locator('#fxQL:not([hidden])').waitFor();
  await page.locator('#fxQLBody:has-text("Protected file: contents hidden")').waitFor();
  assert.equal(await page.locator('#fxQLOpen').isHidden(), true, 'no way to open it in a tab');
  await page.keyboard.press('Escape');
  const acts = await menuActs(page, rowSel('server.pem'));
  assert.equal(acts.copy.on || acts.cut.on || acts.zip.on, false, 'it cannot be copied, moved or zipped');
  assert.match(acts.cut.title, /Protected/);
  await page.keyboard.press('Escape');
  await page.dblclick(rowSel('README.md'));
  await page.locator('#fxQLBody:has-text("secret")').waitFor();
  assert.deepEqual(raws, [`${P}/README.md`], 'only the unprotected file was fetched');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a read-only location shows a tag and disables write actions (with the reason); copies still paste elsewhere', { skip, timeout: 60000 }, async () => {
  const { page, errors, ops, ctx } = await open();
  await openFiles(page);
  assert.equal(await page.locator('#fxRO').isHidden(), true, 'the project is writable');
  let acts = await menuActs(page, rowSel('README.md'));
  assert.deepEqual([acts.copy.on, acts.cut.on, acts.zip.on], [true, true, true]);
  await page.keyboard.press('Escape');

  await place(page, '/');
  await at(page, '/');
  assert.equal(await page.locator('#fxRO').isVisible(), true, '/ is read-only even though /tmp in it is writable');
  await page.dblclick(rowSel('etc'));
  await at(page, '/', 'etc');
  assert.equal(await page.locator('#fxRO').isVisible(), true);
  assert.match(await page.getAttribute('#fxRO', 'title'), /Read-only location/);
  acts = await menuActs(page, rowSel('hosts'));
  assert.equal(acts.copy.on, true, 'copying out is fine');
  for (const a of ['cut', 'paste', 'zip', 'rename', 'delete']) {
    assert.equal(acts[a].on, false, `${a} is disabled`);
    assert.match(acts[a].title, /Read-only location/, `${a} says why`);
  }
  assert.match(await page.textContent('#fxMenu .fx-menu-note'), /Read-only location/);
  await page.click('#fxMenu [data-act="copy"]');
  acts = await menuActs(page, rowSel('passwd'));
  assert.equal(acts.paste.on, false, 'nothing pastes into a read-only folder');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+v');
  await page.keyboard.press('ControlOrMeta+x');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(ops.length, 0, '⌘V and ⌘X do nothing here');

  await place(page, 'Project');
  await at(page, '/', 'home', 'u', 'proj');
  assert.equal(await page.locator('#fxRO').isHidden(), true);
  await page.click(rowSel('README.md'));
  await page.keyboard.press('ControlOrMeta+v');
  await until(() => ops.length === 1);
  assert.deepEqual(ops[0], { op: 'copy', body: { paths: ['/etc/hosts'], dest: P } });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('375px: the path folds its middle folders into … and a tap unfolds them', { skip, timeout: 60000 }, async () => {
  const { page, errors, ctx } = await open({ width: 375, height: 667 });
  await openFiles(page);
  await page.keyboard.press('ControlOrMeta+l');
  await page.fill('#fxGoto', `${P}/src/lib`);
  await page.keyboard.press('Enter');
  await at(page, '/', 'home', 'u', 'proj', 'src', 'lib');
  const shown = () => page.$$eval('#fxPath :is(.fx-crumb, .fx-ell)', (bs) => bs.filter((b) => b.offsetParent).map((b) => b.textContent));
  assert.deepEqual(await shown(), ['/', '…', 'src', 'lib']);
  assert.equal(await page.evaluate(() => document.getElementById('filesView').scrollWidth - document.getElementById('filesView').clientWidth), 0, 'no sideways scroll');
  await page.click('#fxPath .fx-ell');
  assert.deepEqual(await shown(), ['/', 'home', 'u', 'proj', 'src', 'lib']);
  await page.click('#fxPath .fx-crumb:has-text("u")');
  await at(page, '/', 'home', 'u');
  assert.deepEqual(errors, []);
  await ctx.close();
});
