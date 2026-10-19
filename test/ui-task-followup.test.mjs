// The task drawer's Follow up on a done task (followUpForm in app.js) in a real browser: boots server.mjs
// (CW_NO_ORCHESTRATOR=1, temp data dir) on a spare port with two projects and their chats, plus a project whose chat is
// gone. Follow up… opens 'What should change?'; Add to chat appends 'Follow-up on task #N (title):' and the note to
// the task's project chat draft (after any text already there) and opens that chat without sending; a blank note is
// refused and keeps focus; notes survive drawer re-renders; with no chat to add to the note stays and the form says
// why; only done tasks get the button. TF_SHOTS=<dir> saves screenshots there. Skips when Chromium can't launch.
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
const PASSWORD = 'task-followup-password';
const WEB = 'chat-web', API = 'chat-api';
const SHOTS = process.env.TF_SHOTS || null;
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() };
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, doneTask, doneTask2, reviewTask, failedTask, orphanTask;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-taskfu-'));
  const dirs = ['web', 'api', 'gone'].map((n) => { const d = path.join(dataDir, n); fs.mkdirSync(d); return d; });
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const chat = (id, title, cwd) => ({ id, title, cwd, mode: 'orchestrator', agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true, fallbacks: [] });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([chat(WEB, 'Web', dirs[0]), chat(API, 'Api', dirs[1])]));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 90000);
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
  const project = (dir, name, cid) => Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,created_at) VALUES(?,?,'active',?,0)").run(dir, name, cid).lastInsertRowid);
  const task = (pid, title, status = 'done') => Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,created_at) VALUES(?,'work',?,'build',?,0)").run(pid, title, status).lastInsertRowid);
  const web = project(dirs[0], 'Web', WEB);
  project(dirs[1], 'Api', API);
  doneTask = task(web, 'Build the app');
  doneTask2 = task(web, 'Polish the readme');
  reviewTask = task(web, 'Wire the login', 'awaiting_review');
  failedTask = task(web, 'Broken build', 'failed');
  orphanTask = task(project(dirs[2], 'Gone', 'chat-deleted'), 'Lost work');
  db.close();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// Opens chat `cid`, then task `id`'s drawer (its action row rendered from the loaded detail).
async function open(cid, id, { phone = false, drafts = {} } = {}) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [], sent = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('websocket', (ws) => ws.on('framesent', (f) => { try { sent.push(JSON.parse(f.payload)); } catch {} }));
  await page.goto(`${base}/#${cid}`);
  await page.waitForFunction(() => typeof openTask === 'function' && state.convos.length > 0);
  await page.evaluate((d) => { for (const [k, v] of Object.entries(d)) localStorage.setItem('cw.draft.' + k, v); }, drafts);
  await page.evaluate((tid) => openTask(tid), id);
  await page.waitForFunction((tid) => O.detail?.task.id === tid && document.querySelector('#drBody .dr-summary'), id);
  return { ctx, page, errors, sent };
}
const button = (page) => page.locator('#drBody .dr-actions .dr-fu-open');
const form = (page) => page.locator('#drBody .dr-fu');
async function openForm(page) {
  await button(page).click();
  await form(page).locator('.dr-fu-note').waitFor();
}
const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `task-followup-${name}.png`) });
const sends = (sent) => sent.filter((m) => m.t === 'send');

