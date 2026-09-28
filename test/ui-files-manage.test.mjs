// Files view (files.js) Rename, New file, New folder and Delete in a real browser against server.mjs (temporary HOME, data,
// project and port; no orchestrator), so every operation really lands on disk:
// - the context menu lists the four after Compress; Rename… edits the name in place (Enter saves, Esc and F2), a taken
//   name toasts and keeps the field; New folder (background) and New file (on a folder row) make them; the result is selected.
// - Delete asks first (an in-page confirm, not window.confirm): Cancel keeps the file, Delete removes it; Delete/Backspace
//   open it for the selection; on a phone it is a sheet with 44px buttons.
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
const PASSWORD = 'files-manage-password';
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() }; // the MacBook worker's LaunchDaemon needs a shim (helpers/mac-chromium.mjs)
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, root, home, dataDir, proj, cookie;

before(async () => {
  if (skip) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-filesmanage-'));
  home = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  proj = path.join(root, 'proj');
  for (const d of [home, dataDir, path.join(proj, 'docs')]) fs.mkdirSync(d, { recursive: true });
  for (const f of ['a.txt', 'b.txt', 'keep.txt']) fs.writeFileSync(path.join(proj, f), `${f}\n`);
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
const names = (page) => page.$$eval('#fxMain [data-i] .fx-nt', (ns) => ns.map((n) => n.textContent));
const selected = (page) => page.$$eval('#fxMain [aria-selected="true"] .fx-nt', (ns) => ns.map((n) => n.textContent));
const toasts = (page) => page.$$eval('#toasts .toast:not(.toast-out) .toast-msg', (ts) => ts.map((t) => t.textContent));
const until = async (fn, what = 'condition') => {
  for (const t0 = Date.now(); Date.now() - t0 < 8000; await new Promise((r) => setTimeout(r, 50))) if (await fn()) return;
  assert.fail(`timed out waiting for ${what}`);
};
async function menu(page, target, pick) {
  if (target) await page.click(target, { button: 'right' });
  else { const b = await page.locator('#fxMain').boundingBox(); await page.mouse.click(b.x + b.width / 3, b.y + b.height * 0.6, { button: 'right' }); } // clear of the rows and the toasts
  await page.locator('#fxMenu').waitFor();
  if (pick) await page.click(`#fxMenu [data-act="${pick}"]`);
}

test('the menu offers Rename, New file, New folder and Delete; rename in place, new folder and file land on disk', { skip, timeout: 90000 }, async () => {
  const { page, errors, ctx } = await open();
  assert.deepEqual(await names(page), ['docs', 'a.txt', 'b.txt', 'keep.txt']);
  await menu(page, rowSel('a.txt'));
  const acts = await page.$$eval('#fxMenu .cm-opt', (bs) => bs.map((b) => [b.dataset.act, b.disabled]));
  assert.deepEqual(acts, [['open', false], ['copy', false], ['cut', false], ['paste', true], ['zip', false], ['rename', false], ['newfile', true],
    ['newdir', true], ['delete', false], ['path', false], ['ask', false]], 'the four after Compress; New only on a folder or the background');
  assert.deepEqual(await page.$$eval('#fxMenu .cm-opt .cm-l', (ls) => ls.map((l) => l.textContent)).then((ls) => ls.slice(5, 9)), ['Rename…', 'New file…', 'New folder…', 'Delete']);

  // Rename…: the name becomes a field, its stem selected; Enter saves and the renamed file stays selected
  await page.click('#fxMenu [data-act="rename"]');
  const field = page.locator("#fxMain .fx-edit");
  await field.waitFor();
  assert.equal(await field.inputValue(), 'a.txt');
  assert.deepEqual(await field.evaluate((f) => [document.activeElement === f, f.selectionStart, f.selectionEnd]), [true, 0, 1], 'focused, "a" selected');
  await page.keyboard.type('renamed');
  await page.keyboard.press('Enter');
  await until(async () => (await names(page)).includes('renamed.txt'), 'the renamed file in the listing');
  assert.deepEqual(await names(page), ['docs', 'b.txt', 'keep.txt', 'renamed.txt']);
  assert.ok(fs.existsSync(path.join(proj, 'renamed.txt')) && !fs.existsSync(path.join(proj, 'a.txt')));
  assert.deepEqual(await selected(page), ['renamed.txt']);
  assert.equal(await page.locator('#fxMain .fx-edit').count(), 0);

  // F2 with the list focused renames; Esc cancels
  await page.keyboard.press('F2');
  await page.locator('#fxMain .fx-edit').waitFor();
  await page.keyboard.type('zzz');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#fxMain .fx-edit').count(), 0);
  assert.deepEqual(await names(page), ['docs', 'b.txt', 'keep.txt', 'renamed.txt']);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'tree', 'the list has the focus back');

  // a taken name: the error toasts, the field stays with what was typed
  await page.keyboard.press('F2');
  await page.locator('#fxMain .fx-edit').waitFor();
  await page.keyboard.type('keep');
  await page.keyboard.press('Enter');
  await until(async () => (await toasts(page)).some((t) => /already exists/.test(t)), 'the "already exists" toast');
  await until(async () => (await page.locator('#fxMain .fx-edit:not([readonly])').count()) === 1, 'the field back');
  assert.equal(await page.inputValue('#fxMain .fx-edit'), 'keep.txt');
  await page.keyboard.press('Escape');
  assert.ok(fs.existsSync(path.join(proj, 'renamed.txt')));

  // New folder… on the background: a field in a new row at the top
  await menu(page, null);
  assert.deepEqual(await page.$$eval('#fxMenu .cm-opt', (bs) => bs.filter((b) => ['rename', 'newfile', 'newdir', 'delete'].includes(b.dataset.act)).map((b) => b.disabled)), [true, false, false, true]);
  await page.click('#fxMenu [data-act="newdir"]');
  await page.locator('#fxMain .fx-new .fx-edit').waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('#fxMain [role="tree"]').firstElementChild.classList.contains('fx-new')), true, 'the new row is at the top');
  await page.keyboard.type('made');
  await page.keyboard.press('Enter');
  await until(async () => (await names(page)).includes('made'), 'the new folder');
  assert.ok(fs.statSync(path.join(proj, 'made')).isDirectory());
  assert.deepEqual(await selected(page), ['made']);
  assert.equal(await page.locator('#fxMain .fx-new').count(), 0);

  // New file… on a folder row: made inside it, which opens in place with the file selected
  await menu(page, rowSel('docs'), 'newfile');
  await page.locator('#fxMain .fx-new .fx-edit').waitFor();
  await page.keyboard.type('inner.md');
  await page.keyboard.press('Enter');
  await until(async () => (await names(page)).includes('inner.md'), 'the new file under docs');
  assert.equal(fs.readFileSync(path.join(proj, 'docs/inner.md'), 'utf8'), '');
  assert.deepEqual(await selected(page), ['inner.md']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Delete asks first: Cancel keeps the file, Delete removes it; Delete/Backspace open the confirm for the selection', { skip, timeout: 60000 }, async () => {
  fs.writeFileSync(path.join(proj, 'gone.txt'), 'x\n');
  fs.writeFileSync(path.join(proj, 'gone2.txt'), 'x\n');
  const { page, errors, dialogs, ctx } = await open();
  await menu(page, rowSel('b.txt'), 'delete');
  await page.locator('#fxConfirm').waitFor();
  assert.equal(await page.textContent('#fxCfTitle'), 'Delete “b.txt”?');
  assert.equal(await page.textContent('#fxCfText'), "This can't be undone.");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Cancel', 'the safe button has the focus');
  const red = await page.$eval('#fxCfDel', (b) => getComputedStyle(b).backgroundColor);
  assert.equal(red, await page.evaluate(() => { const d = document.createElement('div'); d.style.color = 'var(--danger)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; }), 'Delete is red');
  await page.click('#fxConfirm .fx-cf-acts [data-close]');
  assert.equal(await page.locator('#fxConfirm').count(), 0);
  assert.ok(fs.existsSync(path.join(proj, 'b.txt')), 'Cancel keeps it');

  await menu(page, rowSel('b.txt'), 'delete');
  await page.click('#fxCfDel');
  await until(async () => !(await names(page)).includes('b.txt'), 'b.txt gone from the listing');
  assert.ok(!fs.existsSync(path.join(proj, 'b.txt')));
  assert.deepEqual(await selected(page), ['gone.txt'], 'the next row down is selected');

  // two picked, Delete: "Delete 2 items?"; Esc keeps them, Backspace then the red button removes them
  await page.click(rowSel('gone.txt'));
  await page.click(rowSel('gone2.txt'), { modifiers: ['ControlOrMeta'] });
  await page.keyboard.press('Delete');
  await page.locator('#fxConfirm').waitFor();
  assert.equal(await page.textContent('#fxCfTitle'), 'Delete 2 items?');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#fxConfirm').count(), 0);
  assert.ok(fs.existsSync(path.join(proj, 'gone.txt')) && fs.existsSync(path.join(proj, 'gone2.txt')));
  await page.keyboard.press('Backspace');
  await page.locator('#fxConfirm').waitFor();
  await page.click('#fxCfDel');
  await until(async () => !(await names(page)).includes('gone.txt'), 'both gone');
  assert.ok(!fs.existsSync(path.join(proj, 'gone.txt')) && !fs.existsSync(path.join(proj, 'gone2.txt')));
  assert.ok(!(await names(page)).includes('gone2.txt'));
  assert.deepEqual(dialogs, [], 'no window.confirm');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('375×667 touch: the confirm is a sheet with 44px buttons', { skip, timeout: 60000 }, async () => {
  const { page, errors, ctx } = await open({ width: 375, height: 667 }, true);
  await page.locator(`${rowSel('keep.txt')} .fx-more`).tap();
  await page.locator('#fxMenu [data-act="delete"]').tap();
  await page.locator('#fxConfirm').waitFor();
  await page.waitForTimeout(300); // the sheet slides up
  const m = await page.evaluate(() => {
    const p = document.querySelector('.fx-cf-panel').getBoundingClientRect();
    return { bottom: p.bottom, width: p.width, hs: [...document.querySelectorAll('.fx-cf-acts .btn')].map((b) => b.getBoundingClientRect().height), vw: innerWidth, vh: innerHeight };
  });
  assert.ok(Math.abs(m.bottom - m.vh) < 2 && m.width === m.vw, `a bottom sheet (${JSON.stringify(m)})`);
  assert.ok(m.hs.every((h) => h >= 44), `44px buttons (${m.hs})`);
  await page.locator('#fxConfirm .fx-cf-acts [data-close]').tap();
  assert.ok(fs.existsSync(path.join(proj, 'keep.txt')));
  assert.deepEqual(errors, []);
  await ctx.close();
});
