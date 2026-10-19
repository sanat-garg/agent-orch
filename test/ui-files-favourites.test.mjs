// Files view (files.js) favourite folders in the Places menu, in a real browser against server.mjs (temporary HOME, data and
// port; no orchestrator), with /api/files/list mocked per chat (chats c0 and c1 share a project at /home/u/proj, c2 has its
// own at /home/u/other): saving the current folder neither navigates nor touches files, favourites survive a reload, open
// by ordinary navigation and are removed with their ×; they are shared by the chats of one project and kept apart from
// another project's; a favourite whose folder vanished says so and stays removable (on a phone-sized viewport too); and
// storage the browser refuses gives clear feedback.
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
const PASSWORD = 'files-favs-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch {
  try { browser = await chromium.launch({ executablePath: findBrowser() || undefined }); } catch (e) { skip = `no Chromium: ${e.message.split('\n')[0]}`; }
}
let child, base, root, home, dataDir, cookie;

const P = '/home/u/proj', Q = '/home/u/other';
const f = (name) => ({ name, dir: false, type: 'file', size: 10, mtime: 1.7e12, hidden: false, isSymlink: false, readable: true, writable: true, protected: false });
const d = (name) => ({ ...f(name), dir: true, type: 'dir', size: null });
const TREE = {
  '/home/u': [d('proj'), d('other')],
  [P]: [f('README.md'), d('src'), d('docs')],
  [`${P}/src`]: [f('app.js'), d('lib')],
  [`${P}/src/lib`]: [f('util.js')],
  [`${P}/docs`]: [f('guide.md')],
  [Q]: [f('notes.txt'), d('art')],
  [`${Q}/art`]: [f('logo.svg')],
};
const placesFor = (proj) => [{ label: 'Project', path: proj }, { label: 'Home', path: '/home/u' }, { label: '/', path: '/' }, { label: '/tmp', path: '/tmp' }];

