// The top bar's Screenshots gallery (shots.js) in a real browser: boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir)
// on a spare port with a project whose tasks' run logs hold screenshots. GET /api/orch/projects/:id/shots lists them
// newest first, each media id once, with its task; the pill shows only for a project with screenshots and counts ones
// taken since the gallery was last opened; the sheet shows the newest large, the rest grouped by task, opens the
// lightbox and the task. Skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'project-shots-password';
const CID = 'chat-shots', CID2 = 'chat-noshots';
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-projshots-'));
  const web = path.join(dataDir, 'web'), other = path.join(dataDir, 'other');
  fs.mkdirSync(web); fs.mkdirSync(other);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const convo = (id, title, cwd) => ({ id, title, cwd, mode: 'chat', agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([convo(CID, 'Web', web), convo(CID2, 'Other', other)]));
  m = ['login-before', 'login-after', 'home-before', 'home-after'].map((n, i) => saveMedia(dataDir, png(640, 400, i), `${n}.png`));
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
  pid = project(web, 'web');
  project(other, 'other');
  const task = (title) => Number(db.prepare(`INSERT INTO tasks(project_id,kind,title,prompt,status,ran_agent,started_at,finished_at,created_at)
    VALUES(?,'work',?,'build','done','claude',1,100,0)`).run(pid, title).lastInsertRowid);
  const runOf = (id, name, entries) => {
    const log = path.join(dataDir, `${name}.jsonl`);
    fs.writeFileSync(log, [{ k: 'start', at: 1, agent: 'claude' }, ...entries].map((e) => JSON.stringify(e)).join('\n') + '\n');
    db.prepare("INSERT INTO runs(task_id,purpose,agent,outcome,started_at,finished_at,log_path) VALUES(?,'work','claude','ok',1,100,?)").run(id, log);
  };
  loginId = task('Restyle the login page');
  runOf(loginId, 'login', [{ k: 'image', ...m[0], at: 1000 }, { k: 'text', text: 'Restyled.' }, { k: 'image', ...m[1], at: 1100 }]);
  homeId = task('Add a hero to the home page');
  // A second run re-shows login-after (same media id) later: it counts once, at its latest time, under this task.
  runOf(homeId, 'home', [{ k: 'image', ...m[2], at: 2000 }, { k: 'image', ...m[3], at: 2100 }]);
  db.close();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(cid = CID, { viewport = { width: 1280, height: 800 }, seen } = {}) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport });
  await ctx.addCookies([{ name, value, url: base }]);
  if (seen != null) await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), [`cw.shots.seen.${pid}`, String(seen)]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${cid}`);
  await page.waitForFunction(() => typeof window.Shots === 'object');
  return { ctx, page, errors };
}

test('the API lists a project\'s screenshots newest first, once each, with the task they came from', { skip, timeout: 30000 }, async () => {
  const r = await fetch(`${base}/api/orch/projects/${pid}/shots`, { headers: { cookie } });
  const { shots } = await r.json();
  assert.deepEqual(shots.map((s) => [s.name, s.task.id, s.at]),
    [['home-after.png', homeId, 2100], ['home-before.png', homeId, 2000], ['login-after.png', loginId, 1100], ['login-before.png', loginId, 1000]]);
  assert.equal(shots[0].task.title, 'Add a hero to the home page');
  assert.equal(shots[0].w, 640);
});

test('the pill opens a gallery: newest large, the rest grouped by task; thumbnails open the lightbox, headings the task', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  await page.locator('#shotsLink').waitFor();
  // First visit: what's already there isn't new.
  assert.equal(await page.locator('#shotsNew').isHidden(), true);
  await page.locator('#shotsLink').click();
  await page.locator('#shotsModal .sh-latest .shot-final img').waitFor();
  const view = await page.locator('#shBody').evaluate((b) => ({
    latest: b.querySelector('.sh-latest .shot-final').dataset.name,
    latestTask: b.querySelector('.sh-latest .sh-task .sh-ttl').textContent,
    groups: [...b.querySelectorAll('.sh-group')].map((g) => [g.querySelector('.sh-ttl').textContent, [...g.querySelectorAll('.shot')].map((f) => f.dataset.name)]),
  }));
  assert.deepEqual(view, { latest: 'home-after.png', latestTask: 'Add a hero to the home page',
    groups: [['Add a hero to the home page', ['home-before.png']], ['Restyle the login page', ['login-before.png', 'login-after.png']]] });
  assert.match(await page.locator('#shSub').innerText(), /^4 from 2 tasks/);
  // A thumbnail opens the lightbox, paging through the whole gallery; Escape closes only the lightbox first.
  await page.locator('.sh-group .shot button').first().click();
  await page.locator('#lightbox').waitFor();
  assert.equal(await page.locator('#lbTitle').innerText(), 'home-before.png');
  assert.match(await page.locator('#lbSub').innerText(), /2 of 4/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#lightbox').isHidden(), true);
  assert.equal(await page.locator('#shotsModal').isVisible(), true);
  // A task heading closes the sheet and opens that task.
  await page.locator('.sh-group .sh-task', { hasText: 'Restyle the login page' }).click();
  assert.equal(await page.locator('#shotsModal').isHidden(), true);
  await page.waitForFunction((id) => O.drawer === id, loginId);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('screenshots taken since the gallery was last opened show as "N new" until it is opened', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open(CID, { seen: 1500 });
  await page.locator('#shotsNew').waitFor();
  assert.equal(await page.locator('#shotsNew').innerText(), '2 new');
  await page.locator('#shotsLink').click();
  await page.locator('#shotsModal .sh-latest').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#shotsNew').isHidden(), true);
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), `cw.shots.seen.${pid}`), '2100');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a project without screenshots shows no pill; on a phone the pill lives in the title menu', { skip, timeout: 60000 }, async () => {
  let { ctx, page, errors } = await open(CID2);
  await page.waitForFunction(() => O.project?.name === 'other');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#shotsLink').isHidden(), true);
  assert.deepEqual(errors, []);
  await ctx.close();
  ({ ctx, page, errors } = await open(CID, { viewport: { width: 390, height: 844 } }));
  await page.waitForFunction(() => !document.getElementById('shotsLink').hidden);
  await page.locator('#viewBtn').click();
  await page.locator('#viewMenuShots').click();
  await page.locator('#shotsModal .sh-latest .shot-final img').waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});
