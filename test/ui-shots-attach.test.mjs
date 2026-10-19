// Screenshots → Attach to chat (shots.js) in a real browser: boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) on a
// spare port with a project (linked to its chat by convo_id) whose task run logs hold screenshots. Attach fetches the
// image, closes the sheet and adds it to the chat composer's tray (app.js addAttachments) without sending; an image that
// fails to load toasts an error and adds nothing; a project without a chat explains inline. Skips when Chromium can't launch.
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
const PASSWORD = 'shots-attach-password';
const CID = 'chat-shots', CID2 = 'chat-nochat';
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() };
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, pid, loginId, homeId, m;

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-shotsattach-'));
  const web = path.join(dataDir, 'web'), other = path.join(dataDir, 'other');
  fs.mkdirSync(web); fs.mkdirSync(other);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const convo = (id, title, cwd) => ({ id, title, cwd, mode: 'chat', agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([convo(CID, 'Web', web), convo(CID2, 'Other', other)]));
  m = ['login-before', 'login-after', 'home-before', 'home-after', 'other-page'].map((n, i) => saveMedia(dataDir, png(640, 400, i), `${n}.png`));
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
  // "web" is linked to its chat (convo_id); "other" has screenshots but no chat.
  const project = (p, name, cid) => Number(db.prepare("INSERT INTO projects(path,name,convo_id,status,created_at) VALUES(?,?,?,'active',0)").run(p, name, cid).lastInsertRowid);
  pid = project(web, 'web', CID);
  const otherPid = project(other, 'other', null);
  const task = (p, title) => Number(db.prepare(`INSERT INTO tasks(project_id,kind,title,prompt,status,ran_agent,started_at,finished_at,created_at)
    VALUES(?,'work',?,'build','done','claude',1,100,0)`).run(p, title).lastInsertRowid);
  const runOf = (id, name, entries) => {
    const log = path.join(dataDir, `${name}.jsonl`);
    fs.writeFileSync(log, [{ k: 'start', at: 1, agent: 'claude' }, ...entries].map((e) => JSON.stringify(e)).join('\n') + '\n');
    db.prepare("INSERT INTO runs(task_id,purpose,agent,outcome,started_at,finished_at,log_path) VALUES(?,'work','claude','ok',1,100,?)").run(id, log);
  };
  loginId = task(pid, 'Restyle the login page');
  runOf(loginId, 'login', [{ k: 'image', ...m[0], at: 1000 }, { k: 'text', text: 'Restyled.' }, { k: 'image', ...m[1], at: 1100 }]);
  homeId = task(pid, 'Add a hero to the home page');
  runOf(homeId, 'home', [{ k: 'image', ...m[2], at: 2000 }, { k: 'image', ...m[3], at: 2100 }]);
  runOf(task(otherPid, 'Shoot the other page'), 'other', [{ k: 'image', ...m[4], at: 3000 }]);
  db.close();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(cid = CID, { viewport = { width: 1280, height: 800 }, mobile = false } = {}) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(mobile ? { viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${cid}`);
  await page.waitForFunction(() => typeof window.Shots === 'object');
  await page.waitForFunction(() => !document.getElementById('shotsLink').hidden);
  if (mobile) { await page.locator('#viewBtn').tap(); await page.locator('#viewMenuShots').tap(); } // phones: the pill lives in the title menu
  else await page.locator('#shotsLink').click();
  await page.locator('#shotsModal .sh-latest .shot-final img').waitFor();
  return { ctx, page, errors };
}
const tray = (page) => page.evaluate(() => ({ hidden: document.getElementById('attTray').hidden,
  items: [...document.querySelectorAll('#attTray .att-item')].map((i) => ({ title: i.title, alt: i.querySelector('img')?.alt || null })),
  list: ATT.list.map((a) => ({ name: a.name, type: a.type, status: a.status, size: a.size })) }));

test('Attach to chat on the newest screenshot closes the sheet, opens the chat and adds the image to the composer tray', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  const latest = page.locator('#shBody .sh-latest .shot-final');
  assert.equal(await latest.evaluate((f) => f.dataset.name), 'home-after.png');
  const btn = latest.locator('.sh-attach');
  assert.equal(await btn.innerText(), 'Attach to chat');
  assert.equal(await btn.getAttribute('aria-label'), 'Attach home-after.png to chat');
  await btn.click();
  await page.waitForFunction(() => document.getElementById('shotsModal').hidden && ATT.list.length === 1);
  await page.waitForFunction(() => ATT.list[0].status === 'ready'); // uploaded (POST /api/uploads), ready to send
  const t = await tray(page);
  const name = `task-${homeId}-home-after.png`;
  assert.equal(t.hidden, false);
  assert.deepEqual(t.items.map((i) => i.alt), [name]);
  assert.match(t.items[0].title, new RegExp(`^${name} · `));
  assert.deepEqual(t.list.map(({ name, type, status }) => [name, type, status]), [[name, 'image/png', 'ready']]);
  assert.ok(t.list[0].size > 0);
  const view = await page.evaluate(() => [document.getElementById('app').dataset.view, state.cid, document.querySelectorAll('#messages .msg.user').length]);
  assert.deepEqual(view, ['chat', 'chat-shots', 0], 'the chat is open and nothing was sent');
  assert.equal(await page.locator('.toast-success .toast-msg').innerText(), `${name} is in the message: add a note and send`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a screenshot that fails to load shows an error toast, keeps the sheet open and adds nothing; Compare hides the buttons', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  const tile = page.locator('#shBody .sh-group .shot[data-name="login-before.png"]');
  const btn = tile.locator('.sh-attach');
  assert.equal(await btn.getAttribute('aria-label'), 'Attach login-before.png to chat');
  await page.route(`**/api/media/${m[0].id}`, (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' }));
  await btn.click();
  await page.locator('.toast-error').waitFor();
  assert.equal(await page.locator('.toast-error .toast-msg').innerText(), "Couldn't attach that screenshot");
  assert.equal(await page.locator('#shotsModal').isVisible(), true);
  assert.equal(await btn.isDisabled(), false);
  const t = await tray(page);
  assert.deepEqual([t.hidden, t.items, t.list], [true, [], []]);
  // Compare mode: no attach buttons while comparing; Back brings them back.
  await page.locator('#shBody .shot .sh-pick input').nth(0).check();
  await page.locator('#shBody .shot .sh-pick input').nth(1).check();
  await page.locator('#shBody .sh-cmp-go').click();
  await page.locator('#shBody .shc').waitFor();
  assert.equal(await page.locator('#shBody .sh-attach').count(), 0);
  await page.locator('#shBody .shc-back').click();
  assert.equal(await page.locator('#shBody .sh-attach').count(), 4);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a project without a chat explains inline instead of attaching; phone targets are 44px', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open(CID2, { viewport: { width: 390, height: 844 }, mobile: true });
  const btn = page.locator('#shBody .sh-latest .sh-attach');
  const box = await btn.boundingBox();
  assert.ok(box.height >= 44, `attach button is ${box.height}px tall`);
  await btn.tap();
  await page.locator('#shBody .sh-note').waitFor();
  assert.match(await page.locator('#shBody .sh-note').innerText(), /no chat yet/);
  assert.equal(await page.locator('#shotsModal').isVisible(), true);
  assert.deepEqual(await page.evaluate(() => ATT.list.length), 0);
  await btn.tap(); // pressing again doesn't stack notes
  assert.equal(await page.locator('#shBody .sh-note').count(), 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});
