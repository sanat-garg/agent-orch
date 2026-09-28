// Phone composer (#451, HIG text fields and keyboards): boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) and opens a
// chat at 390×844 with touch. The composer shows only the text field, the round send button inside its right edge, the
// model pill and '+'; '+' opens a sheet with Photo, File and the hidden chips' options (mode, effort, persona), whose menus
// open above '+'; sending still works (the outgoing ws `send` is caught in the page, so no agent runs). At 1280px the
// desktop chip row is unchanged. Skips when Chromium can't launch.
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
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'mobile-composer-password';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
let browser, skip = false;
try { browser = await chromium.launch({ env: { ...process.env, ...macChromiumEnv() } }); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-composerui-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const cwd = path.join(dataDir, 'p', 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: 'c0', title: 'Chat 0', cwd, mode: 'chat',
    agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true }]));
  const port = await freePort();
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(viewport, touch = true) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport, isMobile: touch, hasTouch: touch, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name, value, url: base }]);
  // Catch chat sends in the page (window.__sent) so no agent is started.
  await ctx.addInitScript(() => {
    window.__sent = [];
    const raw = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      try { const m = JSON.parse(d); if (m.t === 'send') return void window.__sent.push(m); } catch {}
      return raw.call(this, d);
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  // A macOS head's Server details charts can't read load averages (renderMetrics): not the composer's concern.
  page.on('pageerror', (e) => { if (!/renderMetrics/.test(e.stack)) errors.push(e.message); });
  await page.goto(`${base}/#c0`);
  await page.locator('#app:not([inert]) #input').waitFor();
  await page.waitForFunction(() => state.ws?.readyState === 1 && !document.getElementById('effChip').hidden);
  return { ctx, page, errors };
}

// What the composer shows: its visible controls, any other visible text outside them, and their boxes.
const composer = (page) => page.evaluate(() => {
  const root = document.getElementById('composer');
  const shown = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden'; };
  const box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }; };
  const controls = [...root.querySelectorAll('button, input, select, textarea, [role="button"], a[href]')].filter(shown);
  const text = [...root.querySelectorAll('*')].filter((n) => shown(n) && !n.closest('button, textarea') && [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()))
    .map((n) => n.textContent.trim());
  const b = {};
  for (const id of ['input', 'send', 'modelChip', 'plusBtn', 'composer']) b[id] = box(document.getElementById(id));
  return { ids: controls.map((n) => n.id), text, b, font: getComputedStyle(document.getElementById('input')).fontSize, width: innerWidth,
    overflow: document.documentElement.scrollWidth - innerWidth, pill: document.getElementById('modelChip').scrollWidth <= document.getElementById('modelChip').clientWidth + 1 };
});

