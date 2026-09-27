// Screenshots in a real browser: boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) on a spare port with a chat whose
// log holds images of very different sizes. Every thumbnail is the same fixed 160×100 box (two per row on phones), and the
// lightbox always shows the image at its natural pixel size (no fit option), scrolling when larger.
// Skips when Playwright's Chromium can't launch. CW_SHOTS_KEEP=1 leaves the server running for bin/shot.mjs.
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
import { saveMedia } from '../media.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'shots-ui-password';
const CID = 'chat-shots';
const SIZES = [[2400, 1500], [390, 2400], [900, 180], [120, 80], [1280, 800]];
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, imgs, taskId;
const GALLERY = 12;

// A w×h RGB PNG with diagonal bands, so object-position and scrolling are visible in screenshots.
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
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3, band = Math.floor((x + y) / 40) % 2;
    raw[o] = band ? 60 + seed * 40 : 230; raw[o + 1] = band ? 120 : 200 - y * 100 / h; raw[o + 2] = band ? 200 - seed * 30 : 150;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-shotsui-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Screenshots', cwd: dataDir, mode: 'chat',
    agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true }]));
  imgs = SIZES.map(([w, h], i) => saveMedia(dataDir, png(w, h, i), `shot-${w}x${h}-with-a-rather-long-file-name.png`));
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'logs', `${CID}.jsonl`), [
    { t: 'user', text: 'Take screenshots of the app', ts: 1 },
    ...imgs.map((m) => ({ t: 'image', ...m, ts: 2 })),
    { t: 'text', text: 'Here they are.', ts: 3 },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
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
  // A finished task whose run log holds 12 screenshots: the drawer shows them all as a compact gallery.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,created_at) VALUES(?,?,'active',0)").run(path.join(dataDir, 'gallery'), 'gallery').lastInsertRowid);
  taskId = Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,ran_agent,started_at,finished_at,created_at) VALUES(?,'work','Shoot every page','shoot','done','claude',1,2,0)").run(pid).lastInsertRowid);
  const gallery = Array.from({ length: GALLERY }, (_, i) => saveMedia(dataDir, png(320 + i * 20, 200, i % 5), `page-${i + 1}.png`));
  const log = path.join(dataDir, 'gallery-run.jsonl');
  fs.writeFileSync(log, [{ k: 'start', at: 1, agent: 'claude' }, { k: 'text', text: 'Shot every page.' }, ...gallery.map((m) => ({ k: 'image', ...m })), { k: 'end', at: 2, outcome: 'ok' }]
    .map((e) => JSON.stringify(e)).join('\n') + '\n');
  db.prepare("INSERT INTO runs(task_id,purpose,agent,outcome,started_at,finished_at,log_path) VALUES(?,'work','claude','ok',1,2,?)").run(taskId, log);
  db.close();
  if (process.env.CW_SHOTS_KEEP) console.log(`KEEP ${base} ${cookie}`);
});

