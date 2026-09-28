// Connections on an iPhone-sized screen (UI-REVIEW #10): boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir), then at
// 390×844 with a touch (coarse pointer) context taps the sidebar's connections footer and checks the panel is a bottom
// sheet with a grabber (not full screen), the close button did not grab focus (no focus ring on a tap), status lines may
// wrap to two lines, and nothing overflows sideways. Also checks keyboard focus still gets a ring on desktop.
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
const PASSWORD = 'conns-ui-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-connsui-'));
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

async function open(opts) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(opts);
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/`);
  await page.locator('#connFoot').waitFor({ state: 'attached' });
  return { ctx, page, errors };
}
const settle = (page) => page.evaluate(async () => {
  await Promise.all(document.querySelector('#connsModal .modal-panel').getAnimations().map((a) => a.finished.catch(() => {})));
});

test('390×844 touch: Connections is a bottom sheet, no focus ring, no sideways overflow', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true, 'the context emulates a coarse pointer');
  await page.tap('#openSidebar');
  await page.tap('#connFoot');
  await page.locator('#connsModal:not([hidden])').waitFor();
  await page.locator('#connsList .cn-row').first().waitFor();
  await settle(page);
  const m = await page.evaluate(() => {
    const modal = document.querySelector('#connsModal'), panel = modal.querySelector('.modal-panel'), r = panel.getBoundingClientRect();
    const grip = panel.querySelector('.sheet-grip'), g = grip?.getBoundingClientRect();
    const close = panel.querySelector('[data-close].icon-btn'), body = panel.querySelector('.cn-body');
    const wide = [...panel.querySelectorAll('*')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && (b.left < r.left - 0.5 || b.right > r.right + 0.5); })
      .map((e) => `${e.tagName.toLowerCase()}.${e.className}`).slice(0, 5);
    const st = panel.querySelector('.cn-st'), cs = getComputedStyle(st);
    return { sheet: modal.classList.contains('sheet'), grip: !!g && g.width > 0 && g.height > 0 && getComputedStyle(grip).display !== 'none',
      top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: innerWidth, vh: innerHeight,
      radius: parseFloat(getComputedStyle(panel).borderTopLeftRadius),
      backdrop: getComputedStyle(modal.querySelector('.modal-backdrop')).backgroundColor,
      closeFocused: document.activeElement === close, closeVisible: close.getBoundingClientRect().width > 0,
      scrollW: document.documentElement.scrollWidth, panelScrollW: panel.scrollWidth, panelW: panel.clientWidth, wide,
      bodyOy: getComputedStyle(body).overflowY, stWhite: cs.whiteSpace, stClamp: cs.webkitLineClamp };
  });
  assert.ok(m.sheet && m.grip, `the sheet grabber shows: ${JSON.stringify(m)}`);
  assert.ok(m.top > 0, `the panel top sits below the viewport top (not full screen): ${m.top}`);
  assert.ok(m.bottom >= m.vh - 0.5 && m.bottom <= m.vh + 0.5, `it is anchored to the bottom: ${m.bottom} vs ${m.vh}`);
  assert.ok(m.radius > 0, 'rounded top corners');
  assert.notEqual(m.backdrop, 'rgba(0, 0, 0, 0)', 'the backdrop dims the page');
  assert.ok(m.closeVisible, 'the close button shows');
  assert.equal(m.closeFocused, false, 'the close button is not auto-focused on a coarse pointer');
  assert.ok(m.left >= 0 && m.right <= m.vw + 0.5, `panel inside the viewport: ${JSON.stringify(m)}`);
  assert.ok(m.scrollW <= m.vw, `page scrolls sideways (${m.scrollW} > ${m.vw})`);
  assert.ok(m.panelScrollW <= m.panelW, `panel scrolls sideways (${m.panelScrollW} > ${m.panelW})`);
  assert.deepEqual(m.wide, [], 'content sticks out of the panel');
  assert.equal(m.bodyOy, 'auto', 'the body scrolls');
  assert.equal(m.stWhite, 'normal', 'status lines wrap');
  assert.equal(m.stClamp, '2', 'status lines clamp at two lines');

  // A long status line (an account email) wraps onto two lines instead of truncating.
  const lines = await page.evaluate(() => {
    const st = document.querySelector('#connsList .cn-st');
    st.textContent = 'Signed in as a-very-long-account-name-that-goes-on-and-on@example-company-domain.com';
    return Math.round(st.getBoundingClientRect().height / parseFloat(getComputedStyle(st).lineHeight));
  });
  assert.equal(lines, 2);

  await page.tap('#connsModal [data-close].icon-btn');
  assert.equal(await page.locator('#connsModal').isHidden(), true, 'the close button closes it');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('desktop: Connections keeps its centred window and keyboard focus still shows a ring', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1280, height: 800 } });
  await page.click('#connFoot');
  await page.locator('#connsModal:not([hidden])').waitFor();
  await settle(page);
  const m = await page.evaluate(() => {
    const panel = document.querySelector('#connsModal .modal-panel'), r = panel.getBoundingClientRect();
    const close = panel.querySelector('[data-close].icon-btn');
    return { grip: getComputedStyle(panel.querySelector('.sheet-grip')).display, top: r.top, bottom: r.bottom, vh: innerHeight,
      closeFocused: document.activeElement === close, clickOutline: getComputedStyle(close).outlineStyle };
  });
  assert.equal(m.grip, 'none', 'no grabber on desktop');
  assert.ok(m.top > 20 && m.bottom < m.vh - 20, `centred, not a bottom sheet: ${JSON.stringify(m)}`);
  assert.equal(m.closeFocused, true, 'a fine pointer still focuses the close button');
  assert.equal(m.clickOutline, 'none', 'no ring when focus came from a click');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab'); // switch to keyboard modality
  await page.focus('#connFoot');
  await page.keyboard.press('Enter');
  await page.locator('#connsModal:not([hidden])').waitFor();
  const kb = await page.evaluate(() => {
    const close = document.querySelector('#connsModal [data-close].icon-btn');
    return { focused: document.activeElement === close, visible: close.matches(':focus-visible'), outline: getComputedStyle(close).outlineStyle };
  });
  assert.ok(kb.focused && kb.visible && kb.outline !== 'none', `keyboard focus shows a ring: ${JSON.stringify(kb)}`);
  await ctx.close();
  assert.deepEqual(errors, []);
});
