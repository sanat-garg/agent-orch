// The top bar's History sheet (commits.js) in a real browser: boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) on
// a spare port with a chat on a project, and stubs GET /api/orch/projects/:id/commits and /commit?sha= with page.route
// (the backend lands separately). The list shows each commit's subject, counts and task chip, 'Load older' passes the
// last sha, a commit opens its files and coloured patch, a failed detail shows the server's error with Retry, and
// Escape closes the sheet back to the pill. Skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'commits-ui-password';
const CID = 'chat-commits';
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() };
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, pid, taskId;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-commitsui-'));
  const web = path.join(dataDir, 'web');
  fs.mkdirSync(web);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Web', cwd: web, mode: 'chat',
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
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  pid = Number(db.prepare("INSERT INTO projects(path,name,status,created_at) VALUES(?,?,'active',0)").run(web, 'web').lastInsertRowid);
  taskId = Number(db.prepare(`INSERT INTO tasks(project_id,kind,title,prompt,status,ran_agent,started_at,finished_at,created_at)
    VALUES(?,'work','Add a login page','build','done','claude',1,100,0)`).run(pid).lastInsertRowid);
  db.close();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const commit = (sha, subject, task, add, del, ago) => ({ sha, subject, author: 'agent-orch', at: Date.now() - ago, task, add, del, files: 1 });
const PATCH = ['diff --git a/login.js b/login.js', 'index 1111111..2222222 100644', '--- a/login.js', '+++ b/login.js',
  '@@ -1,2 +1,2 @@', ' const x = 1;', '-const form = old();', '+const form = login();', ''].join('\n');

