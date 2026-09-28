// Files view (files.js) marquee selection in a real browser against server.mjs (temporary HOME, data, project and port; no
// orchestrator), list view over 40 files so the list scrolls:
// - dragging from empty space (a row's Kind column) across rows 2-5 selects exactly those; the box shows while dragging;
// - ⌘-drag adds the touched rows to the selection; dragging to the bottom edge scrolls and selects the revealed rows;
// - a click on empty space clears the selection; a drag starting on a selected row draws no marquee; Esc restores.
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
const PASSWORD = 'files-marquee-password';
const FILES = Array.from({ length: 40 }, (_, i) => `f${String(i + 1).padStart(2, '0')}.txt`);
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() }; // the MacBook worker's LaunchDaemon needs a shim (helpers/mac-chromium.mjs)
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, root, home, dataDir, proj, cookie;

before(async () => {
  if (skip) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-filesmarquee-'));
  home = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  proj = path.join(root, 'proj');
  for (const d of [home, dataDir, proj]) fs.mkdirSync(d, { recursive: true });
  for (const f of FILES) fs.writeFileSync(path.join(proj, f), `${f}\n`);
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

async function open(viewport = { width: 1280, height: 600 }, mobile = false) {
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

const span = (a, b) => FILES.slice(a - 1, b); // rows a..b, 1-based
const kind = async (page, i) => { // the centre of row i's Kind column (1-based): empty space, not the name
  const b = await page.locator(`#fxMain [data-i="${i - 1}"] .fx-c.kind`).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
async function drag(page, from, to, { hold = 0, mods = [] } = {}) {
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 3, from.y + 5, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  const shown = await page.locator('.fx-marquee').count();
  if (hold) { await page.waitForTimeout(hold); await page.mouse.move(to.x, to.y + 1); }
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
  return shown;
}

test('a drag from empty space across rows 2-5 selects exactly those rows', { skip, timeout: 60000 }, async () => {
  const { page, errors, ctx } = await open();
  assert.deepEqual(await names(page), FILES);
  const shown = await drag(page, await kind(page, 2), await kind(page, 5));
  assert.equal(shown, 1, 'the marquee box is drawn while dragging');
  assert.deepEqual(await selected(page), span(2, 5));
  assert.equal(await page.locator('.fx-marquee').count(), 0, 'the box goes away on release');
  const box = await page.evaluate(() => { const b = document.createElement('div'); b.className = 'fx-marquee'; document.body.append(b); const s = getComputedStyle(b); const r = [s.borderTopWidth, s.backgroundColor]; b.remove(); return r; });
  assert.equal(box[0], '1px');
  assert.match(box[1], /color\(srgb .* 0\.1\)|rgba\(.*0\.1\)/, '10% accent fill');
  // Keyboard shortcuts act on it: the context menu offers Copy for the 4 rows
  await page.keyboard.press('Shift+F10');
  await page.locator('#fxMenu').waitFor();
  assert.deepEqual(await selected(page), span(2, 5), 'the menu keeps the marquee selection');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('⌘-drag adds the touched rows to the selection; Esc mid-drag restores it', { skip, timeout: 60000 }, async () => {
  const { page, errors, ctx } = await open();
  await page.click(rowSel('f08.txt'));
  assert.deepEqual(await selected(page), ['f08.txt']);
  await drag(page, await kind(page, 2), await kind(page, 3), { mods: ['Meta'] });
  assert.deepEqual(await selected(page), ['f02.txt', 'f03.txt', 'f08.txt']);
  await drag(page, await kind(page, 11), await kind(page, 12), { mods: ['Shift'] });
  assert.deepEqual(await selected(page), ['f02.txt', 'f03.txt', 'f08.txt', 'f11.txt', 'f12.txt'], 'Shift-drag adds too');

  // Esc during a drag puts the previous selection back
  const from = await kind(page, 5), to = await kind(page, 7);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  assert.deepEqual(await selected(page), span(5, 7), 'a plain drag replaces it live');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.fx-marquee').count(), 0);
  await page.mouse.up();
  assert.deepEqual(await selected(page), ['f02.txt', 'f03.txt', 'f08.txt', 'f11.txt', 'f12.txt']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('dragging near the bottom edge scrolls the list and selects the revealed rows', { skip, timeout: 60000 }, async () => {
  const { page, errors, ctx } = await open();
  const main = await page.locator('#fxMain').boundingBox();
  const lastVisible = await page.$$eval('#fxMain [data-i]', (os, bottom) => os.filter((o) => o.getBoundingClientRect().bottom <= bottom).length, main.y + main.height);
  assert.ok(lastVisible < 30, `the list scrolls (${lastVisible} rows visible)`);
  const from = await kind(page, 2);
  await drag(page, from, { x: from.x, y: main.y + main.height - 6 }, { hold: 1200 });
  assert.ok(await page.$eval('#fxMain', (m) => m.scrollTop) > 100, 'the list scrolled');
  const sel = await selected(page);
  assert.equal(sel[0], 'f02.txt');
  assert.ok(sel.length > lastVisible, `rows below the first screen are selected (${sel.length})`);
  assert.deepEqual(sel, span(2, sel.length + 1), 'one contiguous run from row 2');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a click on empty space clears the selection', { skip, timeout: 60000 }, async () => {
  const { page, errors, ctx } = await open();
  await page.click(rowSel('f03.txt'));
  await page.click(rowSel('f04.txt'), { modifiers: ['Meta'] });
  assert.deepEqual(await selected(page), ['f03.txt', 'f04.txt']);
  await page.$eval('#fxMain', (m) => { m.scrollTop = m.scrollHeight; });
  const last = await page.locator('#fxMain [data-i="39"]').boundingBox();
  await page.mouse.click(last.x + last.width / 2, last.y + last.height + 6); // the list's bottom padding
  assert.deepEqual(await selected(page), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a drag starting on a selected row draws no marquee', { skip, timeout: 60000 }, async () => {
  const { page, errors, ctx } = await open();
  await page.click(rowSel('f03.txt'));
  const shown = await drag(page, await kind(page, 3), await kind(page, 6));
  assert.equal(shown, 0);
  assert.deepEqual(await selected(page), ['f03.txt']);
  // Nor does one starting on a row's name
  const nm = await page.locator(`${rowSel('f08.txt')} .fx-nt`).boundingBox();
  assert.equal(await drag(page, { x: nm.x + 4, y: nm.y + nm.height / 2 }, await kind(page, 10)), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});
