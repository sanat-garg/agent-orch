// The ⌘K / Ctrl+K command palette (app.js openPalette, #paletteModal) in a real browser: boots server.mjs
// (CW_NO_ORCHESTRATOR=1, temp data dir) on a spare port with three chats. Ctrl+K from the composer opens it; typing part
// of a chat's name ranks it first with the letters bolded and Enter opens that chat; 'zzzq' shows 'No matches'; Esc
// closes it and focus goes back; an action runs its button's function; phones get nothing. PAL_SHOTS=<dir> saves
// screenshots there. Skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'palette-password';
const SHOTS = process.env.PAL_SHOTS || null;
// On macOS the palette listens for ⌘K, elsewhere Ctrl+K; Playwright's ControlOrMeta picks the same one.
const KEY = 'ControlOrMeta+k';
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() };
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-palette-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const convo = (id, title, updatedAt) => {
    const cwd = path.join(dataDir, id);
    fs.mkdirSync(cwd);
    return { id, title, cwd, mode: 'chat', agent: 'claude', model: 'opus', createdAt: 1, updatedAt, fullAccess: true, renamed: true }; // renamed: keep the title, not the folder's name
  };
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([
    convo('pal-home', 'Home page', 3), convo('pal-billing', 'Billing service', 2), convo('pal-docs', 'Docs site', 1),
  ]));
  const port = await freePort();
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

async function open({ viewport = { width: 1280, height: 800 } } = {}) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#pal-home`);
  // The splash has lifted: the app is no longer inert and has put the focus in the composer.
  await page.waitForFunction(() => state.convos.length === 3 && state.cid === 'pal-home' && !document.getElementById('app').inert);
  return { ctx, page, errors };
}
const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `palette-${name}.png`) });
const rows = (page) => page.locator('#palList .pal-item .pal-name').allInnerTexts();

test('Ctrl+K from the composer lists chats newest first then actions; typing part of a name and Enter opens that chat', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  await page.locator('#input').focus();
  await page.keyboard.press(KEY);
  await page.locator('#paletteModal').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'palInput');
  const all = await rows(page);
  assert.deepEqual(all.slice(0, 3), ['Home page', 'Billing service', 'Docs site']);
  for (const a of ['New chat', 'Files', 'Terminal', 'Machines', 'Settings', 'Usage']) assert.ok(all.includes(a), `${a} in ${all}`);
  await shot(page, 'empty');
  await page.keyboard.type('bill');
  assert.equal((await rows(page))[0], 'Billing service');
  assert.equal(await page.locator('#palList .pal-item').first().locator('b').innerText(), 'Bill');
  // Scattered letters still match, after better ones: 'dst' is D-ocs s-i-t-e.
  await page.locator('#palInput').fill('dst');
  assert.equal((await rows(page))[0], 'Docs site');
  assert.deepEqual(await page.locator('#palList .pal-item').first().locator('.pal-name b').allInnerTexts(), ['D', 's', 't']);
  await page.locator('#palInput').fill('');
  await page.keyboard.type('serv');
  await shot(page, 'query');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => state.cid === 'pal-billing');
  assert.equal(await page.locator('#paletteModal').isHidden(), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("'zzzq' shows 'No matches'; Esc closes and focus goes back; Tab stays inside; arrows pick an action", { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  await page.locator('#chatSearch').focus();
  await page.keyboard.press(KEY);
  await page.keyboard.type('zzzq');
  assert.equal(await page.locator('#palList').innerText(), 'No matches');
  await shot(page, 'none');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'palInput');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#paletteModal').isHidden(), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'chatSearch');
  // The backdrop closes it too.
  await page.keyboard.press(KEY);
  await page.locator('#paletteModal .modal-backdrop').click({ position: { x: 10, y: 10 } });
  assert.equal(await page.locator('#paletteModal').isHidden(), true);
  // 'sett' ranks Settings first (prefix); ↓ then ↑ comes back to it and Enter opens the Settings sheet.
  await page.keyboard.press(KEY);
  await page.keyboard.type('sett');
  assert.equal((await rows(page))[0], 'Settings');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.locator('#settingsModal').waitFor();
  assert.equal(await page.locator('#paletteModal').isHidden(), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phones get no palette; the Files tab keeps its own shortcuts', { skip, timeout: 60000 }, async () => {
  let { ctx, page, errors } = await open({ viewport: { width: 390, height: 844 } });
  await page.keyboard.press(KEY);
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#paletteModal').isHidden(), true);
  await ctx.close();
  ({ ctx, page, errors } = await open());
  await page.keyboard.press(KEY);
  await page.keyboard.type('files');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('app').dataset.view === 'files');
  await page.keyboard.press('Control+`');
  await page.waitForFunction(() => document.getElementById('app').dataset.view === 'chat');
  assert.deepEqual(errors, []);
  await ctx.close();
});
