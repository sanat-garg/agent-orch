// Files view (files.js) back button and uploads in a real browser against server.mjs (temporary HOME, data and port; no
// orchestrator), with /api/files/list and /api/files/upload mocked by the page (absolute paths, the project at /w/proj):
// - one ‹ button goes to the parent folder (no separate Back/Forward buttons; ⌥← still walks history).
// - Upload → Files… posts each file raw to /api/files/upload?dir=&path=&overwrite=0 and refreshes; it is off in a read-only folder.
// - a folder dropped from the desktop (webkitGetAsEntry) posts its nested paths, onto a folder row into that folder.
// - a 409 asks Replace / Keep both / Skip once per batch.
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
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'files-upload-password';
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() }; // the MacBook worker's LaunchDaemon needs a shim (helpers/mac-chromium.mjs)
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, root, home, dataDir, cookie;

const P = '/w/proj', RO = '/w/ro';
const f = (name, size = 10) => ({ name, dir: false, type: 'file', size, mtime: 1.7e12, hidden: false, readable: true, writable: true });
const d = (name) => ({ name, dir: true, type: 'dir', size: null, mtime: 1.7e12, hidden: false, readable: true, writable: true });
const TREE = {
  '/w': [d('proj'), d('ro')],
  [P]: [f('README.md'), d('src'), f('a.zip', 300)],
  [`${P}/src`]: [f('app.js')],
  [RO]: [f('x.txt')],
};
const PLACES = [{ label: 'Project', path: P }, { label: 'Home', path: '/w' }, { label: '/', path: '/' }, { label: '/tmp', path: '/tmp' }];

before(async () => {
  if (skip) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-filesupl-'));
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

// A page with the files API mocked: `ups` records each upload as {cid, dir, path, overwrite, body}; a name already in
// TREE answers 409 {error: 'exists'} unless overwrite=1.
async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript(() => { localStorage.setItem('cw.lastSeen', String(Date.now())); localStorage.setItem('cw.files.view', 'list'); });
  const page = await ctx.newPage();
  const errors = [], lists = [], ups = [];
  page.on('pageerror', (e) => { if (!/renderMetrics/.test(e.stack)) errors.push(e.message); });
  await page.route('**/api/files/list?*', (route) => {
    const u = new URL(route.request().url()), asked = u.searchParams.get('dir'), dir = asked || P;
    lists.push(asked);
    if (!(dir in TREE)) return route.fulfill({ status: 404, json: { error: 'Not found' } });
    route.fulfill({ json: { dir, parent: dir.replace(/\/[^/]*$/, '') || '/', entries: TREE[dir].map((e) => ({ ...e, path: `${dir}/${e.name}` })), places: PLACES,
      name: dir.split('/').pop(), path: dir, truncated: false, writable: dir !== RO } });
  });
  await page.route('**/api/files/upload?*', async (route) => {
    const u = new URL(route.request().url()), q = Object.fromEntries(u.searchParams);
    const up = { cid: q.cid, dir: q.dir, path: q.path, overwrite: q.overwrite, body: route.request().postDataBuffer()?.toString() ?? '' };
    ups.push(up);
    await new Promise((r) => setTimeout(r, 100));
    const taken = (TREE[q.dir] || []).some((e) => e.name === q.path);
    if (taken && q.overwrite !== '1') return route.fulfill({ status: 409, json: { error: 'exists' } });
    route.fulfill({ json: { saved: `${q.dir}/${q.path}` } });
  });
  await page.goto(`${base}/#c0`);
  await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
  await page.click('.seg button[data-view="files"]');
  await page.locator('#fxMain [role="tree"] [data-i]').first().waitFor();
  return { page, errors, lists, ups, ctx };
}
const rowSel = (name) => `#fxMain [role="treeitem"]:has(.fx-nt:text-is("${name}"))`;
const crumbs = (page) => page.$$eval('#fxPath .fx-crumb', (bs) => bs.map((b) => b.textContent));
const toasts = (page) => page.$$eval('#toasts .toast:not(.toast-out) .toast-msg', (ts) => ts.map((t) => t.textContent));
const until = (fn) => { const t0 = Date.now(); return (async function poll() { const v = await fn(); if (v || Date.now() - t0 > 5000) return v; await new Promise((r) => setTimeout(r, 50)); return poll(); })(); };
async function pickFiles(page, files, act = 'upfiles') {
  await page.click('#fxUpload');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(`#fxMenu [data-act="${act}"]`)]);
  await chooser.setFiles(files.map(([name, text]) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })));
}

