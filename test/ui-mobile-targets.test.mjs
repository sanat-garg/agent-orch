// 44pt touch targets on touch screens (UI-REVIEW #5): boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir), opens the
// chat at 390×844 with hasTouch and checks every small control listed in the review is at least 44×44 CSS px: the
// composer chips, #send and the icon buttons by their box, #usRefresh and .convo .more by their box plus the 10px
// ::after hit area (and elementFromPoint just outside the glyph still hits the button). Drawer / Connections controls
// that need a task or an account are measured on stand-in elements with the same classes. A fine pointer keeps the
// desktop sizes, and the composer grows by at most one row. Skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'targets-ui-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-tgtui-'));
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
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/`);
  await page.locator('#app:not([inert]) #input').waitFor();
  await page.evaluate(() => { document.getElementById('orchBar').hidden = false; });
  return { ctx, page, errors };
}

// On-screen elements matching `sel` (not those in the closed, off-canvas sidebar): their boxes.
const boxes = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)]
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width && r.right > 0 && r.left < innerWidth && getComputedStyle(el).visibility !== 'hidden'; })
  .map((el) => { const r = el.getBoundingClientRect(); return { id: el.id || el.className || el.tagName, w: r.width, h: r.height }; }), sel);
// Stand-ins for the drawer / Connections controls that need a task or an account to show up.
const standIns = (page) => page.evaluate(() => {
  const host = document.createElement('div');
  host.innerHTML = '<button class="btn small" id="t-small">Cancel</button><select class="btn small" id="t-sel"><option>Normal</option></select>'
    + '<button class="cn-btn btn small" id="t-cn">Connect</button><details class="dr-prompt" id="t-dp"><summary>Details</summary>x</details>'
    + '<button class="icon-btn" id="t-icon">×</button><div class="orch-bar"><button class="chip" id="t-obchip">Q</button></div>';
  document.body.append(host);
  const out = {};
  for (const id of ['t-small', 't-sel', 't-cn', 't-icon', 't-obchip']) { const r = document.getElementById(id).getBoundingClientRect(); out[id] = { w: r.width, h: r.height }; }
  out['t-dp'] = { h: document.querySelector('#t-dp summary').getBoundingClientRect().height };
  host.remove();
  return out;
});
// A glyph button's hit area: its box grown by the ::after inset, and what a tap just outside the box lands on.
const hitArea = (page, sel) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  const r = el.getBoundingClientRect();
  const after = getComputedStyle(el, '::after');
  const inset = after.content === 'none' ? 0 : -parseFloat(after.top);
  const probe = (x, y) => { const t = document.elementFromPoint(x, y); return !!t && (t === el || el.contains(t)); };
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  return { w: r.width + 2 * inset, h: r.height + 2 * inset, inset, position: getComputedStyle(el).position,
    hits: { above: probe(cx, r.top - 8), below: probe(cx, r.bottom - 1 + 8), left: probe(r.left - 8, cy) } };
}, sel);
const composerHeights = (page) => page.evaluate(() => ({ composer: document.getElementById('composer').getBoundingClientRect().height,
  orchBar: document.getElementById('orchBar').getBoundingClientRect().height }));

test('390×844 touch: chat-screen controls are at least 44×44', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  const found = await boxes(page, '#send, .send, .icon-btn, .chip, .orch-bar .chip, .btn.small');
  const ids = found.map((b) => b.id);
  for (const id of ['send', 'openSidebar', 'modeChip', 'modelChip', 'fbChip']) assert.ok(ids.includes(id), `${id} visible: ${ids}`);
  for (const b of found) assert.ok(b.h >= 44, `${b.id} is ${b.w}×${b.h}`);
  for (const b of found.filter((b) => /^(send|openSidebar)$/.test(b.id))) assert.ok(b.w >= 44, `${b.id} is ${b.w}×${b.h}`);

  const s = await standIns(page);
  for (const id of ['t-small', 't-sel', 't-cn', 't-obchip']) assert.ok(s[id].h >= 44, `${id} is ${s[id].h} tall`);
  assert.ok(s['t-icon'].w >= 44 && s['t-icon'].h >= 44, `icon button ${s['t-icon'].w}×${s['t-icon'].h}`);
  assert.ok(s['t-dp'].h >= 44, `drawer Details summary is ${s['t-dp'].h} tall`);
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('390×844 touch: sidebar glyph buttons get a 44pt hit area without growing', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  await page.tap('#openSidebar');
  await page.locator('.app.side-open').waitFor();
  await page.waitForTimeout(400); // sidebar slide-in
  for (const sel of ['#usRefresh', '.convo .more']) {
    const a = await hitArea(page, sel);
    assert.equal(a.inset, 10, `${sel} ::after inset`);
    assert.ok(a.w >= 44 && a.h >= 44, `${sel} hit area ${a.w}×${a.h}`);
    assert.notEqual(a.position, 'static', `${sel} positions its ::after`);
    assert.ok(a.hits.above && a.hits.below && a.hits.left, `${sel} taps just outside the glyph land on it: ${JSON.stringify(a.hits)}`);
  }
  const glyphs = await page.evaluate(() => ['#usRefresh', '.convo .more'].map((s) => document.querySelector(s).getBoundingClientRect().width));
  assert.deepEqual(glyphs, [24, 28], 'the visible glyph buttons keep their size');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('390×844: touch grows the composer and orch bar by at most one row; a fine pointer keeps desktop sizes', { skip, timeout: 60000 }, async () => {
  const fine = await open({ width: 390, height: 844 }, false);
  const f = await composerHeights(fine.page);
  const sizes = await boxes(fine.page, '#send, #modelChip, #openSidebar');
  // The phone header's buttons fill its 44pt row whatever the pointer (#450).
  assert.deepEqual(sizes.map((b) => [b.id, b.w > 0 && b.h]), [['openSidebar', 44], ['modelChip', 30], ['send', 36]]);
  const after = await hitArea(fine.page, '#usRefresh');
  assert.equal(after.inset, 0, 'no enlarged hit area with a fine pointer');
  await fine.ctx.close();
  assert.deepEqual(fine.errors, []);

  const touch = await open({ width: 390, height: 844 });
  const t = await composerHeights(touch.page);
  assert.ok(t.composer - f.composer <= 44, `composer grew ${t.composer - f.composer}px`);
  assert.ok(t.orchBar - f.orchBar <= 44, `orch bar grew ${t.orchBar - f.orchBar}px`);
  await touch.ctx.close();
  assert.deepEqual(touch.errors, []);
});
