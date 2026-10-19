// 'Since you were away' at the top of the Queue (app.js digestCard): boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data
// dir) with one orchestrator chat and its project, stubs GET /api/orch/digest in the page, and checks the card's counts,
// its 5-row cap per kind, that a row opens the task drawer, that Dismiss hides it and records cw.digestSeen, that all-zero
// counts show nothing, and that being away under 30 minutes doesn't ask at all. Skips when Chromium can't launch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrowser } from '../browser.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'digest-ui-password';
const CID = 'chat-digest';
const SHOTS = process.env.CW_DIGEST_SHOTS; // optional dir: save screenshots of the card
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-digest-ui-'));
  const project = path.join(dataDir, 'no-such-project');
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Invoices', cwd: project, mode: 'orchestrator', createdAt: 1, updatedAt: 1, fullAccess: true, fallbacks: [] }]));
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
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare("INSERT INTO projects(path,name,status,convo_id,created_at) VALUES(?,?,'active',?,0)").run(project, 'Invoices', CID);
  db.close();
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const NOW = Date.now();
const done = Array.from({ length: 7 }, (_, i) => ({ id: 100 + i, title: `Done task ${i}`, kind: 'work', finished_at: NOW - (i + 1) * 60e3,
  commit_sha: null, result: `Result line ${i}`, agent: 'claude', model: 'opus' }));
const DIGEST = {
  since: NOW - 3 * 3600e3, at: NOW, counts: { done: 7, failed: 1, needsYou: 1 },
  projects: [
    { id: 1, name: 'Invoices', done: done.slice(0, 4), failed: [{ ...done[0], id: 200, title: 'Broke the build', result: 'boom', status: 'failed' }], needsYou: [] },
    { id: 2, name: 'Website', done: done.slice(4), failed: [], needsYou: [{ id: 300, title: 'Checkpoint', why: 'review' }] },
  ],
};
const EMPTY = { since: NOW - 3 * 3600e3, at: NOW, counts: { done: 0, failed: 0, needsYou: 0 }, projects: [] };

// A phone-sized page signed in, with cw.digestSeen `away` ms ago and the digest stubbed; counts the digest requests.
async function open(away, body) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript((t) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('cw.digestSeen', String(t)); } }, Date.now() - away);
  const page = await ctx.newPage();
  const asked = [];
  await page.route('**/api/orch/digest*', (r) => { asked.push(r.request().url()); r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) }); });
  await page.goto(`${base}/#${CID}`);
  await page.locator('#obQueue').click();
  return { ctx, page, asked };
}

test('away for hours: the card shows counts and up to 5 rows per kind; a row opens its task; Dismiss hides it', { skip, timeout: 60000 }, async () => {
  const { ctx, page, asked } = await open(3 * 3600e3, DIGEST);
  const card = page.locator('#qBody > .sy');
  await card.waitFor();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /[?&]since=\d+/, 'asks since the last time the owner looked');
  assert.match(await card.locator('.sy-h').innerText(), /Since you were away/);
  assert.deepEqual(await card.locator('.sy-n').allInnerTexts(), ['7 done', '1 failed', '1 need you']);
  assert.deepEqual(await card.locator('.sy-n b').allInnerTexts(), ['7', '1', '1']);
  assert.equal(await card.locator('.sy-done .sy-row').count(), 5, 'at most 5 rows a kind');
  assert.deepEqual(await card.locator('.sy-done .sy-task').allInnerTexts(), ['Done task 0', 'Done task 1', 'Done task 2', 'Done task 3', 'Done task 4'], 'newest first across projects');
  assert.deepEqual(await card.locator('.sy-done .sy-proj').allInnerTexts(), ['Invoices', 'Invoices', 'Invoices', 'Invoices', 'Website']);
  assert.equal(await card.locator('.sy-done .sy-note').first().innerText(), 'Result line 0');
  assert.equal(await card.locator('.sy-failed .sy-row').count(), 1);
  assert.equal(await card.locator('.sy-failed .sy-note').innerText(), 'boom');
  assert.equal(await card.locator('.sy-needsYou .sy-note').innerText(), 'Waiting for your review');
  assert.equal(await page.locator('#qBody').evaluate((b) => b.firstElementChild.classList.contains('sy')), true, 'at the top of the Queue');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll at 390px');
  if (SHOTS) {
    await page.screenshot({ path: path.join(SHOTS, 'digest-queue-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(SHOTS, 'digest-queue-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
  }
  const dismiss = card.getByRole('button', { name: 'Dismiss' });
  assert.ok((await dismiss.boundingBox()).height >= 44, '44pt target on a phone');

  await card.locator('.sy-failed .sy-row').click();
  await page.waitForFunction(() => !document.getElementById('taskDrawer').hidden);
  await page.evaluate(() => closeTask());

  const t0 = Date.now();
  await dismiss.click();
  assert.equal(await page.locator('#qBody .sy').count(), 0);
  assert.ok(Number(await page.evaluate(() => localStorage.getItem('cw.digestSeen'))) >= t0, 'Dismiss records when the owner looked');
  await page.evaluate(() => renderQueue());
  assert.equal(await page.locator('#qBody .sy').count(), 0, 'stays gone across re-renders');
  await ctx.close();
});

test('closing the Queue counts as seen: reopening it shows nothing new', { skip, timeout: 60000 }, async () => {
  const { ctx, page, asked } = await open(3 * 3600e3, DIGEST);
  await page.locator('#qBody > .sy').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('queueModal').hidden);
  await page.locator('#obQueue').click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#qBody .sy').count(), 0);
  assert.equal(asked.length, 1, 'no second request within 30 minutes');
  await ctx.close();
});

test('all counts 0: no card', { skip, timeout: 60000 }, async () => {
  const { ctx, page, asked } = await open(3 * 3600e3, EMPTY);
  await page.waitForFunction(() => document.querySelector('#qBody h3'));
  for (let i = 0; i < 50 && !asked.length; i++) await page.waitForTimeout(50);
  assert.equal(asked.length, 1);
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#qBody .sy').count(), 0);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'digest-queue-none-mobile.png') });
  await ctx.close();
});

test('away under 30 minutes: no request, no card', { skip, timeout: 60000 }, async () => {
  const { ctx, page, asked } = await open(10 * 60e3, DIGEST);
  await page.waitForFunction(() => document.querySelector('#qBody h3'));
  await page.waitForTimeout(300);
  assert.equal(asked.length, 0);
  assert.equal(await page.locator('#qBody .sy').count(), 0);
  await ctx.close();
});
