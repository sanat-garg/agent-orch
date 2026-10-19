// The composer's saved-prompt library (prompts.js, browser-local) in a real browser: boots server.mjs
// (CW_NO_ORCHESTRATOR=1, temp data dir) on a spare port with two chats in two project folders. Saving the draft needs a
// name and text and leaves the draft alone; entries survive a reload and insert at the cursor without sending; each
// project (and signed-in user) has its own list; edit, delete and a full-storage error; phones reach it from '+'.
// Skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'prompt-library-password';
const CID = 'chat-web', CID2 = 'chat-other';
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() };
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, web, other;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-prompts-'));
  web = path.join(dataDir, 'web'); other = path.join(dataDir, 'other');
  fs.mkdirSync(web); fs.mkdirSync(other);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const convo = (id, title, cwd) => ({ id, title, cwd, mode: 'chat', agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([convo(CID, 'Web', web), convo(CID2, 'Other', other)]));
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
});

after(async () => {
  await browser?.close();
  child?.removeAllListeners('exit');
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function newPage({ viewport = { width: 1280, height: 800 } } = {}) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}
async function openChat(page, cid) {
  await page.goto(`${base}/#${cid}`);
  // Wait for the chat's history too: it resets the composer to the stored draft, so typing before it lands is lost.
  await page.waitForFunction((id) => typeof window.Prompts === 'object' && state.cid === id && !!currentConvo()?.cwd
    && state.mark != null && state.restored == null, cid);
}
const stored = (page, dir) => page.evaluate(([k]) => JSON.parse(localStorage.getItem(k) || '[]'), [`cw.prompts.v1.${JSON.stringify(['admin', dir])}`]);
const names = (page) => page.$$eval('#plModal .pl-name-t', (ns) => ns.map((n) => n.textContent));
async function saveDraft(page, name) {
  await page.click('#promptsChip');
  await page.click('#plModal .pl-save-draft');
  await page.fill('#plModal .pl-name', name);
  await page.click('#plModal .pl-save');
  await page.waitForSelector('#plModal .pl-form', { state: 'detached' });
}

test('save needs a name and text, keeps the draft, survives a reload and inserts at the cursor without sending', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await newPage();
  await openChat(page, CID);
  await page.fill('#input', 'Run the linter and fix what it finds');
  await page.click('#promptsChip');
  assert.equal(await page.isVisible('#plModal'), true);
  assert.match(await page.textContent('#plSub'), /only in this browser/i, 'labelled browser-local');
  await page.click('#plModal .pl-save-draft');
  assert.equal(await page.inputValue('#plModal .pl-ta'), 'Run the linter and fix what it finds', 'the editor starts from the draft');
  // No name: rejected, nothing stored.
  await page.click('#plModal .pl-save');
  assert.match(await page.textContent('#plModal .pl-form-err'), /name/i);
  assert.deepEqual(await stored(page, web), []);
  // A name but only whitespace for the prompt: rejected too.
  await page.fill('#plModal .pl-name', 'Lint');
  await page.fill('#plModal .pl-ta', '   \n ');
  await page.click('#plModal .pl-save');
  assert.match(await page.textContent('#plModal .pl-form-err'), /empty/i);
  assert.deepEqual(await stored(page, web), []);
  await page.fill('#plModal .pl-ta', 'Run the linter and fix what it finds');
  await page.click('#plModal .pl-save');
  await page.waitForSelector('#plModal .pl-card');
  assert.deepEqual(await names(page), ['Lint']);
  assert.equal((await stored(page, web))[0].text, 'Run the linter and fix what it finds');
  // A duplicate name is refused.
  await page.click('#plModal .pl-save-draft');
  await page.fill('#plModal .pl-name', ' lint ');
  await page.click('#plModal .pl-save');
  assert.match(await page.textContent('#plModal .pl-form-err'), /already named/);
  await page.click('#plModal .pl-cancel');
  await page.keyboard.press('Escape');
  assert.equal(await page.isHidden('#plModal'), true);
  assert.equal(await page.inputValue('#input'), 'Run the linter and fix what it finds', 'saving leaves the draft in the composer');

  // Reload: the entry is still there; insert it in the middle of a new draft.
  await page.reload();
  await openChat(page, CID);
  await page.fill('#input', 'Please  then commit.');
  await page.evaluate(() => { const i = $('input'); i.focus(); i.setSelectionRange(7, 7); });
  await page.click('#promptsChip');
  assert.deepEqual(await names(page), ['Lint']);
  await page.click('#plModal .pl-insert');
  assert.equal(await page.isHidden('#plModal'), true);
  assert.equal(await page.inputValue('#input'), 'Please Run the linter and fix what it finds then commit.');
  assert.equal(await page.evaluate(() => $('input').selectionStart), 7 + 'Run the linter and fix what it finds'.length, 'the cursor ends after the insert');
  assert.equal(await page.evaluate((cid) => localStorage.getItem('cw.draft.' + cid), CID), 'Please Run the linter and fix what it finds then commit.', 'the draft is saved');
  assert.equal(await page.$$eval('#messages .msg.user, #messages .user', (n) => n.length), 0, 'nothing was sent');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('each project and each signed-in user has its own list', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await newPage();
  await openChat(page, CID);
  await page.evaluate(() => localStorage.clear());
  await page.fill('#input', 'Web only prompt');
  await saveDraft(page, 'Web one');
  await page.keyboard.press('Escape');
  await openChat(page, CID2);
  await page.click('#promptsChip');
  assert.deepEqual(await names(page), [], 'the other project starts empty');
  assert.match(await page.textContent('#plModal .pl-empty'), /No saved prompts/);
  await page.keyboard.press('Escape');
  await page.fill('#input', 'Other only prompt');
  await saveDraft(page, 'Other one');
  assert.deepEqual(await names(page), ['Other one']);
  await page.keyboard.press('Escape');
  await openChat(page, CID);
  await page.click('#promptsChip');
  assert.deepEqual(await names(page), ['Web one']);
  await page.keyboard.press('Escape');
  assert.deepEqual((await stored(page, web)).map((x) => x.name), ['Web one']);
  assert.deepEqual((await stored(page, other)).map((x) => x.name), ['Other one']);
  // Another account signed in to this browser sees none of the admin's.
  await page.evaluate(() => { me.user = { ...me.user, id: 'bob', name: 'Bob' }; });
  await page.click('#promptsChip');
  assert.deepEqual(await names(page), []);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { me.user = { ...me.user, id: 'admin' }; });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('edit and delete (with undo), and a full browser storage shows an error and keeps the editor', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await newPage();
  await openChat(page, CID);
  await page.evaluate(() => localStorage.clear());
  await page.fill('#input', 'First version');
  await saveDraft(page, 'Note');
  await page.click('#plModal .pl-edit');
  assert.equal(await page.inputValue('#plModal .pl-name'), 'Note');
  await page.fill('#plModal .pl-ta', 'Second version');
  await page.click('#plModal .pl-save');
  await page.waitForSelector('#plModal .pl-card');
  assert.deepEqual((await stored(page, web)).map((x) => x.text), ['Second version']);
  await page.click('#plModal .pl-del');
  assert.deepEqual(await names(page), []);
  assert.deepEqual(await stored(page, web), []);
  await page.click('#toasts button:has-text("Undo")');
  assert.deepEqual(await names(page), ['Note']);
  // The browser refuses the write: the error shows, the editor and its text stay, nothing changes.
  await page.evaluate(() => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k.startsWith('cw.prompts.')) throw new DOMException('exceeded the quota', 'QuotaExceededError');
      return real.call(this, k, v);
    };
  });
  await page.click('#plModal .pl-save-draft');
  await page.fill('#plModal .pl-name', 'Too much');
  await page.click('#plModal .pl-save');
  assert.match(await page.textContent('#plModal .pl-form-err'), /storage .*full/);
  assert.equal(await page.inputValue('#plModal .pl-name'), 'Too much');
  assert.deepEqual((await stored(page, web)).map((x) => x.name), ['Note']);
  // Closing keeps the unfinished edit for next time.
  await page.keyboard.press('Escape');
  await page.click('#promptsChip');
  assert.equal(await page.inputValue('#plModal .pl-name'), 'Too much');
  assert.equal(await page.inputValue('#input'), 'First version', 'the composer draft is untouched');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phones open the library from the \'+\' sheet and insert into the composer', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await newPage({ viewport: { width: 390, height: 844 } });
  await openChat(page, CID);
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify([{ id: 'a', name: 'Ship', text: 'Ship it', at: 1 }])),
    `cw.prompts.v1.${JSON.stringify(['admin', web])}`);
  assert.equal(await page.isHidden('#promptsChip'), true, 'no chip in the phone composer');
  await page.fill('#input', 'Now: ');
  await page.click('#plusBtn');
  await page.click('#psPrompts');
  assert.equal(await page.isHidden('#plusSheet'), true);
  assert.equal(await page.isVisible('#plModal'), true);
  await page.click('#plModal .pl-insert');
  assert.equal(await page.inputValue('#input'), 'Now: Ship it');
  assert.deepEqual(errors, []);
  await ctx.close();
});
