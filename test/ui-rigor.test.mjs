// Settings → This project → Rigor (#779) in a real browser against server.mjs (temporary HOME, data and port; no
// orchestrator). GET /api/orch/rigor-levels and the project's PATCH are mocked with page.route, and the open project is
// set on the page (O.project) the way a project push would:
// - the 5 steps render with their names and the project's level is the checked one ('4 · Robust' + its summary, what it's best for and its dial meters);
// - moving (click, drag, arrow keys) updates the 'Example task at this level' card: title, a 4-line prompt excerpt
//   (expandable) and done_when;
// - a click / release saves PATCH {rigor} with the toast; arrows save after a pause; an old server's 404 falls back to POST;
// - on a phone every step is at least 44px tall.
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
const PASSWORD = 'rigor-ui-password';
const NAMES = ['Sketch', 'Ship it', 'Solid', 'Robust', 'Hardened'];
const LEVELS = NAMES.map((name, i) => ({
  level: i + 1, name, summary: `Summary of level ${i + 1}`, use: `use ${i + 1}`,
  dials: [{ key: 'tests', label: 'Tests', value: i > 3 ? 4 : i, text: `tests ${i + 1}` }, { key: 'security', label: 'Security', value: i > 2 ? i - 2 : 0, text: `security ${i + 1}` }],
  example: {
    title: `Add a contact form (level ${i + 1})`,
    prompt: Array.from({ length: 3 + i * 2 }, (_, k) => `L${i + 1} prompt line ${k + 1}`).join('\n'),
    done_when: `done when ${i + 1}`,
  },
}));
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() }; // the MacBook worker's LaunchDaemon needs a shim (helpers/mac-chromium.mjs)
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, root, cookie;

before(async () => {
  if (skip) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rigor-'));
  const home = path.join(root, 'home'), dataDir = path.join(root, 'data'), proj = path.join(root, 'demo');
  for (const d of [home, dataDir, proj]) fs.mkdirSync(d, { recursive: true });
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

// Opens Settings on a page whose open project is at `rigor`. saves: every request to the project endpoint.
async function open({ rigor = 4, mobile = false, patch = 'ok' } = {}) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript(() => localStorage.setItem('cw.lastSeen', String(Date.now())));
  const page = await ctx.newPage();
  const errors = [], saves = [];
  page.on('pageerror', (e) => { if (!/renderMetrics/.test(e.stack)) errors.push(e.message); });
  await page.route('**/api/orch/rigor-levels', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(LEVELS) }));
  await page.route('**/api/orch/project/7', (r) => {
    const q = r.request();
    saves.push({ method: q.method(), body: q.postDataJSON() });
    if (q.method() === 'PATCH' && patch === '404') return r.fulfill({ status: 404, body: 'Not found' });
    return r.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.goto(`${base}/#c0`);
  await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
  await page.evaluate((rigor) => { O.project = { id: 7, path: '/w/demo', perpetual: 1, rigor, reflect: { pool: [] } }; openSettings(); }, rigor);
  await page.locator('#stRigorExample:not([hidden])').waitFor();
  return { page, ctx, errors, saves };
}
const state = (page) => page.evaluate(() => ({
  checked: [...document.querySelectorAll('#stRigor [role="radio"]')].filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.dataset.level),
  focusable: [...document.querySelectorAll('#stRigor [role="radio"]')].filter((b) => b.tabIndex === 0).map((b) => b.dataset.level),
  name: document.getElementById('stRigorName').textContent,
  summary: document.getElementById('stRigorSummary').textContent,
  title: document.getElementById('stRigorExTitle').textContent,
  prompt: document.getElementById('stRigorExPrompt').textContent,
  done: document.getElementById('stRigorExDone').textContent,
}));
const toasts = (page) => page.$$eval('#toasts .toast:not(.toast-out) .toast-msg', (ts) => ts.map((t) => t.textContent));
const until = async (fn, what = 'condition') => {
  for (const t0 = Date.now(); Date.now() - t0 < 8000; await new Promise((r) => setTimeout(r, 50))) if (await fn()) return;
  assert.fail(`timed out waiting for ${what}`);
};