after(async () => {
  await browser?.close();
  if (process.env.CW_SHOTS_KEEP) return;
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(viewport, mobile = false) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(mobile ? { viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${CID}`);
  await page.locator('#messages .shots .shot').nth(SIZES.length - 1).waitFor();
  return { ctx, page, errors };
}
const boxes = (page) => page.locator('#messages .shots .shot button').evaluateAll((els) => els.map((e) => {
  const r = e.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
}));

test('desktop: every thumbnail is the same 160×100 box; the lightbox always shows actual size, with no fit option', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  const b = await boxes(page);
  assert.deepEqual(b.map(({ w, h }) => [w, h]), SIZES.map(() => [160, 100]));
  const grid = await page.locator('#messages .shots').evaluate((g) => { const s = getComputedStyle(g); return [s.display, s.flexWrap, s.columnGap]; });
  assert.deepEqual(grid, ['flex', 'wrap', '8px']);
  assert.deepEqual(await page.locator('#messages .shot img').first().evaluate((i) => [getComputedStyle(i).objectFit, getComputedStyle(i).objectPosition]), ['cover', '50% 0%']);

  // The 2400×1500 image: natural size, larger than the view, so the view scrolls both ways. There is no fit toggle.
  await page.locator('#messages .shot button').first().click();
  const lb = page.locator('#lightbox');
  await lb.waitFor();
  await page.waitForFunction(() => document.querySelector('#lbImg').complete && document.querySelector('#lbImg').naturalWidth);
  const img = () => page.locator('#lbImg').evaluate((i) => [i.offsetWidth, i.offsetHeight]); // layout size (the panel's rise animation scales)
  assert.deepEqual(await img(), [2400, 1500]);
  assert.match(await page.locator('#lbSub').innerText(), /^2400 × 1500 px · 1 of 5/);
  assert.equal(await page.locator('#lightbox').getByText(/Fit to|Actual size/).count(), 0, 'no fit option');
  const scroll = await page.locator('#lbView').evaluate((v) => { v.scrollTo(300, 200); return [v.scrollLeft, v.scrollTop]; });
  assert.deepEqual(scroll, [300, 200]);

  // Every image is at its own pixel size: small ones are never upscaled, tall/wide ones never shrunk; prev/next and Esc work.
  for (let i = 1; i < SIZES.length; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction((w) => document.querySelector('#lbImg').naturalWidth === w && document.querySelector('#lbImg').complete, SIZES[i][0]);
    assert.deepEqual(await img(), SIZES[i], `image ${i + 1}`);
  }
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.querySelector('#lbImg').naturalWidth === 120);
  assert.match(await page.locator('#lbSub').innerText(), /^120 × 80 px · 4 of 5/);
  assert.match(await page.locator('#lbOpen').getAttribute('href'), new RegExp(`/api/media/${imgs[3].id}$`));
  await page.keyboard.press('Escape');
  assert.equal(await lb.isHidden(), true);
  await page.locator('#messages .shot button').nth(1).click();
  await page.waitForFunction(() => document.querySelector('#lbImg').naturalWidth === 390 && document.querySelector('#lbImg').complete);
  assert.deepEqual(await img(), [390, 2400]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: thumbnails are two per row filling the width at 16:10; the lightbox scrolls a large image', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844 }, true);
  const b = await boxes(page);
  assert.equal(new Set(b.map((x) => `${x.w}×${x.h}`)).size, 1, JSON.stringify(b));
  assert.ok(Math.abs(b[0].w / b[0].h - 1.6) < 0.03, JSON.stringify(b[0]));
  assert.equal(b[0].top, b[1].top);
  assert.ok(b[2].top > b[1].top);
  const row = await page.locator('#messages .shots').evaluate((g) => g.getBoundingClientRect().width);
  assert.ok(Math.abs(b[0].w * 2 + 8 - row) <= 2, `${b[0].w} ×2 + 8 vs ${row}`);
  await page.locator('#messages .shot button').nth(1).tap();
  await page.waitForFunction(() => document.querySelector('#lbImg').naturalWidth === 390);
  const [w, h, sh, ch] = await page.locator('#lbView').evaluate((v) => [v.querySelector('img').offsetWidth, v.querySelector('img').offsetHeight, v.scrollHeight, v.clientHeight]);
  assert.deepEqual([w, h], [390, 2400]);
  assert.ok(sh > ch);
  assert.match(await page.locator('#lbView').evaluate((v) => getComputedStyle(v).touchAction), /pinch-zoom|manipulation|auto/); // pan-x pan-y pinch-zoom computes to manipulation
  assert.deepEqual(errors, []);
  await ctx.close();
});

// The task drawer: every screenshot (not the last four plus "N more under Details") in a compact grid of equal small tiles.
async function drawerGallery(viewport, mobile) {
  const { ctx, page, errors } = await open(viewport, mobile);
  await page.evaluate((id) => openTask(id), taskId);
  await page.locator('#drBody .dr-shots-head').waitFor();
  const head = await page.locator('#drBody .dr-shots-head').innerText();
  const grid = page.locator('#drBody .dr-shots-head + .shots');
  const tiles = await grid.locator('.shot button').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; }));
  const info = await grid.evaluate((g) => ({ display: getComputedStyle(g).display, height: g.getBoundingClientRect().height, captions: [...g.querySelectorAll('figcaption')].some((f) => f.offsetHeight) }));
  const text = await page.locator('#drBody').innerText();
  return { ctx, page, errors, head, tiles, info, text };
}
test('task drawer: all screenshots in a compact gallery grid of small tiles; the lightbox pages through all of them', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, head, tiles, info, text } = await drawerGallery({ width: 1280, height: 800 });
  assert.equal(head, `Screenshots · ${GALLERY}`);
  assert.equal(tiles.length, GALLERY);
  assert.doesNotMatch(text, /more under Details/);
  assert.equal(info.display, 'grid');
  assert.equal(info.captions, false, 'names are tooltips, not captions');
  assert.equal(new Set(tiles.map((t) => `${t.w}×${t.h}`)).size, 1, JSON.stringify(tiles));
  assert.ok(tiles[0].w <= 110 && tiles[0].w >= 70, `small tiles: ${tiles[0].w}px`);
  assert.ok(Math.abs(tiles[0].w / tiles[0].h - 1.6) < 0.05);
  const perRow = tiles.filter((t) => t.top === tiles[0].top).length;
  assert.ok(perRow >= 4, `${perRow} per row`);
  assert.ok(info.height < 260, `the gallery stays compact: ${info.height}px`);
  await page.locator('#drBody .dr-shots-head + .shots .shot button').nth(2).click();
  await page.locator('#lightbox').waitFor();
  assert.match(await page.locator('#lbSub').innerText(), new RegExp(`· 3 of ${GALLERY}`));
  assert.deepEqual(errors, []);
  await ctx.close();
});
test('task drawer on a phone: the gallery fills the width with four small tiles per row', { skip, timeout: 60000 }, async () => {
  const { ctx, errors, tiles } = await drawerGallery({ width: 390, height: 844 }, true);
  assert.equal(tiles.length, GALLERY);
  assert.equal(tiles.filter((t) => t.top === tiles[0].top).length, 4, JSON.stringify(tiles.slice(0, 5)));
  assert.equal(new Set(tiles.map((t) => `${t.w}×${t.h}`)).size, 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// The sidebar's Claude limits card: model-specific windows the plan reports (model_scoped, e.g. Fable) get their own row
// under 5-hour and Weekly, and windows resetting together share one line of the note.
test('sidebar usage card: a Fable window gets its own row next to 5-hour and Weekly', { skip, timeout: 60000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${CID}`);
  await page.locator('#usageCard').waitFor();
  const card = await page.evaluate(() => {
    const week = new Date(Date.now() + 3 * 86400e3).toISOString(), soon = new Date(Date.now() + 2 * 3600e3).toISOString();
    M.usage = { available: true, updatedAt: Date.now(), session: { pct: 47, resetsAt: soon }, weekly: { pct: 18, resetsAt: week },
      weeklyOpus: null, weeklySonnet: null, models: [{ name: 'Fable', pct: 1, resetsAt: week }] };
    usageSlides.agent = 'claude';
    renderUsage();
    const rows = [...document.querySelectorAll('#usageCard .ms-row')].map((r) => [...r.children].map((c) => c.textContent.trim()));
    return { rows: rows.map(([l, , v]) => [l, v]), note: document.querySelector('#usNote').textContent, tip: document.querySelector('#usMore .ms-row')?.title || '' };
  });
  assert.deepEqual(card.rows, [['5-hour', '47%'], ['Weekly', '18%'], ['Fable', '1%']]);
  assert.match(card.note, /^5-hour resets .+\nWeekly and Fable reset .+$/);
  assert.match(card.tip, /^Fable: its own limit/);
  // Without a model-specific reading the card is the usual two rows.
  const plain = await page.evaluate(() => { M.usage = { ...M.usage, models: [] }; renderUsage(); return document.querySelectorAll('#usageCard .ms-row').length; });
  assert.equal(plain, 2);
  assert.deepEqual(errors, []);
  await ctx.close();
});
