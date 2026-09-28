// Keyboard-aware composer on phones (UI-REVIEW #2): boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir), opens the
// chat at 390×844 and fakes an on-screen keyboard the way app.js syncKeyboard reports one (--kb on <html> plus
// html.kb-open). The orch bar must step aside, the composer must end above the keyboard and its chips fold into one
// row; tapping into #input alone sets kb-open (the load-time programmatic focus does not). At desktop width nothing changes. Skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'kb-ui-password';
const KB = 300;
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-kbui-'));
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

async function open(viewport, mobile = true) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/`);
  await page.locator('#app:not([inert]) #input').waitFor();
  // Show the orch bar (it only appears in orchestrator chats) so there is something to hide.
  await page.evaluate(() => { document.getElementById('orchBar').hidden = false; });
  return { ctx, page, errors };
}

const layout = (page) => page.evaluate(() => {
  const r = (s) => document.querySelector(s).getBoundingClientRect();
  return { vh: innerHeight, app: r('#app').height, composerBottom: r('#composer').bottom, orchBar: r('#orchBar').height,
    kbOpen: document.documentElement.classList.contains('kb-open'), wrap: getComputedStyle(document.querySelector('.controls .left')).flexWrap,
    chipsTop: [...document.querySelectorAll('.controls .left > .chip')].filter((c) => c.offsetParent).map((c) => Math.round(c.getBoundingClientRect().top)) };
});
const fakeKeyboard = (page, px) => page.evaluate((px) => {
  document.documentElement.style.setProperty('--kb', px + 'px');
  document.documentElement.classList.toggle('kb-open', px > 0);
}, px);

test('390×844: with the keyboard up the orch bar hides and the composer ends above the keyboard', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  const before = await layout(page);
  assert.ok(before.orchBar > 0, 'orch bar visible without a keyboard');
  assert.equal(before.kbOpen, false, 'the load-time programmatic focus opens no keyboard');
  assert.equal(before.app, before.vh);

  await fakeKeyboard(page, KB);
  const up = await layout(page);
  assert.equal(up.orchBar, 0, 'orch bar hidden while typing');
  assert.equal(up.app, up.vh - KB, '.app shrinks by --kb');
  assert.ok(up.composerBottom <= up.vh - KB + 0.5, `composer bottom ${up.composerBottom} is under the keyboard (top ${up.vh - KB})`);
  assert.ok(up.composerBottom > up.vh - KB - 40, 'composer sits right on top of the keyboard');
  assert.equal(up.wrap, 'nowrap');
  assert.equal(new Set(up.chipsTop).size, 1, `chips on one row: ${up.chipsTop}`);

  await fakeKeyboard(page, 0);
  const down = await layout(page);
  assert.ok(down.orchBar > 0, 'orch bar back once the keyboard is gone');
  assert.equal(down.app, down.vh);
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('390×844: tapping into the composer marks the keyboard open, blurring clears it', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  await page.evaluate(() => document.getElementById('input').blur());
  await page.tap('#input');
  let l = await layout(page);
  assert.equal(l.kbOpen, true);
  assert.equal(l.orchBar, 0);
  await page.evaluate(() => document.getElementById('input').blur());
  l = await layout(page);
  assert.equal(l.kbOpen, false);
  assert.ok(l.orchBar > 0);
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--kb')), '0px');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('1280×800: desktop ignores kb-open', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 1280, height: 800 }, false);
  await fakeKeyboard(page, KB);
  const l = await layout(page);
  assert.ok(l.orchBar > 0);
  assert.equal(l.app, l.vh);
  assert.equal(l.wrap, 'wrap');
  await ctx.close();
  assert.deepEqual(errors, []);
});