test('Follow up adds the note with the task number to the project chat\'s box, after what was there, without sending', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, sent } = await open(API, doneTask, { drafts: { [WEB]: 'Earlier thoughts', [API]: 'Api draft' } });
  assert.equal(await form(page).count(), 0, 'the form starts closed');
  await openForm(page);
  assert.equal(await button(page).getAttribute('aria-expanded'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('dr-fu-note')), true, 'the field takes focus');
  assert.equal(await form(page).locator('.dr-fu-note').getAttribute('placeholder'), 'What should change?');
  await form(page).locator('.dr-fu-note').fill('Use the real logo on the home page');
  await shot(page, 'form');
  await form(page).locator('.dr-fu-add').click();
  await page.waitForFunction((cid) => state.cid === cid, WEB);
  const want = `Earlier thoughts\n\nFollow-up on task #${doneTask} (Build the app):\nUse the real logo on the home page`;
  assert.equal(await page.inputValue('#input'), want);
  assert.equal(await page.locator('#taskDrawer').isHidden(), true, 'the drawer closes onto the chat');
  // The chat's history frame arrives and keeps the box as it is; nothing is sent.
  await page.waitForFunction(() => state.mark != null);
  await page.waitForTimeout(400);
  assert.equal(await page.inputValue('#input'), want);
  await shot(page, 'added');
  assert.equal(await page.evaluate((cid) => localStorage.getItem('cw.draft.' + cid), WEB), want);
  assert.equal(await page.evaluate((cid) => localStorage.getItem('cw.draft.' + cid), API), 'Api draft', 'the other project\'s draft is untouched');
  assert.deepEqual(sends(sent), [], 'nothing was sent');
  // The note is used up: the form is closed and empty when the drawer opens again.
  await page.evaluate((tid) => openTask(tid), doneTask);
  await page.waitForFunction((tid) => O.detail?.task.id === tid && document.querySelector('#drBody .dr-fu-open'), doneTask);
  assert.equal(await form(page).count(), 0);
  await openForm(page);
  assert.equal(await form(page).locator('.dr-fu-note').inputValue(), '');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('from the open chat, Ctrl+Enter adds to the box already being typed in', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, sent } = await open(WEB, doneTask2);
  await page.evaluate(() => { input.value = 'Typed so far  '; input.dispatchEvent(new Event('input')); });
  await openForm(page);
  await page.keyboard.type('Mention npm start in the intro');
  await page.keyboard.press('Control+Enter');
  await page.locator('#taskDrawer').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => state.cid), WEB);
  assert.equal(await page.inputValue('#input'), `Typed so far\n\nFollow-up on task #${doneTask2} (Polish the readme):\nMention npm start in the intro`);
  assert.deepEqual(sends(sent), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('an empty note says Write a note first and keeps focus; notes survive re-renders; phones get 44px buttons', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, sent } = await open(API, doneTask, { phone: true, drafts: { [WEB]: 'Keep me' } });
  await openForm(page);
  const fb = form(page);
  await fb.locator('.dr-fu-note').fill('   \n ');
  await fb.locator('.dr-fu-add').click();
  assert.equal(await fb.locator('.dr-fu-msg').innerText(), 'Write a note first');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('dr-fu-note')), true, 'focus stays in the field');
  assert.equal(await page.evaluate(() => state.cid), API, 'the chat did not change');
  assert.equal(await page.locator('#taskDrawer').isVisible(), true);
  assert.equal(await page.evaluate((cid) => localStorage.getItem('cw.draft.' + cid), WEB), 'Keep me');
  const box = await fb.locator('.dr-fu-add').boundingBox();
  assert.ok(box.height >= 44, `phone button is 44px: ${box.height}`);
  assert.equal(await fb.locator('.dr-fu-note').evaluate((n) => getComputedStyle(n).fontSize), '16px');
  await shot(page, 'phone-empty');

  await fb.locator('.dr-fu-note').fill('Note on the app');
  assert.equal(await fb.locator('.dr-fu-msg').innerText(), '', 'typing clears the complaint');
  await page.evaluate(() => renderDrawer(true));
  assert.equal(await form(page).locator('.dr-fu-note').inputValue(), 'Note on the app');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('dr-fu-note')), true, 'the field keeps focus');
  // Another task starts with its form closed and empty; going back finds the note again.
  await page.evaluate((tid) => openTask(tid), doneTask2);
  await page.waitForFunction((tid) => O.detail?.task.id === tid && document.querySelector('#drBody .dr-fu-open'), doneTask2);
  assert.equal(await form(page).count(), 0);
  await openForm(page);
  assert.equal(await form(page).locator('.dr-fu-note').inputValue(), '');
  await page.evaluate((tid) => openTask(tid), doneTask);
  await page.waitForFunction((tid) => O.detail?.task.id === tid && document.querySelector('#drBody .dr-fu-open'), doneTask);
  await openForm(page);
  assert.equal(await form(page).locator('.dr-fu-note').inputValue(), 'Note on the app');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(sends(sent), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('with no project chat to add to, the note stays and the form says why', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, sent } = await open(API, orphanTask, { drafts: { [WEB]: 'Untouched' } });
  await openForm(page);
  const fb = form(page);
  await fb.locator('.dr-fu-note').fill('Check this again');
  await fb.locator('.dr-fu-add').click();
  assert.match(await fb.locator('.dr-fu-msg').innerText(), /chat isn't available, so the note stays here/);
  await shot(page, 'unavailable');
  assert.equal(await fb.locator('.dr-fu-note').inputValue(), 'Check this again');
  assert.equal(await page.locator('#taskDrawer').isVisible(), true);
  assert.equal(await page.evaluate(() => state.cid), API, 'the chat did not change');
  assert.equal(await page.evaluate((cid) => localStorage.getItem('cw.draft.' + cid), WEB), 'Untouched');
  await page.evaluate(() => renderDrawer(true));
  assert.equal(await form(page).locator('.dr-fu-note').inputValue(), 'Check this again', 'kept across a re-render');
  assert.deepEqual(sends(sent), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('only done tasks get Follow up: a task awaiting review keeps its review panel, a failed one its Retry', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open(WEB, reviewTask);
  assert.equal(await button(page).count(), 0);
  assert.equal(await page.locator('#drBody .rv-panel').count(), 1, 'the review panel is there');
  await page.evaluate((tid) => openTask(tid), failedTask);
  await page.waitForFunction((tid) => O.detail?.task.id === tid && document.querySelector('#drBody .dr-summary'), failedTask);
  assert.equal(await button(page).count(), 0);
  assert.equal(await page.locator('#drBody .dr-actions .btn', { hasText: 'Retry' }).count(), 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});