// Stubs both endpoints; `detail` maps a sha to [status, body]. Returns the commits list requests' query strings.
async function open({ detail = {}, viewport = { width: 1280, height: 800 } } = {}) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [], lists = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/\/api\/orch\/projects\/\d+\/commits\?/, (route) => {
    const q = new URL(route.request().url()).searchParams;
    lists.push(Object.fromEntries(q));
    const body = q.get('before') === B ? { branch: 'main', commits: [commit(C, 'Initial commit', null, 10, 0, 86400e3 * 2)], more: false }
      : { branch: 'main', commits: [commit(A, `agent-orch #${taskId}: Add a login page`, taskId, 12, 3, 3600e3), commit(B, 'Chat: tidy styles', null, 4, 7, 7200e3)], more: true };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route(/\/api\/orch\/projects\/\d+\/commit\?sha=/, (route) => {
    const sha = new URL(route.request().url()).searchParams.get('sha');
    const [status, body] = detail[sha] || [404, { error: 'no such commit' }];
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`${base}/#${CID}`);
  await page.waitForFunction(() => typeof window.Commits === 'object');
  return { ctx, page, errors, lists };
}

test('History lists commits with counts and task chips, loads older ones, and opens a coloured diff', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, lists } = await open({ detail: { [A]: [200, {
    sha: A, subject: `agent-orch #${taskId}: Add a login page`, body: 'Adds the login form.\n\nCloses the gap.', author: 'agent-orch', at: Date.now() - 3600e3,
    task: taskId, files: [{ path: 'login.js', add: 12, del: 3, binary: false }, { path: 'logo.png', add: 0, del: 0, binary: true }], patch: PATCH, truncated: true,
  }] } });
  const pill = page.locator('#commitsLink');
  await pill.waitFor();
  await pill.click();
  await page.locator('#cmBody .cm-item').nth(1).waitFor();
  const rows = await page.locator('#cmBody .cm-item').evaluateAll((els) => els.map((e) => ({
    subj: e.querySelector('.cm-subj').textContent, add: e.querySelector('.cm-add').textContent, del: e.querySelector('.cm-del').textContent,
    task: e.querySelector('.cm-task')?.textContent || null, when: e.querySelector('.cm-meta').textContent,
  })));
  assert.deepEqual(rows.map(({ when, ...r }) => r), [
    { subj: `agent-orch #${taskId}: Add a login page`, add: '+12', del: '−3', task: `Task #${taskId}` },
    { subj: 'Chat: tidy styles', add: '+4', del: '−7', task: null },
  ]);
  assert.match(rows[0].when, /1h ago/);
  assert.match(rows[0].when, /agent-orch/);
  assert.match(await page.locator('#cmSub').innerText(), /^main · 2\+ commits/);
  const [green, red] = await page.locator('#cmBody .cm-item').first().evaluate((e) => [getComputedStyle(e.querySelector('.cm-add')).color, getComputedStyle(e.querySelector('.cm-del')).color]);
  assert.notEqual(green, red);

  // Load older passes before = the last sha and appends; with more false it goes away.
  await page.locator('#cmBody .cm-more').click();
  await page.locator('#cmBody .cm-item').nth(2).waitFor();
  assert.equal(lists.at(-1).before, B);
  assert.equal(lists.at(-1).limit, '50');
  assert.equal(await page.locator('#cmBody .cm-more').count(), 0);

  // A commit: Back, message, files with counts, the patch with coloured +/−/@@ lines, and the truncated note.
  await page.locator('#cmBody .cm-open').first().click();
  await page.locator('#cmBody .cm-patch').waitFor();
  assert.equal(await page.locator('#cmBody .cm-dsubj').innerText(), `agent-orch #${taskId}: Add a login page`);
  assert.match(await page.locator('#cmBody .cm-body').innerText(), /^Adds the login form\./);
  assert.deepEqual(await page.locator('#cmBody .cm-file').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim())),
    ['login.js +12 −3', 'logo.png binary']);
  const lines = await page.locator('#cmBody .cm-patch > div').evaluateAll((els) => els.map((e) => [e.className, e.textContent, getComputedStyle(e).backgroundColor]));
  const add = lines.find((l) => l[1] === '+const form = login();'), del = lines.find((l) => l[1] === '-const form = old();');
  const hunk = lines.find((l) => l[1].startsWith('@@')), ctxLine = lines.find((l) => l[1] === ' const x = 1;');
  assert.equal(add[0], 'a');
  assert.equal(del[0], 'd');
  assert.equal(hunk[0], 'h');
  assert.equal(ctxLine[0], '');
  assert.equal(lines.find((l) => l[1] === '+++ b/login.js')[0], 'h', 'file headers are not additions');
  assert.notEqual(add[2], 'rgba(0, 0, 0, 0)');
  assert.notEqual(add[2], del[2]);
  assert.match(await page.locator('#cmBody .cm-patch').evaluate((e) => getComputedStyle(e).fontFamily), /monospace/);
  assert.match(await page.locator('#cmBody .cm-trunc').innerText(), /Diff truncated/);

  // Back returns to the list; Escape closes the sheet and focus returns to the pill.
  await page.locator('#cmBody .cm-back').click();
  await page.locator('#cmBody .cm-item').nth(2).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#commitsModal').isHidden(), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'commitsLink');

  // The task chip opens the task drawer.
  await pill.click();
  await page.locator('#cmBody .cm-task').click();
  assert.equal(await page.locator('#commitsModal').isHidden(), true);
  await page.waitForFunction(() => /Add a login page/.test(document.querySelector('#drTitle').textContent));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('History: a failed commit shows the server\'s error with Retry; the list error does too', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  await page.locator('#commitsLink').click();
  await page.locator('#cmBody .cm-open').nth(1).click();
  await page.locator('#cmBody .cm-error').waitFor();
  assert.match(await page.locator('#cmBody .cm-error').innerText(), /no such commit/);
  assert.equal(await page.locator('#cmBody .cm-error button').innerText(), 'Retry');
  assert.equal(await page.locator('#cmBody .cm-back').count(), 1);

  // A list that fails: its error text and Retry; Retry refetches.
  await page.unroute(/\/api\/orch\/projects\/\d+\/commits\?/);
  let calls = 0;
  await page.route(/\/api\/orch\/projects\/\d+\/commits\?/, (route) => {
    calls++;
    route.fulfill({ status: calls === 1 ? 500 : 200, contentType: 'application/json',
      body: JSON.stringify(calls === 1 ? { error: 'git log failed' } : { branch: 'main', commits: [], more: false }) });
  });
  await page.keyboard.press('Escape');
  await page.locator('#commitsLink').click();
  await page.locator('#cmBody .cm-error').waitFor();
  assert.match(await page.locator('#cmBody').innerText(), /git log failed/);
  await page.locator('#cmBody .cm-error button').click();
  await page.waitForFunction(() => document.querySelector('#cmBody').textContent === 'No commits yet');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('History on a phone: 44px task chips and the sheet fits the screen', { skip, timeout: 60000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  await page.route(/\/api\/orch\/projects\/\d+\/commits\?/, (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ branch: 'main', commits: [commit(A, `agent-orch #${taskId}: Add a login page with a rather long subject line`, taskId, 12, 3, 60e3)], more: false }) }));
  await page.goto(`${base}/#${CID}`);
  await page.waitForFunction(() => typeof window.Commits === 'object' && O.project);
  await page.evaluate(() => window.Commits.open());
  const chip = page.locator('#cmBody .cm-task');
  await chip.waitFor();
  const [h, panelW] = await page.evaluate(() => [document.querySelector('#cmBody .cm-task').getBoundingClientRect().height, document.querySelector('#commitsModal .modal-panel').getBoundingClientRect().width]);
  assert.ok(h >= 44, `chip ${h}px`);
  assert.ok(panelW <= 390, `panel ${panelW}px`);
  await ctx.close();
});
