// @-mention file autocomplete in the composer (app.js mentionAt / mentionInput / pickFile, sharing #slashPop with the slash
// commands): in a real browser against server.mjs (no orchestrator, temp data dir) with a seeded chat and GET /api/files/find
// stubbed by Playwright. Skips when Playwright's Chromium can't launch.
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
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const src = (re) => { const m = appJs.match(re); assert.ok(m, `app.js: ${re}`); return m[0]; };
const mentionAt = new Function(src(/^function mentionAt\(.*?^}$/ms) + '\nreturn mentionAt;')();
const PASSWORD = 'file-mention-password';
const CID = 'mention-chat-1';
const FILES = [{ name: 'app.js', path: 'public/app.js', dir: false, size: 10, mtime: 1 }, { name: 'app.css', path: 'public/app.css', dir: false, size: 10, mtime: 1 },
  { name: 'apps', path: 'src/apps', dir: true, size: null, mtime: 1 }];
let browser, noBrowser = false;
try { browser = await chromium.launch(); } catch {
  const mac = macChromiumEnv();
  try { browser = await chromium.launch(mac.AGENT_ORCH_BROWSER_PATH ? { executablePath: mac.AGENT_ORCH_BROWSER_PATH, env: { ...process.env, DYLD_INSERT_LIBRARIES: mac.DYLD_INSERT_LIBRARIES } }
    : { executablePath: findBrowser() || undefined }); } catch (e) { noBrowser = `no Chromium: ${e.message.split('\n')[0]}`; }
}
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (noBrowser) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mention-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const project = path.join(dataDir, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Mentions', cwd: project, mode: 'default',
    agent: 'claude', model: 'claude-opus-5-5', createdAt: 1, updatedAt: 1 }]));
  const port = await freePort();
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('mentionAt: "@" starting a word plus 2+ characters before the caret, never inside an email', () => {
  assert.deepEqual(mentionAt('@app', 4), { start: 0, q: 'app' });
  assert.deepEqual(mentionAt('look at @src/ap please', 13), { start: 8, q: 'src/' });
  assert.deepEqual(mentionAt('fix\n@te', 7), { start: 4, q: 'te' });
  assert.equal(mentionAt('@a', 2), null, 'one character is too short');
  assert.equal(mentionAt('a@b.com', 7), null, 'an email');
  assert.equal(mentionAt('mail me@example.org', 19), null);
  assert.equal(mentionAt('@app done', 9), null, 'the caret is past the word');
  assert.equal(mentionAt('see @app', 3), null, 'the caret is before the @');
});

// The page with the seeded chat open; /api/files/find answers from FILES (name contains q), or as `reply` says.
async function openPage({ hash = `#${CID}`, reply } = {}) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [], finds = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/\/api\/files\/find\?/, (route) => {
    const u = new URL(route.request().url());
    finds.push({ cid: u.searchParams.get('cid'), q: u.searchParams.get('q') });
    if (reply) return route.fulfill(reply(u.searchParams.get('q')));
    const q = u.searchParams.get('q').toLowerCase();
    const entries = FILES.filter((f) => f.name.toLowerCase().includes(q));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ q, entries, truncated: false }) });
  });
  await page.goto(base + '/' + hash);
  await page.locator('#app:not([inert]) #input').waitFor();
  if (hash) await page.waitForFunction((cid) => state.cid === cid, CID, { timeout: 10000 });
  return { ctx, page, errors, finds };
}

