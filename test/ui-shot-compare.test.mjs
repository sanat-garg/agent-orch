// Comparing two gallery screenshots (shots.js) in a real browser: boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir)
// on a spare port with two projects whose tasks' run logs hold screenshots. The owner ticks exactly two tiles, Compare shows
// them side by side (stacked on phones) labelled with task, name and time; Back/Clear/Escape leave it, the lightbox and the
// task headings still work, a missing image reads "No longer available", and switching project drops the picks.
// Skips when Playwright's Chromium can't launch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrowser } from '../browser.mjs';
import { saveMedia } from '../media.mjs';
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'shot-compare-password';
const CID = 'chat-web', CID2 = 'chat-other';
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() };
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, loginId, homeId, m;

// A w×h solid-colour RGB PNG.
function png(w, h, seed) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (~c) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = seed * 50; raw[o + 1] = 120; raw[o + 2] = 200 - seed * 30; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-shotcmp-'));
  const web = path.join(dataDir, 'web'), other = path.join(dataDir, 'other');
  fs.mkdirSync(web); fs.mkdirSync(other);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const convo = (id, title, cwd) => ({ id, title, cwd, mode: 'chat', agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([convo(CID, 'Web', web), convo(CID2, 'Other', other)]));
  // A wide desktop shot and a tall phone shot, so aspect ratios can be checked; two more in the other project.
  m = [['login-desktop', 640, 400], ['home-phone', 200, 400], ['home-desktop', 640, 400], ['other-a', 320, 200], ['other-b', 320, 200]]
    .map(([n, w, h], i) => saveMedia(dataDir, png(w, h, i % 4), `${n}.png`));
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
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const project = (p, name) => Number(db.prepare("INSERT INTO projects(path,name,status,created_at) VALUES(?,?,'active',0)").run(p, name).lastInsertRowid);
  const task = (pid, title) => Number(db.prepare(`INSERT INTO tasks(project_id,kind,title,prompt,status,ran_agent,started_at,finished_at,created_at)
    VALUES(?,'work',?,'build','done','claude',1,100,0)`).run(pid, title).lastInsertRowid);
  const runOf = (id, name, entries) => {
    const log = path.join(dataDir, `${name}.jsonl`);
    fs.writeFileSync(log, [{ k: 'start', at: 1, agent: 'claude' }, ...entries].map((e) => JSON.stringify(e)).join('\n') + '\n');
    db.prepare("INSERT INTO runs(task_id,purpose,agent,outcome,started_at,finished_at,log_path) VALUES(?,'work','claude','ok',1,100,?)").run(id, log);
  };
  const pid = project(web, 'web'), pid2 = project(other, 'other');
  loginId = task(pid, 'Restyle the login page');
  runOf(loginId, 'login', [{ k: 'image', ...m[0], at: 1000 }]);
  homeId = task(pid, 'Add a hero to the home page');
  runOf(homeId, 'home', [{ k: 'image', ...m[1], at: 2000 }, { k: 'image', ...m[2], at: 2100 }]);
  runOf(task(pid2, 'Other work'), 'other', [{ k: 'image', ...m[3], at: 3000 }, { k: 'image', ...m[4], at: 3100 }]);
  db.close();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function openGallery({ viewport = { width: 1280, height: 800 }, missing } = {}) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (missing) await page.route(`**/api/media/${missing}`, (r) => r.fulfill({ status: 404, body: 'gone' }));
  await page.goto(`${base}/#${CID}`);
  await page.waitForFunction(() => !document.getElementById('shotsLink').hidden);
  if (viewport.width > 767) await page.locator('#shotsLink').click();
  else { await page.locator('#viewBtn').click(); await page.locator('#viewMenuShots').click(); } // phones: the title menu
  await page.locator('#shotsModal .sh-latest .shot-final').waitFor();
  return { ctx, page, errors };
}
const tile = (page, name) => page.locator(`#shBody .shot[data-name="${name}"]`);
const pick = (page, name) => tile(page, name).locator('.sh-pick input');

