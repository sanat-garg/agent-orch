// The History sheet's 'Ask to undo…' (commits.js askUndo) in a real browser, with test/ui-commits.test.mjs's setup:
// server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) on a spare port with a chat on a project, the commits endpoints
// stubbed with page.route. Pressing the button on a commit drafts a `git revert <sha>` request into the project chat's
// message box (appended after an existing draft, saved as the chat's draft, never sent) and closes the sheet; with no
// project chat an inline status explains and nothing is drafted. Skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'history-undo-password';
const CID = 'chat-undo';
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-historyundo-'));
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
  // CW_NO_ORCHESTRATOR skips ensureProject, so the project's main chat is set here.
  pid = Number(db.prepare("INSERT INTO projects(path,name,convo_id,status,created_at) VALUES(?,?,?,'active',0)").run(web, 'web', CID).lastInsertRowid);
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

test('Ask to undo… drafts a git revert request into the chat box after the existing draft, without sending', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ detail: { [A]: [200, {
    sha: A, subject: `agent-orch #${taskId}: Add a login page`, body: '', author: 'agent-orch', at: Date.now() - 3600e3,
    task: taskId, files: [{ path: 'login.js', add: 12, del: 3, binary: false }], patch: PATCH, truncated: false,
  }] } });
  await page.waitForFunction(() => O.project?.convo_id);
  await page.fill('#input', 'Also tidy the footer.  ');
  const pill = page.locator('#commitsLink');
  await pill.waitFor();
  await pill.click();
  await page.locator('#cmBody .cm-open').first().click();
  await page.locator('#cmBody .cm-patch').waitFor();
  const undo = page.locator('#cmBody .cm-undo');
  assert.equal(await undo.innerText(), 'Ask to undo…');
  await undo.click();
  assert.equal(await page.locator('#commitsModal').isHidden(), true, 'the sheet closes');
  const draft = await page.locator('#input').inputValue();
  assert.match(draft, /^Also tidy the footer\.\n\nUndo commit aaaaaaa \("agent-orch #\d+: Add a login page"\), from task #\d+, with `git revert a{40}` as a new commit\. Keep everything after it; never reset or rewrite main\. Check the app still works afterwards\.$/);
  assert.ok(draft.includes(`git revert ${A}`));
  assert.ok(draft.includes(`from task #${taskId}`));
  assert.equal(await page.evaluate((cid) => localStorage.getItem('cw.draft.' + cid), CID), draft, 'saved as the chat\'s draft');
  assert.equal(await page.evaluate(() => document.querySelector('#app').dataset.view), 'chat');
  assert.equal(await page.locator('#messages .msg.user').count(), 0, 'nothing was sent');
  await page.waitForFunction(() => /Added to the chat/.test(document.querySelector('#toasts').textContent));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Ask to undo… on a commit without a task names no task; with no project chat it explains and drafts nothing', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  await page.waitForFunction(() => O.project?.convo_id);
  await page.locator('#commitsLink').click();
  await page.locator('#cmBody .cm-open').nth(1).click(); // B: the detail 404s, the row's data still names the commit
  await page.locator('#cmBody .cm-error').waitFor();
  await page.locator('#cmBody .cm-undo').click();
  assert.equal(await page.locator('#commitsModal').isHidden(), true);
  const draft = await page.locator('#input').inputValue();
  assert.match(draft, /^Undo commit bbbbbbb \("Chat: tidy styles"\) with `git revert b{40}` as a new commit\./);
  assert.ok(!/from task/.test(draft));

  // No chat: the button says why inline, the sheet stays open and the box is untouched.
  await page.fill('#input', '');
  await page.evaluate(() => { O.project.convo_id = null; });
  await page.locator('#commitsLink').click();
  await page.locator('#cmBody .cm-open').first().click();
  await page.locator('#cmBody .cm-undo').click();
  await page.locator('#cmBody .cm-undo-msg').waitFor();
  assert.match(await page.locator('#cmBody .cm-undo-msg').innerText(), /no chat to ask/);
  assert.equal(await page.locator('#commitsModal').isHidden(), false);
  assert.equal(await page.locator('#input').inputValue(), '');
  assert.equal(await page.evaluate((cid) => localStorage.getItem('cw.draft.' + cid) || '', CID), '');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Ask to undo… on a phone is a 44px button', { skip, timeout: 60000 }, async () => {
  const [name, value] = cookie.split('=');
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  await mctx.addCookies([{ name, value, url: base }]);
  const mpage = await mctx.newPage();
  await mpage.route(/\/api\/orch\/projects\/\d+\/commits\?/, (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ branch: 'main', commits: [commit(A, 'Chat: tidy styles', null, 4, 7, 60e3)], more: false }) }));
  await mpage.route(/\/api\/orch\/projects\/\d+\/commit\?sha=/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"no such commit"}' }));
  await mpage.goto(`${base}/#${CID}`);
  await mpage.waitForFunction(() => typeof window.Commits === 'object' && O.project);
  await mpage.evaluate(() => window.Commits.open());
  await mpage.locator('#cmBody .cm-open').click();
  const undo = mpage.locator('#cmBody .cm-undo');
  await undo.waitFor();
  const h = await undo.evaluate((e) => e.getBoundingClientRect().height);
  assert.ok(h >= 44, `button ${h}px`);
  await mctx.close();
});
