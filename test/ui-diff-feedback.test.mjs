// The task drawer's per-file follow-up note (fileFeedback in app.js) in a real browser: boots server.mjs
// (CW_NO_ORCHESTRATOR=1, temp data dir) on a spare port with two projects and their chats, plus a project whose chat is
// gone, and stubs GET /api/orch/tasks/:id/changes in the page. Add to chat appends the task, file and note to the task's
// project chat draft (after any text already there) and opens that chat without sending; a blank note is refused; notes
// survive drawer re-renders, kept apart by task and file; with no chat to add to the note stays and the form says why.
// DF_SHOTS=<dir> saves screenshots there. Skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'diff-feedback-password';
const WEB = 'chat-web', API = 'chat-api';
const SHOTS = process.env.DF_SHOTS || null;
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() };
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, webTask, webTask2, orphanTask;

const PATCH = [
  'diff --git a/src/app.js b/src/app.js',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,2 +1,2 @@',
  '-const old = 1;',
  '+const fresh = 2;',
  ' export default x;',
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1 @@',
  '-Run it.',
  '+Run it with npm start.',
  '',
].join('\n');
const CHANGES = { source: 'commit', commits: ['abc1234'], truncated: false, patch: PATCH, files: [
  { path: 'src/app.js', add: 1, del: 1, binary: false },
  { path: 'README.md', add: 1, del: 1, binary: false },
] };

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-difffb-'));
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
  const project = (dir, name, cid) => Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,created_at) VALUES(?,?,'active',?,0)").run(dir, name, cid).lastInsertRowid);
  const task = (pid, title) => Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,created_at) VALUES(?,'work',?,'build','done',0)").run(pid, title).lastInsertRowid);
  const web = project(dirs[0], 'Web', WEB);
  project(dirs[1], 'Api', API);
  webTask = task(web, 'Build the app');
  webTask2 = task(web, 'Polish the readme');
  orphanTask = task(project(dirs[2], 'Gone', 'chat-deleted'), 'Lost work');
  db.close();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// Opens chat `cid`, then task `id`'s drawer with its Changes open and `file`'s row expanded.
async function open(cid, id, file, { phone = false, drafts = {} } = {}) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [], sent = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('websocket', (ws) => ws.on('framesent', (f) => { try { sent.push(JSON.parse(f.payload)); } catch {} }));
  await page.route('**/api/orch/tasks/*/changes', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(CHANGES) }));
  await page.goto(`${base}/#${cid}`);
  await page.waitForFunction(() => typeof openTask === 'function' && state.convos.length > 0);
  await page.evaluate((d) => { for (const [k, v] of Object.entries(d)) localStorage.setItem('cw.draft.' + k, v); }, drafts);
  await page.evaluate((tid) => openTask(tid), id);
  await expand(page, file);
  return { ctx, page, errors, sent };
}
async function expand(page, file) {
  const sec = page.locator('#drBody .dr-changes');
  await sec.waitFor();
  if (!(await sec.evaluate((d) => d.open))) await sec.locator('summary').click();
  const row = sec.locator('.chg-row', { hasText: file });
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  await sec.locator('.chg-file', { hasText: file }).locator('.chg-fb-note').waitFor();
}
const form = (page, file) => page.locator('#drBody .chg-file', { hasText: file }).locator('.chg-fb');
const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `diff-feedback-${name}.png`) });
const sends = (sent) => sent.filter((m) => m.t === 'send');

