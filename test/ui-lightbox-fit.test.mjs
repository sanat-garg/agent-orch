// Lightbox fit mode in a real browser: boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) on a spare port with a chat
// holding a 2400×1600 and a 300×200 image, and a finished task with the same two screenshots in its drawer.
// - The lightbox opens in Fit: the whole image inside the view, aspect ratio kept, no scroll overflow; a small image is
//   never upscaled. The header toggle and a double-click switch to Actual size (natural pixels, scrolling) and back;
//   the choice holds while paging and resets to Fit on the next opening.
// - Chat and drawer thumbnails show the whole image (object-fit: contain) in their uniform box.
// Skips when Chromium can't launch.
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
const PASSWORD = 'lightbox-fit-password';
const CID = 'chat-fit';
const SIZES = [[2400, 1600], [300, 200]];
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() }; // the MacBook worker's LaunchDaemon needs a shim (helpers/mac-chromium.mjs)
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, taskId;

function png(w, h) {
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
    raw[o] = band ? 80 : 230; raw[o + 1] = band ? 120 : 200; raw[o + 2] = band ? 200 : 150;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lbfit-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Fit', cwd: dataDir, mode: 'chat',
    agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true }]));
  const imgs = SIZES.map(([w, h]) => saveMedia(dataDir, png(w, h), `shot-${w}x${h}.png`));
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'logs', `${CID}.jsonl`), [
    { t: 'user', text: 'Take screenshots', ts: 1 }, ...imgs.map((m) => ({ t: 'image', ...m, ts: 2 })), { t: 'text', text: 'Done.', ts: 3 },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
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
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,created_at) VALUES(?,?,'active',0)").run(path.join(dataDir, 'p'), 'p').lastInsertRowid);
  taskId = Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,ran_agent,started_at,finished_at,created_at) VALUES(?,'work','Shoot','shoot','done','claude',1,2,0)").run(pid).lastInsertRowid);
  const log = path.join(dataDir, 'run.jsonl');
  fs.writeFileSync(log, [{ k: 'start', at: 1, agent: 'claude' }, ...imgs.map((m) => ({ k: 'image', ...m })), { k: 'end', at: 2, outcome: 'ok' }]
    .map((e) => JSON.stringify(e)).join('\n') + '\n');
  db.prepare("INSERT INTO runs(task_id,purpose,agent,outcome,started_at,finished_at,log_path) VALUES(?,'work','claude','ok',1,2,?)").run(taskId, log);
  db.close();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(viewport, mobile = false) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(mobile ? { viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' } : { viewport, reducedMotion: 'reduce' });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${CID}`);
  await page.locator('#messages .shots .shot').nth(SIZES.length - 1).waitFor();
  return { ctx, page, errors };
}
const loaded = (page, w) => page.waitForFunction((w) => { const i = document.querySelector('#lbImg'); return i.complete && i.naturalWidth === w; }, w);
// Layout sizes (offset*, unaffected by the panel's rise animation), the view's box and its scroll extents.
const measure = (page) => page.evaluate(() => {
  const v = document.querySelector('#lbView'), i = v.querySelector('img');
  return { w: i.offsetWidth, h: i.offsetHeight, vw: v.clientWidth, vh: v.clientHeight, sw: v.scrollWidth, sh: v.scrollHeight,
    fit: v.classList.contains('fit'), objectFit: getComputedStyle(i).objectFit, overflow: getComputedStyle(v).overflow,
    zoom: document.querySelector('#lbZoom').textContent.trim(), sub: document.querySelector('#lbSub').textContent };
});
function assertFitted(m, [nw, nh], viewportW) {
  assert.ok(m.fit, 'fit mode');
  assert.equal(m.objectFit, 'contain');
  assert.ok(m.w <= m.vw && m.h <= m.vh, `image ${m.w}×${m.h} inside view ${m.vw}×${m.vh}`);
  assert.ok(m.w <= viewportW, `image width ${m.w} ≤ viewport ${viewportW}`);
  assert.ok(Math.abs(m.w / m.h - nw / nh) / (nw / nh) < 0.01, `aspect ${m.w}/${m.h} vs ${nw}/${nh}`);
  assert.ok(m.sw <= m.vw && m.sh <= m.vh, `no scroll overflow: ${m.sw}×${m.sh} in ${m.vw}×${m.vh}`);
  assert.ok(m.w === m.vw || m.h === m.vh || (m.w === nw && m.h === nh), 'fills one side, or is at natural size');
}

for (const [label, viewport, mobile] of [['desktop', { width: 1280, height: 800 }, false], ['phone', { width: 390, height: 844 }, true]]) {
  test(`${label}: the lightbox opens fitted, never upscales, and toggles to actual size`, { skip, timeout: 60000 }, async () => {
    const { ctx, page, errors } = await open(viewport, mobile);
    await page.locator('#messages .shot button').first().click();
    await page.locator('#lightbox').waitFor();
    await loaded(page, 2400);
    let m = await measure(page);
    assertFitted(m, SIZES[0], viewport.width);
    assert.ok(m.w < 2400, 'large image scaled down');
    assert.equal(m.zoom, 'Actual size');
    assert.match(m.sub, /^2400 × 1600 px/);
    assert.equal(await page.locator('#lbView').evaluate((v) => { v.scrollTo(200, 200); return v.scrollLeft + v.scrollTop; }), 0, 'fit does not scroll');

    // The toggle: actual size (natural pixels, scrolls), then back to fit.
    await page.locator('#lbZoom').click();
    m = await measure(page);
    assert.equal(m.fit, false);
    assert.deepEqual([m.w, m.h], [2400, 1600]);
    assert.ok(m.sw > m.vw && m.sh > m.vh, 'actual size scrolls');
    assert.equal(m.zoom, 'Fit');
    assert.equal(await page.locator('#lbZoom').getAttribute('aria-pressed'), 'true');
    // The choice holds while paging: the small image at actual size is its natural size.
    await page.locator('#lbNext').click();
    await loaded(page, 300);
    m = await measure(page);
    assert.deepEqual([m.fit, m.w, m.h], [false, 300, 200]);
    await page.locator('#lbZoom').click();
    m = await measure(page);
    // Fit never upscales a small image.
    assertFitted(m, SIZES[1], viewport.width);
    assert.deepEqual([m.w, m.h], [300, 200]);

    // Double-click toggles too (desktop: dblclick; phone: a double tap).
    await page.locator('#lbPrev').click();
    await loaded(page, 2400);
    if (mobile) { await page.locator('#lbImg').tap(); await page.locator('#lbImg').tap(); }
    else await page.locator('#lbImg').dblclick();
    m = await measure(page);
    assert.deepEqual([m.fit, m.w], [false, 2400]);
    if (mobile) { await page.waitForTimeout(700); await page.locator('#lbView').tap(); await page.locator('#lbView').tap(); }
    else await page.locator('#lbView').dblclick();
    assertFitted(await measure(page), SIZES[0], viewport.width);

    // Switched to actual size, closed, reopened: fit again (the choice lasts one lightbox session).
    await page.locator('#lbZoom').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#lightbox').isHidden(), true);
    await page.locator('#messages .shot button').first().click();
    await loaded(page, 2400);
    assertFitted(await measure(page), SIZES[0], viewport.width);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('chat and drawer thumbnails show the whole image (contain) in a uniform box', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  const thumbs = (sel) => page.locator(sel).evaluateAll((els) => els.map((i) => {
    const b = i.parentElement.getBoundingClientRect();
    return { fit: getComputedStyle(i).objectFit, box: `${Math.round(b.width)}×${Math.round(b.height)}`, bg: getComputedStyle(i.parentElement).backgroundColor };
  }));
  const chat = await thumbs('#messages .shot img');
  assert.equal(chat.length, 2);
  assert.deepEqual(chat.map((t) => t.fit), ['contain', 'contain']);
  assert.deepEqual(chat.map((t) => t.box), ['160×100', '160×100']);
  assert.notEqual(chat[0].bg, 'rgba(0, 0, 0, 0)', 'letterboxed on a background');
  await page.evaluate((id) => openTask(id), taskId);
  await page.locator('#drBody .shots .shot img').nth(1).waitFor();
  const drawer = await thumbs('#drBody .shots .shot img');
  assert.ok(drawer.length >= 2 && drawer.every((t) => t.fit === 'contain'), JSON.stringify(drawer));
  assert.equal(new Set(drawer.map((t) => t.box)).size, 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});