test('390px: only the text field, send, the model pill and + are visible', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  // A long model + fallbacks label still truncates inside the one row.
  await page.evaluate(() => { document.getElementById('modelLabel').textContent = 'A very long model name that must truncate on a phone'; });
  const c = await composer(page);
  assert.deepEqual(c.ids.sort(), ['input', 'modelChip', 'plusBtn', 'send'], `visible composer controls: ${c.ids}`);
  assert.deepEqual(c.text, [], 'no labels or hint text');
  for (const id of ['attBtn', 'modeChip', 'effChip', 'personaChip']) assert.equal(await page.locator(`#${id}`).isVisible(), false, `#${id} moved into the + sheet`);
  assert.equal(c.font, '16px', 'a 16px field (no iOS zoom on focus)');
  const { input, send, modelChip, plusBtn } = c.b;
  assert.ok(send.left >= input.left && send.right <= input.right && send.top >= input.top && send.bottom <= input.bottom, `send sits inside the field: ${JSON.stringify({ send, input })}`);
  assert.ok(input.right - send.right <= 8, 'at its right edge');
  assert.equal(send.w, send.h, 'round');
  assert.ok(send.w >= 44 && plusBtn.w >= 44 && plusBtn.h >= 44 && modelChip.h >= 44, '44pt targets');
  assert.equal(Math.round(plusBtn.top), Math.round(modelChip.top), '+ and the pill share one row');
  assert.ok(plusBtn.left < modelChip.left && modelChip.bottom <= input.top, 'the row sits above the field, + first');
  assert.ok(modelChip.right <= c.width && c.overflow <= 0, `nothing overflows sideways: ${JSON.stringify(modelChip)} ${c.overflow}`);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#modelChip .mc-prim')).textOverflow), 'ellipsis', 'the pill truncates');

  // Keyboard up (syncKeyboard's --kb + kb-open): the same single row, pinned above the keyboard, orch bar hidden.
  await page.evaluate(() => { document.getElementById('orchBar').hidden = false; document.documentElement.style.setProperty('--kb', '300px'); document.documentElement.classList.add('kb-open'); });
  const k = await composer(page);
  assert.deepEqual(k.ids.sort(), ['input', 'modelChip', 'plusBtn', 'send']);
  assert.ok(k.b.composer.bottom <= 844 - 300 + 0.5 && k.b.composer.bottom > 844 - 300 - 20, `pinned above the keyboard: ${k.b.composer.bottom}`);
  assert.equal(await page.locator('#orchBar').isVisible(), false);
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('390px: + opens a sheet with attach and the moved composer options', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  const sheet = page.locator('#plusSheet');
  const rows = () => sheet.locator('.ps-row:visible .ps-l').allTextContents();
  await page.locator('#plusBtn').tap();
  await sheet.waitFor();
  assert.equal(await page.locator('#plusBtn').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(await rows(), ['Photo', 'File', 'Permission mode', 'Effort'], 'no persona row without personas');
  assert.equal(await page.locator('#psMode').textContent(), await page.locator('#modeLabel').textContent());
  assert.equal(await page.locator('#psEff').textContent(), await page.locator('#effVal').textContent());
  await page.waitForFunction(() => !document.querySelector('#plusSheet .modal-panel').getAnimations().length); // sheet-up
  const panel = await sheet.locator('.modal-panel').boundingBox();
  assert.ok(Math.abs(panel.y + panel.height - 844) < 1 && panel.width === 390, `a bottom sheet: ${JSON.stringify(panel)}`);
  for (const r of await sheet.locator('.ps-row:visible').all()) assert.ok((await r.boundingBox()).height >= 44, '44pt rows');

  // Permission mode: its menu opens above + and the pick sticks.
  await sheet.locator('[data-plus="modeChip"]').tap();
  await sheet.waitFor({ state: 'hidden' });
  const menu = page.locator('#modePop');
  await menu.waitFor();
  const mb = await menu.boundingBox(), pb = await page.locator('#plusBtn').boundingBox();
  assert.ok(mb.x >= 0 && mb.x + mb.width <= 390 && mb.y >= 0 && mb.y + mb.height <= pb.y, `on screen, above +: ${JSON.stringify({ mb, pb })}`);
  await menu.locator('.cm-opt[data-value="plan"]').tap();
  await menu.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#modeLabel').textContent(), 'Plan mode');

  // Effort: its slider menu, above +.
  await page.locator('#plusBtn').tap();
  assert.equal(await page.locator('#psMode').textContent(), 'Plan mode');
  await sheet.locator('[data-plus="effChip"]').tap();
  await page.locator('#effPop').waitFor();
  const eb = await page.locator('#effPop').boundingBox();
  assert.ok(eb.y + eb.height <= pb.y && eb.x >= 0 && eb.x + eb.width <= 390, `effort menu above +: ${JSON.stringify(eb)}`);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'effRange');
  await page.keyboard.press('Escape');
  await page.locator('#effPop').waitFor({ state: 'hidden' });

  // Persona: a row once a persona exists, opening its menu.
  await page.evaluate(() => { EX.personas = [{ id: 'p1', name: 'Reviewer', description: '', prompt: 'Review.' }]; exRenderChip(); });
  await page.locator('#plusBtn').tap();
  assert.deepEqual(await rows(), ['Photo', 'File', 'Permission mode', 'Effort', 'Persona']);
  assert.equal(await page.locator('#psPersona').textContent(), 'Persona');
  await sheet.locator('[data-plus="personaChip"]').tap();
  await page.locator('#personaPop .cm-opt >> text=Reviewer').waitFor();
  assert.ok((await page.locator('#personaPop').boundingBox()).y < pb.y, 'the persona menu opens above +');
  await page.keyboard.press('Escape');
  await page.locator('#personaPop').waitFor({ state: 'hidden' });

  // Photo and File pick files (Photo takes images only) into the tray; the close button and Escape dismiss the sheet.
  await page.locator('#plusBtn').tap();
  let chooser = page.waitForEvent('filechooser');
  await sheet.locator('[data-plus="photo"]').tap();
  let fc = await chooser;
  assert.equal(await fc.element().getAttribute('accept'), 'image/*');
  await fc.setFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG });
  await page.locator('#attTray .att-item.img.ready').waitFor();
  await page.locator('#plusBtn').tap();
  chooser = page.waitForEvent('filechooser');
  await sheet.locator('[data-plus="file"]').tap();
  fc = await chooser;
  assert.equal(await fc.element().getAttribute('accept'), null);
  await fc.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.waitForFunction(() => document.querySelectorAll('#attTray .att-item.ready').length === 2);
  assert.equal(await page.locator('#attTray').isVisible(), true, 'the tray shows over the field');
  await page.locator('#plusBtn').tap();
  await sheet.locator('.icon-btn[data-close]').tap();
  await sheet.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#plusBtn').getAttribute('aria-expanded'), 'false');
  await page.locator('#plusBtn').tap();
  await sheet.waitFor();
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('390px: sending still works, with the attachments picked through +', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  await page.locator('#plusBtn').tap();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#plusSheet [data-plus="file"]').tap();
  await (await chooser).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.locator('#attTray .att-item.ready').waitFor();
  await page.locator('#input').tap();
  await page.keyboard.type('Fix the login bug');
  assert.equal(await page.locator('#send').isEnabled(), true);
  await page.locator('#send').tap();
  await page.waitForFunction(() => window.__sent.length === 1);
  const [m] = await page.evaluate(() => window.__sent);
  assert.equal(m.cid, 'c0');
  assert.equal(m.text, 'Fix the login bug');
  assert.equal(m.attachments.length, 1);
  assert.equal(await page.locator('#input').inputValue(), '', 'the field clears');
  assert.equal(await page.locator('#attTray').isVisible(), false);
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('1280px: the desktop composer keeps its chip row and no +', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 1280, height: 800 }, false);
  const c = await composer(page);
  assert.deepEqual(c.ids, ['input', 'attBtn', 'modeChip', 'modelChip', 'effChip', 'send']);
  assert.ok(c.b.send.top >= c.b.input.bottom, 'send sits in the chip row under the field');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#composer .box')).display), 'block');
  await ctx.close();
  assert.deepEqual(errors, []);
});
