// Zen mode (app.js setZen): Ctrl+. toggles a .zen class on #app and it survives a reload (localStorage cw.zen); in Zen
// the sidebar, orch bar and header extras are hidden, a finished task neither toasts nor plays a sound, a held approval
// shows as one quiet line, and leaving (Escape) shows "While you were in Zen" with the counts. Phones enter and leave it
// from the title menu and keep the composer. Boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) and feeds task
// events straight into app.js's onOrch. Skips when no Chromium can launch.
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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'zen-ui-password';
const CID = 'chat-zen';
let browser, skip = false;
try { browser = await chromium.launch(); } catch {
  try { browser = await chromium.launch({ executablePath: findBrowser() || undefined }); } catch (e) { skip = `no Chromium: ${e.message.split('\n')[0]}`; }
}
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-zenui-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const cwd = path.join(dataDir, 'p', 'zen-garden');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Zen garden', cwd, mode: 'chat', agent: 'claude', model: 'opus',
    createdAt: 1, updatedAt: 1, fullAccess: true, repo: { url: 'https://github.com/someone/zen-garden' } }]));
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

async function open(viewport, mobile = false) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport, ...(mobile && { isMobile: true, hasTouch: true }) });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${CID}`);
  await page.locator('#app:not([inert])').waitFor({ timeout: 15000 });
  // Count finish sounds and toasts from here on.
  await page.evaluate(() => {
    window.__sounds = 0;
    window.drainMachineSounds = async () => { window.__sounds += completionSound.queue.length; completionSound.queue.length = 0; };
    window.playTaskSound = async () => { window.__sounds++; };
    syncCompletionSound([]);
  });
  return { ctx, page, errors };
}
const zen = (page) => page.evaluate(() => document.getElementById('app').classList.contains('zen'));
const task = (id, status, extra = {}) => ({ id, project_id: 4242, kind: 'work', title: `Task ${id}`, status, approvals: [], ...extra });
const otask = (page, t) => page.evaluate((t) => onOrch({ t: 'otask', task: t }), t);
const toasts = (page) => page.locator('#toasts .toast').count();

test('Ctrl+. toggles .zen on #app, a reload keeps it, and it hides the chrome', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  assert.equal(await zen(page), false);
  assert.ok(await page.locator('#sidebar').isVisible());
  assert.ok(await page.locator('#zenBtn').isVisible(), 'the header has a Zen button');
  await page.keyboard.press('Control+.');
  assert.equal(await zen(page), true);
  assert.ok(Number(await page.evaluate(() => localStorage.getItem('cw.zen'))) > 0, 'remembered on this device');
  await page.reload();
  await page.locator('#app:not([inert])').waitFor();
  assert.equal(await zen(page), true, 'still in Zen after a reload');
  await page.waitForTimeout(300); // the 200 ms slide
  for (const id of ['sidebar', 'orchBar', 'usageCard', 'miniStatsCard', 'sideVer', 'repoLink', 'cwdLabel', 'zenBtn', 'updateBanner']) {
    assert.equal(await page.locator(`#${id}`).isVisible(), false, `#${id} hidden in Zen`);
  }
  const project = await page.evaluate(() => currentConvo().title);
  assert.equal(await page.locator('#title').textContent(), project, 'the project name');
  assert.ok(await page.locator('header .seg').isVisible(), 'the view switcher stays');
  assert.equal((await page.locator('#zenHint .zh-key').textContent()).trim(), 'Zen · Esc to exit');
  assert.ok(await page.locator('#zenHint .zh-key').isVisible());
  assert.ok(await page.locator('#composer').isVisible());
  const w = await page.evaluate(() => [document.querySelector('#messages').getBoundingClientRect().width, document.querySelector('#chatView').getBoundingClientRect().width]);
  assert.equal(w[0], 760, 'chat at a reading width');
  assert.equal(w[1], 1280, 'the view takes the whole window');
  // Files: full width, and the title still names the project.
  await page.locator('header .seg [data-view="files"]').click();
  assert.equal(await page.locator('#title').textContent(), project);
  assert.equal(await page.evaluate(() => document.querySelector('#filesView').getBoundingClientRect().width), 1280);
  await page.locator('header .seg [data-view="chat"]').click();
  await page.keyboard.press('Control+.');
  assert.equal(await zen(page), false);
  assert.equal(await page.evaluate(() => localStorage.getItem('cw.zen')), null);
  await page.waitForTimeout(300);
  assert.ok(await page.locator('#sidebar').isVisible(), 'the sidebar is back');
  assert.ok(await page.locator('#zenModal').isHidden(), 'nothing happened, so no summary');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('in Zen a finished task neither toasts nor chimes; an approval is one quiet line; leaving sums it up', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  // Outside Zen the same events do toast and chime (so the checks below can fail).
  await otask(page, task(900, 'running'));
  await otask(page, task(900, 'done'));
  await page.evaluate(() => onOrch({ t: 'oapproval', kind: 'new', approval: { id: 'ap0', task: 900, action: 'Click Send' } }));
  assert.equal(await page.evaluate(() => window.__sounds), 2, 'a finish and an approval chime outside Zen');
  assert.equal(await toasts(page), 1, 'an approval toasts outside Zen');
  await page.evaluate(() => onOrch({ t: 'oapproval', kind: 'resolved', approval: { id: 'ap0', task: 900 } }));
  await page.evaluate(() => { window.__sounds = 0; });

  await page.locator('#zenBtn').click();
  assert.equal(await zen(page), true);
  await page.waitForTimeout(500); // the open toast closes
  assert.equal(await toasts(page), 0, 'entering Zen clears toasts');
  for (const id of [1, 2, 3, 4]) await otask(page, task(id, 'running'));
  await otask(page, task(1, 'done'));
  await otask(page, task(2, 'done'));
  await page.evaluate(() => toast('Something happened'));
  assert.equal(await toasts(page), 0, 'no toast element for a task-done event (or any toast) in Zen');
  assert.equal(await page.evaluate(() => window.__sounds), 0, 'finish sounds muted');
  assert.ok(await page.locator('#zenQuiet').isHidden(), 'nothing needs the owner yet');

  await page.evaluate(() => onOrch({ t: 'oapproval', kind: 'new', approval: { id: 'ap1', task: 3, action: 'Click "Send" on mail.google.com' } }));
  assert.equal(await toasts(page), 0);
  assert.equal(await page.evaluate(() => window.__sounds), 0);
  assert.ok(await page.locator('#zenQuiet').isVisible());
  assert.equal(await page.locator('#zenQuiet').textContent(), '1 approval waiting');
  await otask(page, task(4, 'failed'));
  assert.equal(await page.locator('#zenQuiet').textContent(), '1 approval · 1 failed task waiting');
  assert.equal(await toasts(page), 0);

  await page.locator('#messages').click({ position: { x: 5, y: 5 } }); // focus outside the composer's fields
  await page.keyboard.press('Escape');
  assert.equal(await zen(page), false, 'Escape leaves Zen');
  await page.locator('#zenModal:not([hidden])').waitFor();
  assert.equal(await page.locator('#zenTitle').textContent(), 'While you were in Zen');
  assert.match(await page.locator('#zenSub').textContent(), /2 done, 1 failed, 1 waiting for you$/);
  const groups = await page.locator('#zenBody .zs-group').evaluateAll((gs) => gs.map((g) => [g.dataset.k, g.querySelectorAll('li').length]));
  assert.deepEqual(groups, [['waiting', 1], ['failed', 1], ['done', 2]]);
  assert.ok(await page.locator('#zenQuiet').isHidden(), 'the quiet line goes with Zen');
  await page.keyboard.press('Escape');
  assert.ok(await page.locator('#zenModal').isHidden(), 'the summary dismisses');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('phones: the title menu enters Zen, the header extras and orch bar hide, the composer stays', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844 }, true);
  await page.locator('#viewBtn').click();
  await page.locator('#viewMenuZen').click();
  assert.equal(await zen(page), true);
  for (const id of ['openSidebar', 'topAction', 'orchBar', 'zenBtn']) assert.equal(await page.locator(`#${id}`).isVisible(), false, `#${id} hidden`);
  assert.ok(await page.locator('#composer').isVisible());
  assert.ok(await page.locator('#input').isVisible());
  assert.ok(await page.locator('#viewBtn').isVisible(), 'the title still switches views');
  await page.locator('#viewBtn').click();
  assert.ok(await page.locator('#viewMenuRepo').isHidden(), 'no repo link in the menu');
  await page.keyboard.press('Escape');
  const exit = page.locator('#zenHint');
  assert.equal((await exit.locator('.zh-tap').textContent()).trim(), 'Exit Zen');
  assert.ok((await exit.boundingBox()).height >= 44, 'a 44pt target');
  await exit.click();
  assert.equal(await zen(page), false);
  assert.ok(await page.locator('#openSidebar').isVisible());
  await ctx.close();
  assert.deepEqual(errors, []);
});
