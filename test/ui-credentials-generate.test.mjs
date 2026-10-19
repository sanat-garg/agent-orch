// Credentials editor: the Generate button next to each value fills it with a strong random secret (credentials.js
// generateSecret / startEdit). Boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir), opens the sheet and its editor,
// and checks: the default choice fills an empty value with 32 [A-Za-z0-9] characters shown in clear (not dots), the hex
// choice gives 64 [0-9a-f], dismissing the "Replace the current value?" confirm keeps an existing value, and nothing is
// sent to the server before Save. On a 390×844 touch screen the button and menu options are 44px tall.
// Skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'cred-gen-ui-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-credgen-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
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

// The sheet with the "New service" editor open; `writes` collects every request that could change credentials.
async function openEditor(opts, touch = false) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(opts);
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [], writes = [], dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (r.url().includes('/api/credentials') && r.method() !== 'GET') writes.push(`${r.method()} ${r.url()}`); });
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await page.goto(`${base}/`);
  await page.locator('#credBtn').waitFor({ state: 'attached' });
  if (touch) { await page.tap('#openSidebar'); await page.tap('#credBtn'); } else await page.evaluate(() => document.getElementById('credBtn').click());
  await page.locator('#credModal:not([hidden])').waitFor();
  await page.locator('#crBody .cr-top .btn.primary').waitFor();
  await page.locator('#crBody .cr-top .btn.primary').click();
  await page.locator('#crBody .cr-row').first().waitFor();
  return { ctx, page, errors, writes, dialogs };
}
const rowValue = (page, i) => page.locator('#crBody .cr-row').nth(i).locator('.cr-fvalue');
async function generate(page, i, kind) {
  const row = page.locator('#crBody .cr-row').nth(i);
  await row.locator('.cr-gen').click();
  const menu = page.locator('#credModal .cr-genmenu:not([hidden])');
  await menu.waitFor();
  await menu.locator(`.cm-opt[data-value="${kind}"]`).click();
}

test('Generate fills an empty value with 32 letters+digits shown in clear; hex gives 64 hex digits', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, writes } = await openEditor({ viewport: { width: 1200, height: 800 } });
  const menu = page.locator('#credModal .cr-genmenu').first();
  await page.locator('#crBody .cr-row').first().locator('.cr-gen').click();
  await page.locator('#credModal .cr-genmenu:not([hidden])').waitFor();
  assert.deepEqual(await menu.locator('.cm-opt .cm-l').allTextContents(), ['32 letters and digits', '64 hex digits', '24-character password']);
  assert.equal(await menu.locator('.cm-opt[aria-selected="true"]').getAttribute('data-value'), 'alnum', 'letters+digits is the default');
  await menu.locator('.cm-opt[data-value="alnum"]').click();
  const v1 = rowValue(page, 0);
  assert.match(await v1.inputValue(), /^[A-Za-z0-9]{32}$/);
  // The second row is a secret: with its eye off (dots while typed) a generated value still shows in clear until saved.
  const v2 = rowValue(page, 1);
  await page.locator('#crBody .cr-row').nth(1).locator('.cr-vwrap .cr-icon').click();
  assert.equal(await v2.getAttribute('type'), 'password', 'a secret row reads as dots once its eye is off');
  await generate(page, 1, 'hex');
  assert.match(await v2.inputValue(), /^[0-9a-f]{64}$/);
  assert.equal(await v2.getAttribute('type'), 'text', 'the generated value is shown, not dotted');
  assert.equal(await page.locator('#credModal .cr-genmenu:not([hidden])').count(), 0, 'the menu closes after a pick');
  // Two draws never match; the password shape has symbols somewhere in a few draws.
  const a = await page.evaluate(() => Credentials.generateSecret('hex'));
  assert.notEqual(a, await v2.inputValue());
  const pw = await page.evaluate(() => Array.from({ length: 8 }, () => Credentials.generateSecret('password')));
  assert.ok(pw.every((p) => p.length === 24) && pw.some((p) => /[^A-Za-z0-9]/.test(p)), `24-char passwords with symbols: ${pw}`);
  assert.deepEqual(writes, [], 'nothing is sent to the server before Save');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('dismissing "Replace the current value?" keeps an existing value', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, writes, dialogs } = await openEditor({ viewport: { width: 1200, height: 800 } });
  const v1 = rowValue(page, 0);
  await v1.fill('keep-me');
  await generate(page, 0, 'alnum');
  assert.deepEqual(dialogs, ['Replace the current value?']);
  assert.equal(await v1.inputValue(), 'keep-me');
  // An empty field asks nothing.
  await generate(page, 1, 'alnum');
  assert.equal(dialogs.length, 1);
  assert.match(await rowValue(page, 1).inputValue(), /^[A-Za-z0-9]{32}$/);
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('390×844 touch: Generate and its options are 44px targets', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await openEditor({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, true);
  const gen = page.locator('#crBody .cr-row').first().locator('.cr-gen');
  assert.ok((await gen.boundingBox()).height >= 44, 'Generate is 44px tall');
  await gen.tap();
  const menu = page.locator('#credModal .cr-genmenu:not([hidden])');
  await menu.waitFor();
  for (const b of await menu.locator('.cm-opt').all()) assert.ok((await b.boundingBox()).height >= 44, 'menu options are 44px tall');
  const m = await menu.boundingBox();
  assert.ok(m.x >= 0 && m.x + m.width <= 390, `the menu stays on screen: ${JSON.stringify(m)}`);
  await menu.locator('.cm-opt[data-value="password"]').tap();
  assert.match(await rowValue(page, 0).inputValue(), /^.{24}$/);
  assert.deepEqual(errors, []);
  await ctx.close();
});