test('the 5 steps render with their names, the hint, and the project\'s level checked with its example', { skip, timeout: 60000 }, async () => {
  const { page, ctx, errors, saves } = await open({ rigor: 4 });
  const steps = await page.$$eval('#stRigor [role="radio"]', (bs) => bs.map((b) => [b.querySelector('b').textContent, b.querySelector('.rg-name').textContent, b.getAttribute('aria-label')]));
  assert.deepEqual(steps, NAMES.map((n, i) => [String(i + 1), n, `${i + 1} · ${n}`]));
  assert.equal(await page.getAttribute('#stRigor', 'role'), 'radiogroup');
  assert.equal(await page.textContent('#stRigorHint'), 'Used by the chat planner and reflection for this project. Each step adds a notch of testing, error handling and care; security work starts at 4.');
  assert.equal(await page.textContent('#stRigorExample .rg-ex-head'), 'Example task at this level');
  assert.deepEqual(await state(page), { checked: ['4'], focusable: ['4'], name: '4 · Robust', summary: 'Summary of level 4',
    title: 'Add a contact form (level 4)', prompt: LEVELS[3].example.prompt, done: 'done when 4' });
  // A project without a level yet (a server from before rigor) shows 3, like the migration.
  await page.evaluate(() => { O.project = { ...O.project, rigor: undefined }; renderSettings(); });
  assert.equal((await state(page)).name, '3 · Solid');
  // What it's best for, and each dial as a 4-notch meter with its text.
  await page.evaluate(() => { O.project = { ...O.project, rigor: 4 }; renderSettings(); });
  assert.equal(await page.textContent('#stRigorUse'), 'Best for: use 4');
  assert.deepEqual(await page.$$eval('#stRigorDials li', (ls) => ls.map((li) => [li.dataset.dial, li.querySelector('.rg-dial-k').textContent,
    li.querySelectorAll('.rg-meter i.on').length, li.querySelectorAll('.rg-meter i').length, li.querySelector('.rg-dial-v').textContent])),
  [['tests', 'Tests', 3, 4, 'tests 4'], ['security', 'Security', 1, 4, 'security 4']]);
  assert.deepEqual(saves, [], 'showing saves nothing');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('moving the slider updates the example card; the prompt shows 4 lines and expands', { skip, timeout: 60000 }, async () => {
  const { page, ctx, errors } = await open({ rigor: 2 });
  assert.equal((await state(page)).title, 'Add a contact form (level 2)');
  // Level 2's 5-line prompt is clipped to 4 lines, with a button to see it all.
  const lh = await page.$eval('#stRigorExPrompt', (p) => parseFloat(getComputedStyle(p).lineHeight));
  const box = async () => page.$eval('#stRigorExPrompt', (p) => p.clientHeight);
  assert.ok(Math.abs(await box() - 4 * lh) < 2, `4 lines tall (${await box()} vs ${4 * lh})`);
  assert.equal(await page.isVisible('#stRigorExMore'), true);
  assert.equal(await page.textContent('#stRigorExMore'), 'Show full prompt');
  await page.click('#stRigorExMore');
  assert.ok(Math.abs(await box() - 5 * lh) < 2, 'all 5 lines');
  assert.equal(await page.getAttribute('#stRigorExMore', 'aria-expanded'), 'true');
  await page.click('#stRigorExMore');
  assert.ok(Math.abs(await box() - 4 * lh) < 2, 'back to 4');

  // Dragging previews every step under the pointer; the release is what saves.
  const r = await page.locator('#stRigor').boundingBox(), x = (lv) => r.x + (r.width * (lv - 0.5)) / 5, y = r.y + r.height / 2;
  await page.mouse.move(x(2), y);
  await page.mouse.down();
  for (const lv of [3, 4, 5]) {
    await page.mouse.move(x(lv), y, { steps: 3 });
    const s = await state(page);
    assert.deepEqual([s.checked, s.name, s.title, s.done], [[String(lv)], `${lv} · ${NAMES[lv - 1]}`, `Add a contact form (level ${lv})`, `done when ${lv}`]);
  }
  await page.mouse.move(x(1), y, { steps: 3 });
  assert.equal((await state(page)).title, 'Add a contact form (level 1)');
  // Level 1's 3-line prompt fits: no button.
  assert.equal(await page.isVisible('#stRigorExMore'), false);
  await page.mouse.up();
  await until(async () => (await toasts(page)).length, 'the toast');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a click saves PATCH {rigor} with the toast; arrows preview and save after a pause', { skip, timeout: 60000 }, async () => {
  const { page, ctx, errors, saves } = await open({ rigor: 4 });
  await page.click('#stRigor [data-level="2"]');
  await until(async () => (await toasts(page)).length, 'the toast');
  assert.deepEqual(saves, [{ method: 'PATCH', body: { rigor: 2 } }]);
  assert.deepEqual(await toasts(page), ['Rigor set to 2 · Ship it: applies to new planning and reflection']);
  assert.equal(await page.evaluate(() => O.project.rigor), 2);
  assert.equal((await state(page)).name, '2 · Ship it');
  // A push with the saved level keeps it.
  await page.evaluate(() => { O.project = { ...O.project, rigor: 2 }; renderSettings(); });
  assert.deepEqual((await state(page)).checked, ['2']);

  // Keyboard: the checked step has focus; arrows move the check (and focus) and preview; Home/End jump.
  assert.equal(await page.evaluate(() => document.activeElement.dataset.level), '2');
  await page.keyboard.press('ArrowRight');
  let s = await state(page);
  assert.deepEqual([s.checked, s.focusable, s.title], [['3'], ['3'], 'Add a contact form (level 3)']);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.level), '3');
  await page.keyboard.press('End');
  assert.equal((await state(page)).name, '5 · Hardened');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowUp');
  assert.equal((await state(page)).title, 'Add a contact form (level 2)');
  await page.keyboard.press('ArrowRight');
  assert.equal(saves.length, 1, 'nothing saved while the arrows move');
  await until(() => saves.length === 2, 'the save after the pause');
  assert.deepEqual(saves[1], { method: 'PATCH', body: { rigor: 3 } });
  await until(async () => (await toasts(page)).includes('Rigor set to 3 · Solid: applies to new planning and reflection'), 'the second toast');
  // Clicking the level it already has saves nothing.
  await page.click('#stRigor [data-level="3"]');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(saves.length, 2);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a server without the PATCH route gets the same body as a POST', { skip, timeout: 60000 }, async () => {
  const { page, ctx, errors, saves } = await open({ rigor: 3, patch: '404' });
  await page.click('#stRigor [data-level="1"]');
  await until(async () => (await toasts(page)).length, 'the toast');
  assert.deepEqual(saves, [{ method: 'PATCH', body: { rigor: 1 } }, { method: 'POST', body: { rigor: 1 } }]);
  assert.deepEqual(await toasts(page), ['Rigor set to 1 · Sketch: applies to new planning and reflection']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('on a phone the steps and the prompt button are 44px tall', { skip, timeout: 60000 }, async () => {
  const { page, ctx, errors, saves } = await open({ rigor: 2, mobile: true });
  const hs = await page.$$eval('#stRigor [role="radio"]', (bs) => bs.map((b) => b.getBoundingClientRect().height));
  assert.equal(hs.length, 5);
  for (const h of hs) assert.ok(h >= 44, `step ${h}px`);
  assert.ok((await page.locator('#stRigorExMore').boundingBox()).height >= 44);
  await page.tap('#stRigor [data-level="3"]');
  await until(() => saves.length === 1, 'the tap saves');
  assert.deepEqual(saves[0], { method: 'PATCH', body: { rigor: 3 } });
  assert.deepEqual(errors, []);
  await ctx.close();
});