test('tick exactly two screenshots, compare them side by side with labels, then Back, lightbox, task and Clear', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await openGallery();
  assert.equal(await page.locator('.sh-cmp-msg').innerText(), 'Tick two screenshots to compare them');
  // Gallery ordering is unchanged by the picks.
  const order = () => page.locator('#shBody .shot').evaluateAll((fs) => fs.map((f) => f.dataset.name));
  const before = await order();
  assert.deepEqual(before, ['home-desktop.png', 'home-phone.png', 'login-desktop.png']);
  await pick(page, 'login-desktop.png').check();
  assert.match(await page.locator('.sh-cmp-msg').innerText(), /^1 selected/);
  assert.equal(await page.locator('.sh-cmp-go').count(), 0, 'one pick cannot be compared');
  await pick(page, 'home-phone.png').check();
  assert.equal(await page.locator('.sh-cmp-msg').innerText(), '2 selected');
  // A third can't be ticked while two are picked; unticking one frees it again.
  assert.equal(await pick(page, 'home-desktop.png').isDisabled(), true);
  assert.deepEqual(await order(), before);
  assert.equal(await page.locator('#shBody .shot.picked').count(), 2);

  await page.locator('.sh-cmp-go').click();
  await page.locator('.shc .shc-panel').nth(1).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.shc img')].every((i) => i.complete && i.naturalWidth));
  const panels = await page.locator('.shc-panel').evaluateAll((ps) => ps.map((p) => {
    const img = p.querySelector('img').getBoundingClientRect();
    return { task: p.querySelector('.sh-tid').textContent + ' ' + p.querySelector('.sh-ttl').textContent, name: p.querySelector('.shc-name').textContent,
      time: p.querySelector('.shc-time').textContent, datetime: p.querySelector('.shc-time').dateTime, ratio: +(img.width / img.height).toFixed(2), left: Math.round(img.left), top: Math.round(img.top) };
  }));
  assert.deepEqual(panels.map(({ task, name, datetime, ratio }) => ({ task, name, datetime, ratio })), [
    { task: `#${loginId} Restyle the login page`, name: 'login-desktop.png', datetime: new Date(1000e3).toISOString(), ratio: 1.6 },
    { task: `#${homeId} Add a hero to the home page`, name: 'home-phone.png', datetime: new Date(2000e3).toISOString(), ratio: 0.5 },
  ]);
  assert.ok(panels.every((p) => p.time), 'each panel shows its time');
  assert.ok(panels[1].left > panels[0].left + 200, 'desktop: side by side');
  assert.equal(await page.locator('#shBody .sh-pick').count(), 0);

  // Tapping a compared image opens the lightbox over just the two; Escape closes the lightbox, then leaves the comparison.
  await page.locator('.shc-panel').nth(1).locator('.shot button').click();
  await page.locator('#lightbox').waitFor();
  assert.equal(await page.locator('#lbTitle').innerText(), 'home-phone.png');
  assert.match(await page.locator('#lbSub').innerText(), /2 of 2/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#lightbox').isHidden(), true);
  assert.equal(await page.locator('.shc').isVisible(), true);
  await page.keyboard.press('Escape');
  await page.locator('#shBody .sh-latest').waitFor();
  assert.equal(await page.locator('#shotsModal').isVisible(), true);
  assert.equal(await page.locator('#shBody .shot.picked').count(), 2, 'Escape keeps the picks');

  // Back also returns to the gallery with the picks kept.
  await page.locator('.sh-cmp-go').click();
  await page.locator('.shc-back').click();
  await page.locator('#shBody .sh-latest').waitFor();
  assert.equal(await pick(page, 'home-phone.png').isChecked(), true);

  // A compared task's heading still opens the task.
  await page.locator('.sh-cmp-go').click();
  await page.locator('.shc-panel .sh-task', { hasText: 'Restyle the login page' }).click();
  assert.equal(await page.locator('#shotsModal').isHidden(), true);
  await page.waitForFunction((id) => O.drawer === id, loginId);

  // Reopened, the gallery shows (not the comparison) with the picks; Clear inside a comparison drops them.
  await page.evaluate(() => Shots.open());
  await page.locator('#shBody .sh-latest').waitFor();
  assert.equal(await page.locator('#shBody .shot.picked').count(), 2);
  await page.locator('.sh-cmp-go').click();
  await page.locator('.shc-bar .sh-cmp-clear').click();
  await page.locator('#shBody .sh-latest').waitFor();
  assert.equal(await page.locator('#shBody .shot.picked').count(), 0);
  assert.equal(await page.locator('.sh-cmp-msg').innerText(), 'Tick two screenshots to compare them');
  assert.equal(await pick(page, 'home-desktop.png').isDisabled(), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('on a phone the two compared screenshots stack, full width', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await openGallery({ viewport: { width: 390, height: 844 } });
  await pick(page, 'home-desktop.png').check();
  await pick(page, 'login-desktop.png').check();
  await page.locator('.sh-cmp-go').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.shc img')].every((i) => i.complete && i.naturalWidth));
  const r = await page.locator('.shc-panel').evaluateAll((ps) => ps.map((p) => p.getBoundingClientRect()).map((b) => ({ left: Math.round(b.left), top: Math.round(b.top), bottom: Math.round(b.bottom), width: b.width })));
  assert.equal(r[0].left, r[1].left);
  assert.ok(r[1].top >= r[0].bottom, 'stacked');
  assert.ok(r[0].width > 300);
  assert.equal(await page.locator('.shc-back').isVisible(), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a compared screenshot that fails to load reads "No longer available"', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await openGallery({ missing: m[1].id });
  await pick(page, 'home-phone.png').check();
  await pick(page, 'home-desktop.png').check();
  await page.locator('.sh-cmp-go').click();
  await page.locator('.shc-panel').nth(1).waitFor();
  const missing = page.locator('.shc-panel', { hasText: 'home-phone.png' }).locator('.shot-missing');
  await missing.waitFor();
  assert.equal(await missing.innerText(), 'No longer available');
  // Its label still says what it was; the other image shows normally.
  assert.equal(await page.locator('.shc-panel').nth(0).locator('.shc-name').innerText(), 'home-phone.png');
  await page.locator('.shc-panel', { hasText: 'home-desktop.png' }).locator('img').waitFor();
  assert.equal(await page.locator('.shc-panel', { hasText: 'home-desktop.png' }).locator('.shot-missing').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('switching project drops the picks and leaves the comparison', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await openGallery();
  await pick(page, 'home-phone.png').check();
  await pick(page, 'login-desktop.png').check();
  await page.locator('.sh-cmp-go').click();
  await page.locator('.shc').waitFor();
  await page.evaluate((cid) => { location.hash = cid; }, CID2);
  await page.waitForFunction(() => O.project?.name === 'other');
  // The open sheet now shows the other project's gallery, nothing ticked.
  await tile(page, 'other-a.png').waitFor();
  assert.equal(await page.locator('.shc').count(), 0);
  assert.equal(await page.locator('#shBody .shot.picked').count(), 0);
  assert.equal(await page.locator('.sh-cmp-msg').innerText(), 'Tick two screenshots to compare them');
  // And back: the first project's picks are gone too.
  await page.evaluate((cid) => { location.hash = cid; }, CID);
  await page.waitForFunction(() => O.project?.name === 'web');
  await tile(page, 'login-desktop.png').waitFor();
  assert.equal(await page.locator('#shBody .shot.picked').count(), 0);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#shBody .sh-pick input:checked').length), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});