test('typing @app lists the stubbed files; Enter inserts @public/app.js and the caret follows', { skip: noBrowser }, async () => {
  const { ctx, page, errors, finds } = await openPage();
  const input = page.locator('#input'), pop = page.locator('#slashPop');
  await input.click();
  await input.pressSequentially('@app');
  await pop.waitFor({ state: 'visible' });
  assert.deepEqual(await pop.locator('.cm-opt .cm-l').allTextContents(), ['app.js', 'app.css', 'apps/']);
  assert.deepEqual(await pop.locator('.cm-opt .cm-h').allTextContents(), ['public', 'public', 'src']);
  assert.equal(await input.getAttribute('aria-expanded'), 'true');
  assert.ok(await pop.evaluate((m) => m.classList.contains('files')));
  // Debounced: one request for the whole word, for this chat.
  assert.deepEqual(finds, [{ cid: CID, q: 'app' }]);
  await input.press('Enter');
  assert.equal(await input.inputValue(), '@public/app.js ');
  assert.equal(await pop.isHidden(), true);
  assert.equal(await page.evaluate(() => [input.selectionStart, input.selectionEnd]).then(String), '15,15');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#messages .msg').length), 0, 'Enter picked the file, it did not send');
  // Mid-sentence: ↓ then Tab replaces just the @word; a folder gets a trailing slash.
  await input.fill('');
  await input.pressSequentially('read @ap now');
  await input.press('ArrowLeft'); await input.press('ArrowLeft'); await input.press('ArrowLeft'); await input.press('ArrowLeft');
  await input.pressSequentially('p');
  await pop.waitFor({ state: 'visible' });
  await input.press('ArrowDown'); await input.press('ArrowDown');
  assert.equal(await pop.locator('.cm-opt[aria-selected="true"] .cm-l').textContent(), 'apps/');
  await input.press('Tab');
  assert.equal(await input.inputValue(), 'read @src/apps/  now');
  // A click picks too and keeps the textarea focused.
  await input.fill('');
  await input.pressSequentially('@css');
  await pop.waitFor({ state: 'visible' });
  await pop.locator('.cm-opt', { hasText: 'app.css' }).click();
  assert.equal(await input.inputValue(), '@public/app.css ');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'input');
  // Esc closes until the text changes; an email never opens it.
  await input.fill('');
  await input.pressSequentially('@app');
  await pop.waitFor({ state: 'visible' });
  await input.press('Escape');
  assert.equal(await pop.isHidden(), true);
  await input.fill('');
  const before = finds.length;
  await input.pressSequentially('mail a@b.com');
  await page.waitForTimeout(400);
  assert.equal(await pop.isHidden(), true);
  assert.equal(finds.length, before, 'no lookup for an email');
  assert.deepEqual(errors.filter((e) => !/renderMetrics|load/i.test(e)), []);
  await ctx.close();
});

test('no match shows one muted "No matching files" row; Esc closes it', { skip: noBrowser }, async () => {
  const { ctx, page } = await openPage();
  const input = page.locator('#input'), pop = page.locator('#slashPop');
  await input.click();
  await input.pressSequentially('@zzz');
  await pop.waitFor({ state: 'visible' });
  assert.deepEqual(await pop.locator('.cm-opt').allTextContents(), ['No matching files']);
  assert.ok(await pop.locator('.cm-opt').isDisabled());
  await input.press('Escape');
  assert.equal(await pop.isHidden(), true);
  await ctx.close();
});

test('a failed lookup hides the menu; no chat open (new-project draft) never looks anything up', { skip: noBrowser }, async () => {
  const bad = await openPage({ reply: () => ({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }) });
  await bad.page.locator('#input').click();
  await bad.page.locator('#input').pressSequentially('@app');
  await bad.page.waitForTimeout(400);
  assert.equal(bad.finds.length, 1);
  assert.equal(await bad.page.locator('#slashPop').isHidden(), true);
  await bad.ctx.close();
  const draft = await openPage({ hash: '' });
  assert.equal(await draft.page.evaluate(() => state.cid), null);
  await draft.page.locator('#input').click();
  await draft.page.locator('#input').pressSequentially('@app');
  await draft.page.waitForTimeout(400);
  assert.equal(draft.finds.length, 0);
  assert.equal(await draft.page.locator('#slashPop').isHidden(), true);
  await draft.ctx.close();
});
