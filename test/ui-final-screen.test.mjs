// A browser task's screens in a real browser (#513): boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) on a spare
// port with browser tasks whose run logs hold screenshots written out of time order. A finished one shows its LAST
// screenshot as a large 'Final screen', then the earlier ones newest first; a running one shows its latest as the
// 'Current screen' and swaps it when a new screenshot arrives (an orun event); order comes from event time, never
// media id or log order. Skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'final-screen-password';
const CID = 'chat-final';
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() };
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, doneId, runningId, runningRun, m;

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-finalscreen-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Final screen', cwd: dataDir, mode: 'chat',
    agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true }]));
  // Five distinct screens; names say when each was taken.
  m = ['first', 'second', 'third', 'live-a', 'live-b'].map((n, i) => saveMedia(dataDir, png(640, 400, i), `${n}.png`));
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
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,created_at) VALUES(?,?,'active',0)").run(path.join(dataDir, 'web'), 'web').lastInsertRowid);
  const task = (title, status) => Number(db.prepare(`INSERT INTO tasks(project_id,kind,title,prompt,status,ran_agent,capabilities,started_at,finished_at,created_at)
    VALUES(?,'work',?,'browse',?,'claude','["browser"]',1,?,0)`).run(pid, title, status, status === 'done' ? 100 : null).lastInsertRowid);
  const runOf = (id, name, entries, outcome) => {
    const log = path.join(dataDir, `${name}.jsonl`);
    fs.writeFileSync(log, [{ k: 'start', at: 1, agent: 'claude' }, ...entries].map((e) => JSON.stringify(e)).join('\n') + '\n');
    return Number(db.prepare('INSERT INTO runs(task_id,purpose,agent,outcome,started_at,finished_at,log_path) VALUES(?,\'work\',\'claude\',?,1,?,?)')
      .run(id, outcome, outcome ? 100 : null, log).lastInsertRowid);
  };
  // Finished: the log holds them out of time order (second, first, third); time says first < second < third.
  doneId = task('Check the checkout page', 'done');
  runOf(doneId, 'done-run', [{ k: 'text', text: 'Opened the checkout.' }, { k: 'image', ...m[1], at: 20 }, { k: 'image', ...m[0], at: 10 },
    { k: 'image', ...m[2], at: 30 }, { k: 'end', at: 40, outcome: 'ok' }], 'ok');
  runningId = task('Watch the dashboard', 'running');
  runningRun = runOf(runningId, 'live-run', [{ k: 'text', text: 'Watching.' }, { k: 'image', ...m[3], at: 50 }], null);
  db.close();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(viewport = { width: 1280, height: 800 }) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${CID}`);
  await page.waitForFunction(() => typeof openTask === 'function');
  return { ctx, page, errors };
}
const screens = (page) => page.locator('#drBody .screens').evaluate((s) => ({
  head: s.querySelector('.screen-head')?.textContent,
  final: s.querySelector('.shot-final')?.dataset.name,
  earlier: [...s.querySelectorAll('.shots .shot')].map((f) => f.dataset.name),
}));

test('a finished browser task: the last screenshot is the Final screen, fit to the width; the others follow newest first', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  await page.evaluate((id) => openTask(id), doneId);
  await page.locator('#drBody .screens .shot-final img').waitFor();
  assert.deepEqual(await screens(page), { head: 'Final screen', final: 'third.png', earlier: ['second.png', 'first.png'] });
  // Fit to width: the image spans the section (not a 76px tile) and keeps its 16:10 aspect.
  const [fw, sw, ih, iw] = await page.locator('#drBody .screens').evaluate((s) => {
    const img = s.querySelector('.shot-final img');
    return [s.querySelector('.shot-final').getBoundingClientRect().width, s.getBoundingClientRect().width, img.getBoundingClientRect().height, img.getBoundingClientRect().width];
  });
  assert.ok(fw > 200 && Math.abs(fw - Math.min(sw, 720)) <= 2, `${fw} vs ${sw}`);
  assert.ok(Math.abs(iw / ih - 1.6) < 0.05, `${iw}×${ih}`);
  // Click: the lightbox opens fitted on that screen.
  await page.locator('#drBody .screens .shot-final button').click();
  await page.locator('#lightbox').waitFor();
  assert.equal(await page.locator('#lbTitle').innerText(), 'third.png');
  assert.equal(await page.locator('#lbView').evaluate((v) => v.classList.contains('fit') || !!v.closest('.fit')), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a running browser task: the latest screenshot is the Current screen and a new one replaces it live', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  await page.evaluate((id) => openTask(id), runningId);
  await page.locator('#drBody .screens .shot-final').waitFor();
  assert.deepEqual(await screens(page), { head: 'Current screen', final: 'live-a.png', earlier: [] });
  // A new screenshot event for the open drawer (what the server's runLog sends as orun).
  await page.evaluate(([taskId, runId, e]) => onOrch({ t: 'orun', taskId, runId, e }), [runningId, runningRun, { k: 'image', ...m[4], at: 60 }]);
  await page.waitForFunction(() => document.querySelector('#drBody .screens .shot-final')?.dataset.name === 'live-b.png');
  assert.deepEqual(await screens(page), { head: 'Current screen', final: 'live-b.png', earlier: ['live-a.png'] });
  // An older screenshot arriving late (a remote batch re-sent) never takes over the Current screen.
  await page.evaluate(([taskId, runId, e]) => onOrch({ t: 'orun', taskId, runId, e }), [runningId, runningRun, { k: 'image', ...m[0], at: 55 }]);
  await page.waitForFunction(() => document.querySelectorAll('#drBody .screens .shots .shot').length === 2);
  assert.deepEqual(await screens(page), { head: 'Current screen', final: 'live-b.png', earlier: ['first.png', 'live-a.png'] });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('ordering uses event time (then seq), not media id or log order; a repeated screen counts at its latest time', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  const order = await page.evaluate(() => [
    shotsByTime([{ id: 'a', at: 30 }, { id: 'z', at: 10 }, { id: 'm', at: 20 }]).map((s) => s.id),
    shotsByTime([{ id: 'b', at: 5, i: 9 }, { id: 'c', at: 5, i: 2 }, { id: 'a', ts: 1 }]).map((s) => s.id),
    shotsByTime([{ id: 'x', at: 1 }, { id: 'y', at: 2 }, { id: 'x', at: 3 }]).map((s) => s.id),
  ]);
  assert.deepEqual(order, [['z', 'm', 'a'], ['a', 'c', 'b'], ['y', 'x']]);
  // The Browser tab and the review receipt use the same strip: last first, then newest first.
  const strip = await page.evaluate(() => {
    const s = screenStrip([{ id: 'q', name: 'q', ts: 3 }, { id: 'p', name: 'p', ts: 1 }, { id: 'r', name: 'r', ts: 2 }], screenLabel('done'));
    return [s.querySelector('.screen-head').textContent, s.querySelector('.shot-final').dataset.name, [...s.querySelectorAll('.shots .shot')].map((f) => f.dataset.name)];
  });
  assert.deepEqual(strip, ['Final screen', 'q', ['r', 'p']]);
  assert.equal(await page.evaluate(() => screenLabel('running')), 'Current screen');
  assert.deepEqual(errors, []);
  await ctx.close();
});