test('Add to chat appends the task, file and note to the project chat\'s draft and opens it without sending', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, sent } = await open(API, webTask, 'src/app.js', { drafts: { [WEB]: 'Earlier thoughts', [API]: 'Api draft' } });
  const fb = form(page, 'src/app.js');
  await fb.locator('.chg-fb-note').fill('Rename fresh to something clearer');
  await fb.locator('.chg-fb-add').click();
  await page.waitForFunction((cid) => state.cid === cid, WEB);
  const want = `Earlier thoughts\n\nFollow-up on task #${webTask} (Build the app), file \`src/app.js\`:\nRename fresh to something clearer`;
  assert.equal(await page.inputValue('#input'), want);
  assert.equal(await page.locator('#taskDrawer').isHidden(), true, 'the drawer closes onto the chat');
  // The chat's history frame arrives and keeps the box as it is; nothing is sent.
  await shot(page, 'added');
  await page.waitForFunction(() => state.mark != null);
  await page.waitForTimeout(400);
  assert.equal(await page.inputValue('#input'), want);
  assert.equal(await page.evaluate((cid) => localStorage.getItem('cw.draft.' + cid), WEB), want);
  assert.equal(await page.evaluate((cid) => localStorage.getItem('cw.draft.' + cid), API), 'Api draft', 'the other project\'s draft is untouched');
  assert.deepEqual(sends(sent), [], 'nothing was sent');
  // The note is used up: the file's form is empty when the drawer opens again.
  await page.evaluate((tid) => openTask(tid), webTask);
  await expand(page, 'src/app.js');
  assert.equal(await form(page, 'src/app.js').locator('.chg-fb-note').inputValue(), '');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('from the open chat, keyboard: Ctrl+Enter adds to the box already being typed in', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, sent } = await open(WEB, webTask2, 'README.md');
  await page.evaluate(() => { input.value = 'Typed so far  '; input.dispatchEvent(new Event('input')); });
  const note = form(page, 'README.md').locator('.chg-fb-note');
  await note.focus();
  await page.keyboard.type('Mention npm start in the intro');
  await page.keyboard.press('Control+Enter');
  await page.locator('#taskDrawer').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => state.cid), WEB);
  assert.equal(await page.inputValue('#input'), `Typed so far\n\nFollow-up on task #${webTask2} (Polish the readme), file \`README.md\`:\nMention npm start in the intro`);
  assert.deepEqual(sends(sent), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a blank note is refused; notes survive re-renders, kept apart by task and file; phones get 44px buttons', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, sent } = await open(API, webTask, 'src/app.js', { phone: true, drafts: { [WEB]: 'Keep me' } });
  const fb = form(page, 'src/app.js');
  await fb.locator('.chg-fb-note').fill('   \n ');
  await fb.locator('.chg-fb-add').click();
  assert.equal(await fb.locator('.chg-fb-msg').innerText(), 'Write a note first');
  assert.equal(await page.evaluate(() => state.cid), API, 'the chat did not change');
  assert.equal(await page.locator('#taskDrawer').isVisible(), true);
  assert.equal(await page.evaluate((cid) => localStorage.getItem('cw.draft.' + cid), WEB), 'Keep me');
  const box = await fb.locator('.chg-fb-add').boundingBox();
  assert.ok(box.height >= 44, `phone button is 44px: ${box.height}`);
  assert.equal(await fb.locator('.chg-fb-note').evaluate((n) => getComputedStyle(n).fontSize), '16px');

  await fb.locator('.chg-fb-note').fill('Note on app.js');
  await expand(page, 'README.md');
  await form(page, 'README.md').locator('.chg-fb-note').fill('Note on the readme');
  await page.evaluate(() => renderDrawer(true));
  assert.equal(await form(page, 'src/app.js').locator('.chg-fb-note').inputValue(), 'Note on app.js');
  assert.equal(await form(page, 'README.md').locator('.chg-fb-note').inputValue(), 'Note on the readme');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('chg-fb-note')), true, 'the field keeps focus');
  await shot(page, 'phone');
  // Another task's same file starts empty; going back finds the note again.
  await page.evaluate((tid) => openTask(tid), webTask2);
  await expand(page, 'src/app.js');
  assert.equal(await form(page, 'src/app.js').locator('.chg-fb-note').inputValue(), '');
  await page.evaluate((tid) => openTask(tid), webTask);
  await expand(page, 'src/app.js');
  assert.equal(await form(page, 'src/app.js').locator('.chg-fb-note').inputValue(), 'Note on app.js');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(sends(sent), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('with no project chat to add to, the note stays and the form says why', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, sent } = await open(API, orphanTask, 'src/app.js', { drafts: { [WEB]: 'Untouched' } });
  const fb = form(page, 'src/app.js');
  await fb.locator('.chg-fb-note').fill('Check this again');
  await fb.locator('.chg-fb-add').click();
  assert.match(await fb.locator('.chg-fb-msg').innerText(), /chat isn't available, so the note stays here/);
  await shot(page, 'unavailable');
  assert.equal(await fb.locator('.chg-fb-note').inputValue(), 'Check this again');
  assert.equal(await page.locator('#taskDrawer').isVisible(), true);
  assert.equal(await page.evaluate(() => state.cid), API, 'the chat did not change');
  assert.equal(await page.evaluate((cid) => localStorage.getItem('cw.draft.' + cid), WEB), 'Untouched');
  await page.evaluate(() => renderDrawer(true));
  assert.equal(await form(page, 'src/app.js').locator('.chg-fb-note').inputValue(), 'Check this again', 'kept across a re-render');
  assert.deepEqual(sends(sent), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});