before(async () => {
  if (skip) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-filesfavs-'));
  home = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  for (const x of [home, dataDir, path.join(root, 'proj'), path.join(root, 'other')]) fs.mkdirSync(x, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const convo = (id, title, dir, t) => ({ id, title, cwd: path.join(root, dir), mode: 'default', model: '', createdAt: t, updatedAt: t });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([convo('c0', 'Demo', 'proj', 3), convo('c1', 'Demo again', 'proj', 2), convo('c2', 'Other', 'other', 1)]));
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

// A page with the files API mocked: `lists` records each listed dir ('' = the chat's project), `ops` every other files
// write (a POST). Folders in `mock.gone` answer 404. `init` runs in the page before the app (e.g. to break localStorage).
async function open({ viewport = { width: 1280, height: 860 }, mobile = false, hash = 'c0', init } = {}) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript(() => localStorage.setItem('cw.lastSeen', String(Date.now())));
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [], lists = [], ops = [], mock = { gone: new Set() };
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/files/**', (route) => {
    const u = new URL(route.request().url());
    if (!u.pathname.endsWith('/list')) { if (route.request().method() !== 'GET') ops.push(u.pathname); return route.fulfill({ json: {} }); }
    const asked = u.searchParams.get('dir'), proj = u.searchParams.get('cid') === 'c2' ? Q : P, dir = asked || proj;
    lists.push(asked);
    if (!(dir in TREE) || mock.gone.has(dir)) return route.fulfill({ status: 404, json: { error: 'Not found' } });
    route.fulfill({ json: { dir, parent: dir.replace(/\/[^/]*$/, '') || '/', places: placesFor(proj), truncated: false,
      entries: TREE[dir].map((e) => ({ ...e, path: `${dir}/${e.name}` })), name: dir.split('/').pop(), path: dir } });
  });
  await page.goto(`${base}/#${hash}`);
  await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
  return { page, errors, lists, ops, mock, ctx };
}
const rowSel = (name) => `#fxMain :is([role="option"], [role="treeitem"]):has-text("${name}")`;
const at = (page, ...parts) => page.waitForFunction((want) => [...document.querySelectorAll('#fxPath .fx-crumb')].map((b) => b.textContent).join('|') === want, parts.join('|'), { timeout: 5000 });
const toasts = (page) => page.$$eval('#toasts .toast:not(.toast-out) .toast-msg', (ts) => ts.map((t) => t.textContent));
const until = (fn) => { const t0 = Date.now(); return (async function poll() { const v = await fn(); if (v || Date.now() - t0 > 5000) return v; await new Promise((r) => setTimeout(r, 50)); return poll(); })(); };
async function openFiles(page) {
  if (await page.locator('.seg button[data-view="files"]').isVisible()) await page.click('.seg button[data-view="files"]');
  else { await page.click('#viewBtn'); await page.click('#viewMenu [data-view="files"]'); } // phones switch views from the title's menu
  await page.locator('#fxMain [role="listbox"], #fxMain [role="tree"]').waitFor();
}
async function places(page) {
  if (!(await page.locator('#fxMenu[data-places]').count())) await page.click('#fxPlaces');
  await page.locator('#fxMenu[data-places]').waitFor();
}
// The Places menu's favourites as [name, hint], and its add/remove item's label (null when absent).
async function favs(page) {
  await places(page);
  return page.$$eval('#fxMenu .fx-fav [data-act="fav"]', (bs) => bs.map((b) => [b.querySelector('.cm-l').textContent, b.querySelector('.cm-h')?.textContent || '']));
}
const favItem = (page) => page.$eval('#fxMenu', (m) => { const b = m.querySelector('[data-act="favadd"], [data-act="favdel"]'); return b && { act: b.dataset.act, label: b.textContent, on: !b.disabled }; });
const openFav = (page, name) => page.locator('#fxMenu .fx-fav [data-act="fav"]').filter({ has: page.locator('.cm-l', { hasText: new RegExp(`^${name}$`) }) }).click();
const closeMenu = (page) => page.keyboard.press('Escape');

test('saving a folder neither navigates nor touches files; it survives a reload, opens, is shared by the project\'s chats and kept apart from another project\'s, and × removes it', { skip, timeout: 90000 }, async () => {
  const { page, errors, lists, ops, ctx } = await open();
  await openFiles(page);
  await at(page, '/', 'home', 'u', 'proj');
  assert.deepEqual(await favs(page), [], 'no favourites yet');
  assert.deepEqual(await favItem(page), { act: 'favadd', label: 'Add “proj” to Favourites', on: true });
  await closeMenu(page);

  await page.dblclick(rowSel('src'));
  await at(page, '/', 'home', 'u', 'proj', 'src');
  await places(page);
  const before = lists.length;
  await page.click('#fxMenu [data-act="favadd"]');
  assert.ok(await until(async () => (await toasts(page)).includes('Added “src” to Favourites')));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(lists.length, before, 'saving lists nothing');
  assert.deepEqual(ops, [], 'saving sends no file operation');
  await at(page, '/', 'home', 'u', 'proj', 'src');
  assert.deepEqual(await favs(page), [['src', '~/proj']]);
  assert.deepEqual(await favItem(page), { act: 'favdel', label: 'Remove “src” from Favourites', on: true }, 'the folder on show is already saved');
  assert.equal(await page.getAttribute('#fxMenu .fx-fav [data-act="fav"]', 'aria-current'), 'location');
  await closeMenu(page);

  // Saving again from another visit doesn't duplicate it, and the parent folder is a second favourite.
  await page.click('#fxUp');
  await at(page, '/', 'home', 'u', 'proj');
  await places(page);
  await page.click('#fxMenu [data-act="favadd"]');
  assert.deepEqual(await favs(page), [['src', '~/proj'], ['proj', '~']]);
  await closeMenu(page);

  // A reload keeps them; opening one is ordinary navigation, and history still walks back.
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
  await openFiles(page);
  await at(page, '/', 'home', 'u', 'proj');
  assert.deepEqual(await favs(page), [['src', '~/proj'], ['proj', '~']], 'favourites survive a reload');
  lists.length = 0;
  await openFav(page, 'src');
  await at(page, '/', 'home', 'u', 'proj', 'src');
  assert.deepEqual(lists, [`${P}/src`], 'it lists the saved path');
  await page.keyboard.press('Alt+ArrowLeft');
  await at(page, '/', 'home', 'u', 'proj');

  // Another chat of the same project shares them; another project has its own (none yet), then its own one.
  await page.evaluate(() => { location.hash = '#c1'; });
  await openFiles(page);
  await at(page, '/', 'home', 'u', 'proj');
  assert.deepEqual(await favs(page), [['src', '~/proj'], ['proj', '~']], 'shared between chats of the project');
  await closeMenu(page);
  await page.evaluate(() => { location.hash = '#c2'; });
  await openFiles(page);
  await at(page, '/', 'home', 'u', 'other');
  assert.deepEqual(await favs(page), [], 'another project has its own favourites');
  await closeMenu(page);
  await page.dblclick(rowSel('art'));
  await at(page, '/', 'home', 'u', 'other', 'art');
  await places(page);
  await page.click('#fxMenu [data-act="favadd"]');
  assert.deepEqual(await favs(page), [['art', '~/other']]);
  await closeMenu(page);
  await page.evaluate(() => { location.hash = '#c0'; });
  await openFiles(page);
  assert.deepEqual(await favs(page), [['src', '~/proj'], ['proj', '~']], "the other project's favourite stays there");

  // × removes one in place: the menu stays open on the rest, nothing navigates, and it stays gone after a reload.
  const where = await page.$$eval('#fxPath .fx-crumb', (bs) => bs.map((b) => b.textContent));
  await page.click('#fxMenu .fx-fav:has-text("src") [data-act="favx"]');
  await page.locator('#fxMenu[data-places]').waitFor();
  assert.deepEqual(await favs(page), [['proj', '~']]);
  assert.ok((await toasts(page)).includes('Removed “src” from Favourites'));
  await at(page, ...where);
  assert.deepEqual(ops, []);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
  await openFiles(page);
  assert.deepEqual(await favs(page), [['proj', '~']], 'removed for good');
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('cw.files.favs:')));
  assert.equal(keys.length, 2, 'one key per project');
  assert.ok(keys.every((k) => /^cw\.files\.favs:[^:]+:\//.test(k)), `keyed by user and project: ${keys}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a favourite whose folder vanished says so, keeps ‹ Parent and stays removable, on a phone-sized viewport', { skip, timeout: 60000 }, async () => {
  const { page, errors, mock, ctx } = await open({ viewport: { width: 390, height: 844 }, mobile: true });
  await openFiles(page);
  await at(page, '/', 'home', 'u', 'proj');
  await page.locator(rowSel('docs')).dblclick();
  await at(page, '/', 'home', 'u', 'proj', 'docs');
  await places(page);
  await page.click('#fxMenu [data-act="favadd"]');
  await page.click('#fxUp');
  await at(page, '/', 'home', 'u', 'proj');

  mock.gone.add(`${P}/docs`);
  await places(page);
  const fit = await page.$eval('#fxMenu', (m) => { const r = m.getBoundingClientRect(), x = m.querySelector('[data-act="favx"]').getBoundingClientRect();
    return { inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, xIn: x.left >= r.left && x.right <= r.right, xw: x.width, xh: x.height }; });
  assert.ok(fit.inside, 'the menu fits the screen');
  assert.ok(fit.xIn && fit.xw >= 44 && fit.xh >= 44, `× is a full touch target inside the menu: ${JSON.stringify(fit)}`);
  await openFav(page, 'docs');
  await page.locator('#fxMain .fx-fav-missing').waitFor();
  assert.equal(await page.textContent('#fxMain .fx-fav-missing strong'), 'This favourite folder is missing');
  await at(page, '/', 'home', 'u', 'proj', 'docs');
  assert.deepEqual(await favs(page), [['docs', 'Missing']], 'the menu marks it missing but keeps it');
  assert.ok(await page.$('#fxMenu .fx-fav-gone'));
  assert.deepEqual(await favItem(page), { act: 'favadd', label: 'Add this folder to Favourites', on: false }, "a folder that didn't open can't be saved");
  await closeMenu(page);

  // ‹ Parent still climbs out; coming back, the empty state removes it.
  await page.click('#fxUp');
  await at(page, '/', 'home', 'u', 'proj');
  await page.keyboard.press('Alt+ArrowLeft');
  await page.locator('#fxFavMissingRemove').click();
  assert.ok(await until(async () => (await toasts(page)).includes('Removed “docs” from Favourites')));
  await page.waitForFunction(() => !document.getElementById('fxFavMissingRemove'));
  assert.match(await page.textContent('#fxMain .fx-empty'), /Couldn't open this folder/);
  assert.deepEqual(await favs(page), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("storage the browser refuses says so: saving fails with a toast, unreadable storage disables favourites", { skip, timeout: 60000 }, async () => {
  const breakSet = () => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('cw.files.favs')) throw new DOMException('quota', 'QuotaExceededError'); return set.call(this, k, v); }; };
  let { page, errors, lists, ctx } = await open({ init: breakSet });
  await openFiles(page);
  await at(page, '/', 'home', 'u', 'proj');
  await places(page);
  const n = lists.length;
  await page.click('#fxMenu [data-act="favadd"]');
  assert.ok(await until(async () => (await toasts(page)).some((t) => /Couldn't save the favourite: this browser's storage is unavailable/.test(t))));
  assert.deepEqual(await favs(page), []);
  assert.equal(lists.length, n);
  assert.deepEqual(errors, []);
  await ctx.close();

  const breakGet = () => { const get = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { if (String(k).startsWith('cw.files.favs')) throw new DOMException('denied', 'SecurityError'); return get.call(this, k); }; };
  ({ page, errors, ctx } = await open({ init: breakGet }));
  await openFiles(page);
  await places(page);
  assert.deepEqual((await favItem(page)).on, false, 'Add is disabled');
  assert.match(await page.textContent('#fxMenu .fx-menu-note'), /Favourites are unavailable/);
  assert.deepEqual(errors, []);
  await ctx.close();
});
