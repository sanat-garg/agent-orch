// Files view (files.js) in a real browser against server.mjs (temporary HOME, data and port; no orchestrator): Ask in chat
// from Quick Look and from a Contents hit puts the file's `path[:line]` into the composer and returns to the chat.
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
const PASSWORD = 'files-ui-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, root, home, dataDir, cookie;

before(async () => {
  if (skip) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-filesui-'));
  home = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  for (const d of [home, dataDir, path.join(root, 'proj/src')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'proj/src/app.js'), 'const a = 1;\nfunction needle() {}\n');
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

async function open(viewport, mobile = false) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript(() => localStorage.setItem('cw.lastSeen', String(Date.now())));
  const page = await ctx.newPage();
  const errors = [], dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.goto(`${base}/#c0`);
  await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
  return { page, errors, dialogs, ctx };
}

async function openFiles(page) {
  await page.click('.seg button[data-view="files"]');
  await page.locator('#fxMain [role="listbox"], #fxMain [role="tree"]').waitFor();
}

test('Ask in chat from Quick Look puts the relative path into the composer and leaves Files', { skip, timeout: 60000 }, async () => {
  const { page, errors, ctx } = await open({ width: 1280, height: 860 });
  await page.fill('#input', 'Explain');
  await openFiles(page);
  await page.dblclick('#fxMain [role="option"]:has-text("src"), #fxMain [role="treeitem"]:has-text("src")');
  await page.locator('#fxMain :is([role="option"], [role="treeitem"]):has-text("app.js")').dblclick();
  await page.locator('#fxQL:not([hidden]) #fxQLAsk').click();
  assert.equal(await page.inputValue('#input'), 'Explain src/app.js ');
  assert.equal(await page.locator('#filesView').isHidden(), true, 'the Files view closes');
  assert.equal(await page.locator('#fxQL').isHidden(), true, 'Quick Look closes');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'input');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Ask on a Contents hit and Shift+Enter on a Names result add path:line and path', { skip, timeout: 60000 }, async () => {
  const { page, errors, ctx } = await open({ width: 1280, height: 860 });
  await openFiles(page);
  await page.fill('#fxFilter', 'needle');
  await page.click('[data-fxmode="contents"]');
  await page.press('#fxFilter', 'Enter');
  await page.locator('.fx-hit .fx-ask').click();
  assert.equal(await page.inputValue('#input'), 'src/app.js:2 ');
  assert.equal(await page.locator('#filesView').isHidden(), true);

  await page.fill('#input', '');
  await openFiles(page); // still showing the Contents results
  await page.fill('#fxFilter', 'app');
  await page.click('[data-fxmode="names"]');
  await page.press('#fxFilter', 'Enter');
  await page.locator('.fx-found [role="option"]').first().click();
  await page.keyboard.press('Shift+Enter');
  assert.equal(await page.inputValue('#input'), 'src/app.js ');
  assert.equal(await page.locator('#filesView').isHidden(), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});