test('one ‹ button goes to the parent folder; there are no Back/Forward buttons; ⌥← still goes back', { skip, timeout: 60000 }, async () => {
  const { page, errors, ctx } = await open();
  assert.equal(await page.locator('#fxBack, #fxFwd').count(), 0, 'no separate Back/Forward buttons');
  assert.equal(await page.locator('.fx-nav button').count(), 1);
  assert.equal(await page.getAttribute('#fxUp', 'aria-label'), 'Parent folder');
  await page.dblclick(rowSel('src'));
  await page.waitForFunction(() => document.querySelectorAll('#fxPath .fx-crumb').length === 4);
  await page.click('#fxUp');
  await page.waitForFunction(() => document.querySelectorAll('#fxPath .fx-crumb').length === 3);
  assert.deepEqual(await crumbs(page), ['/', 'w', 'proj']);
  assert.equal(await page.getAttribute(rowSel('src'), 'aria-selected'), 'true', 'the folder climbed out of stays selected');
  await page.click('#fxUp');
  await page.waitForFunction(() => document.querySelectorAll('#fxPath .fx-crumb').length === 2);
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForFunction(() => document.querySelectorAll('#fxPath .fx-crumb').length === 3);
  assert.deepEqual(await crumbs(page), ['/', 'w', 'proj'], '⌥← walks the history');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Upload → Files… posts each file raw with the right query, shows progress, refreshes; off in a read-only folder', { skip, timeout: 60000 }, async () => {
  const { page, errors, lists, ups, ctx } = await open();
  assert.equal(await page.isDisabled('#fxUpload'), false);
  await page.click('#fxUpload');
  assert.deepEqual(await page.$$eval('#fxMenu .cm-opt', (bs) => bs.map((b) => b.textContent)), ['Files…', 'Folder…']);
  assert.equal(await page.getAttribute('#fxUpDir', 'webkitdirectory'), '');
  await page.keyboard.press('Escape');
  const n = lists.length;
  await pickFiles(page, [['one.txt', 'first'], ['two.txt', 'second!']]);
  await page.locator('#fxUpl:not([hidden])').waitFor();
  assert.ok(await until(async () => /Uploading \d of 2 · \d+%/.test(await page.textContent('#fxUplText'))), 'overall progress');
  assert.equal(await page.locator('#fxUplList .fx-upl-row').count(), 2, 'a row per file');
  await until(() => ups.length === 2);
  assert.deepEqual(ups.sort((a, b) => a.path.localeCompare(b.path)), [
    { cid: 'c0', dir: P, path: 'one.txt', overwrite: '0', body: 'first' },
    { cid: 'c0', dir: P, path: 'two.txt', overwrite: '0', body: 'second!' },
  ]);
  await page.locator('#fxUpl').waitFor({ state: 'hidden' });
  assert.ok(await until(async () => (await toasts(page)).some((t) => /Uploaded 2 files to proj/.test(t))));
  assert.ok(await until(() => lists.length > n), 'the listing refreshes');

  await page.click('#fxUp');
  await page.waitForFunction(() => document.querySelectorAll('#fxPath .fx-crumb').length === 2);
  await page.dblclick(rowSel('ro'));
  await page.locator('#fxRO:not([hidden])').waitFor();
  assert.equal(await page.isDisabled('#fxUpload'), true, 'no uploads into a read-only folder');
  assert.match(await page.getAttribute('#fxUpload', 'title'), /Read-only/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// A folder dropped from the desktop: FileSystemEntry fakes stand in for what Chromium hands a real drop.
async function dropFolder(page, target) {
  return page.locator(target).first().evaluate((node) => {
    const file = (full, text) => ({ isFile: true, isDirectory: false, name: full.split('/').pop(), fullPath: full, file: (ok) => ok(new File([text], full.split('/').pop())) });
    const dir = (full, kids) => ({ isFile: false, isDirectory: true, name: full.split('/').pop(), fullPath: full,
      createReader: () => { let done = false; return { readEntries: (ok) => { ok(done ? [] : kids); done = true; } }; } });
    const tree = dir('/photos', [file('/photos/a.png', 'A'), dir('/photos/sub', [file('/photos/sub/b.txt', 'BB')])]);
    const dt = { types: ['Files'], dropEffect: '', items: [{ kind: 'file', webkitGetAsEntry: () => tree }, { kind: 'file', webkitGetAsEntry: () => file('/loose.txt', 'L') }], files: [] };
    const fire = (type) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, 'dataTransfer', { value: dt }); node.dispatchEvent(e); };
    fire('dragenter');
    const shown = !document.getElementById('fxDrop').hidden && document.getElementById('fxDropText').textContent;
    fire('drop');
    return { shown, after: !document.getElementById('fxDrop').hidden };
  });
}

test('a dropped folder posts its nested paths, into the current folder or the folder row it lands on', { skip, timeout: 60000 }, async () => {
  const { page, errors, ups, ctx } = await open();
  const r = await dropFolder(page, '#fxMain [role="tree"]');
  assert.deepEqual(r, { shown: 'Drop to upload to proj', after: false }, 'the overlay names the folder, then goes');
  await until(() => ups.length === 3);
  assert.deepEqual(ups.map(({ dir, path, body }) => ({ dir, path, body })).sort((a, b) => a.path.localeCompare(b.path)), [
    { dir: P, path: 'loose.txt', body: 'L' },
    { dir: P, path: 'photos/a.png', body: 'A' },
    { dir: P, path: 'photos/sub/b.txt', body: 'BB' },
  ]);
  await page.locator('#fxUpl').waitFor({ state: 'hidden' });

  const r2 = await dropFolder(page, rowSel('src'));
  assert.equal(r2.shown, 'Drop to upload to src');
  await until(() => ups.length === 6);
  assert.deepEqual(ups.slice(3).map((u) => `${u.dir}/${u.path}`).sort(), [`${P}/src/loose.txt`, `${P}/src/photos/a.png`, `${P}/src/photos/sub/b.txt`]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a 409 asks Replace / Keep both / Skip once per batch', { skip, timeout: 60000 }, async () => {
  const { page, errors, ups, ctx } = await open();
  await pickFiles(page, [['README.md', 'r'], ['a.zip', 'z'], ['new.txt', 'n']]);
  await page.locator('#fxConflict').waitFor();
  assert.match(await page.textContent('#fxConflict h2'), /already exists in “proj”/);
  assert.deepEqual(await page.$$eval('#fxConflict [data-pick]', (bs) => bs.map((b) => b.textContent)), ['Skip', 'Keep both', 'Replace']);
  await until(() => ups.length === 3); // both conflicts are in before the answer
  await page.click('#fxConflict [data-pick="rename"]');
  await until(() => ups.length === 5);
  await page.locator('#fxUpl').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#fxConflict').count(), 0, 'asked once for the whole batch');
  assert.deepEqual(ups.slice(3).map((u) => [u.path, u.overwrite]).sort(), [['README 2.md', '0'], ['a 2.zip', '0']]);

  ups.length = 0;
  await pickFiles(page, [['README.md', 'r2'], ['a.zip', 'z2']]);
  await page.locator('#fxConflict').waitFor();
  await page.click('#fxConflict [data-pick="replace"]');
  await until(() => ups.length === 4);
  assert.deepEqual(ups.slice(2).map((u) => [u.path, u.overwrite]).sort(), [['README.md', '1'], ['a.zip', '1']]);
  await page.locator('#fxUpl').waitFor({ state: 'hidden' });

  ups.length = 0;
  await pickFiles(page, [['README.md', 'r3']]);
  await page.locator('#fxConflict').waitFor();
  await page.click('#fxConflict [data-pick="skip"]');
  await page.locator('#fxUpl').waitFor({ state: 'hidden' });
  assert.equal(ups.length, 1, 'Skip sends nothing more');
  assert.deepEqual(errors, []);
  await ctx.close();
});
