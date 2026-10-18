// Files view (files.js fxEdit) code editor in a real browser against server.mjs (temporary HOME, data, project and port;
// no orchestrator), so every save really lands on disk:
// - Quick Look's Edit (and E) opens CodeMirror with syntax colours; typing marks it Edited; ⌘S/Ctrl+S saves to disk.
// - a file changed on disk since it was opened asks before overwriting; closing with unsaved changes asks
//   Save / Don't Save / Cancel; the context menu has Edit (off for images); New file… opens the new file in the editor.
// - on a phone the editor fills the screen with 16px text (no zoom on focus) and 44px Save.
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
const PASSWORD = 'files-edit-password';
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() }; // the MacBook worker's LaunchDaemon needs a shim (helpers/mac-chromium.mjs)
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, root, home, dataDir, proj, cookie;

before(async () => {
  if (skip) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-filesedit-'));
  home = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  proj = path.join(root, 'proj');
  for (const d of [home, dataDir, path.join(proj, 'docs')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(proj, 'app.js'), 'const greeting = "hi";\nfunction hello() {\n  return greeting;\n}\n');
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(proj, 'pic.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: 'c0', title: 'Demo', cwd: proj, mode: 'default', model: '', createdAt: 1, updatedAt: 1 }]));
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
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

async function open(viewport = { width: 1280, height: 860 }, mobile = false) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript(() => { localStorage.setItem('cw.lastSeen', String(Date.now())); localStorage.setItem('cw.files.view', 'list'); });
  const page = await ctx.newPage();
  const errors = [], dialogs = [];
  // Server details' own charts can't read load averages on a macOS head (renderMetrics): not this view's concern.
  page.on('pageerror', (e) => { if (!/renderMetrics/.test(e.stack)) errors.push(e.message); });
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await page.goto(`${base}/#c0`);
  await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
  if (await page.locator('.seg button[data-view="files"]').isVisible()) await page.click('.seg button[data-view="files"]');
  else { await page.click('#viewBtn'); await page.click('#viewMenu [data-view="files"]'); } // phones switch views from the title's menu (#450)
  await page.locator('#fxMain [role="tree"] [data-i]').first().waitFor();
  return { page, errors, dialogs, ctx };
}
const rowSel = (name) => `#fxMain [role="treeitem"]:has(.fx-nt:text-is("${name}"))`;
const read = (f) => fs.readFileSync(path.join(proj, f), 'utf8');
const KEY = process.platform === 'darwin' ? 'Meta' : 'Control';
async function edit(page, name) {
  await page.click(rowSel(name));
  await page.keyboard.press('Space');
  await page.locator('#fxQLEdit').click();
  await page.locator('#fxQLBody .cm-editor .cm-content').waitFor();
}

test('Edit opens a code editor with syntax colours; typing marks it Edited and Ctrl/Cmd+S saves to disk', { skip }, async () => {
  const { page, errors, ctx } = await open();
  await edit(page, 'app.js');
  assert.ok(await page.locator('#fxQL.editing').isVisible());
  await page.locator('#fxQLBody .tok-keyword').first().waitFor({ timeout: 5000 }); // JavaScript is highlighted (its chunk loads lazily)
  assert.equal(await page.locator('#fxEdSave').isDisabled(), true, 'nothing to save yet');
  await page.locator('#fxQLBody .cm-content').click();
  await page.keyboard.press(`${KEY}+End`);
  await page.keyboard.type('// edited\n');
  assert.equal(await page.locator('#fxEdState').textContent(), 'Edited');
  await page.keyboard.press(`${KEY}+s`);
  await page.waitForFunction(() => document.getElementById('fxEdState').textContent === 'Saved');
  assert.match(read('app.js'), /\/\/ edited\n$/);
  assert.equal(await page.locator('#fxEdSave').isDisabled(), true);
  await page.waitForTimeout(700); // its own undo step, apart from the typing above
  await page.keyboard.type('x');
  await page.keyboard.press(`${KEY}+f`); // Escape closes the search bar, not the editor (the field is gone before the sheet sees the key)
  await page.locator('#fxQLBody .cm-search input').first().waitFor();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#fxQLBody .cm-search').count(), 0);
  assert.equal(await page.locator('#fxConfirm').count(), 0, 'no unsaved-changes question');
  assert.ok(await page.locator('#fxQL.editing').isVisible());
  await page.keyboard.press(`${KEY}+z`);
  await page.click('#fxQL .icon-btn[data-close]');
  assert.equal(await page.locator('#fxQL').isHidden(), true, 'a saved editor closes without asking');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a file changed on disk asks before overwriting; closing with unsaved changes asks Save / Don\'t Save / Cancel', { skip }, async () => {
  const { page, errors, ctx } = await open();
  await edit(page, 'notes.txt');
  await page.locator('#fxQLBody .cm-content').click();
  await page.keyboard.type('mine ');
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'agent\n');
  fs.utimesSync(path.join(proj, 'notes.txt'), later, later);
  await page.click('#fxEdSave');
  await page.locator('#fxConfirm h2', { hasText: 'changed on disk' }).waitFor();
  await page.click('#fxConfirm [data-k="cancel"].btn');
  assert.equal(read('notes.txt'), 'agent\n', 'Cancel writes nothing');
  await page.click('#fxEdSave');
  await page.click('#fxConfirm [data-k="go"]');
  await page.waitForFunction(() => document.getElementById('fxEdState').textContent === 'Saved');
  assert.equal(read('notes.txt'), 'one\ntwo\nmine ', 'Overwrite writes the editor\'s text over the agent\'s');

  await page.locator('#fxQLBody .cm-content').click();
  await page.keyboard.type('unsaved ');
  await page.click('#fxQL .icon-btn[data-close]');
  await page.locator('#fxConfirm h2', { hasText: 'Save changes to “notes.txt”?' }).waitFor();
  await page.click('#fxConfirm [data-k="cancel"].btn');
  assert.ok(await page.locator('#fxQL.editing').isVisible(), 'Cancel keeps editing');
  await page.click('#fxQL .icon-btn[data-close]');
  await page.click('#fxConfirm [data-k="discard"]');
  assert.equal(await page.locator('#fxQL').isHidden(), true);
  assert.doesNotMatch(read('notes.txt'), /unsaved/, "Don't Save leaves the file as it was");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the menu has Edit (off for images), E edits the selection, and New file… opens in the editor', { skip }, async () => {
  const { page, errors, ctx } = await open();
  await page.click(rowSel('pic.png'), { button: 'right' });
  assert.equal(await page.locator('.fx-menu [data-act="edit"]').isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.click(rowSel('notes.txt'), { button: 'right' });
  await page.locator('.fx-menu [data-act="edit"]').click();
  await page.locator('#fxQLBody .cm-editor').waitFor();
  await page.click('#fxQL .icon-btn[data-close]');
  await page.click(rowSel('app.js'));
  await page.keyboard.press('e');
  await page.locator('#fxQLBody .cm-editor').waitFor();
  assert.equal(await page.locator('#fxQLTitle').textContent(), 'app.js');
  await page.click('#fxQL .icon-btn[data-close]');

  await page.click('#fxMain', { button: 'right', position: { x: 600, y: 500 } });
  await page.locator('.fx-menu [data-act="newfile"]').click();
  await page.keyboard.type('fresh.md');
  await page.keyboard.press('Enter');
  await page.locator('#fxQL.editing #fxQLBody .cm-editor').waitFor();
  assert.equal(await page.locator('#fxQLTitle').textContent(), 'fresh.md');
  await page.locator('#fxQLBody .cm-content').click();
  await page.keyboard.type('# Hello');
  await page.click('#fxEdSave');
  await page.waitForFunction(() => document.getElementById('fxEdState').textContent === 'Saved');
  assert.equal(read('fresh.md'), '# Hello');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('on a phone the editor fills the screen with 16px text and a 44px Save', { skip }, async () => {
  const { page, errors, ctx } = await open({ width: 390, height: 844 }, true);
  await page.tap(rowSel('app.js')); // a tap opens Quick Look on a phone
  await page.locator('#fxQLEdit').click();
  await page.locator('#fxQLBody .cm-editor').waitFor();
  const font = await page.$eval('#fxQLBody .cm-scroller', (n) => getComputedStyle(n).fontSize);
  assert.equal(font, '16px');
  const save = await page.locator('#fxEdSave').boundingBox(), panel = await page.locator('.fx-ql-panel').boundingBox();
  assert.ok(save.height >= 44, `Save is ${save.height}px tall`);
  assert.ok(panel.width >= 389 && panel.height >= 800, 'the editor sheet fills the screen');
  assert.equal(await page.locator('#fxEdWrap').getAttribute('aria-checked'), 'true', 'long lines wrap on a phone');
  assert.deepEqual(errors, []);
  await ctx.close();
});
