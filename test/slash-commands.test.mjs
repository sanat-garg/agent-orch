// Slash-command autocomplete in the composer: the matching helper (slashMatches, pulled out of app.js's source like
// version-ui.test) and, in a real browser, #slashPop driven by a stubbed ws 'init' frame carrying the SDK's slash_commands
// (server.mjs, no orchestrator, temp data dir). The browser part skips when Playwright's Chromium can't launch.
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
const slashMatches = new Function(src(/^function slashMatches\(.*?^}$/ms) + '\nreturn slashMatches;')();
const COMMANDS = ['pr-review', 'review', 'compact', 'release-notes', 'init', 'clear', 'cost', 'config', 'context', 'doctor', 'help', 'memory'];
const PASSWORD = 'slash-commands-password';
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-slash-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
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

test('slashMatches: prefix matches first, then names containing the text, at most 8', () => {
  assert.deepEqual(slashMatches(COMMANDS, '/re'), ['release-notes', 'review', 'pr-review']);
  assert.deepEqual(slashMatches(COMMANDS, '/RE'), ['release-notes', 'review', 'pr-review'], 'case-insensitive');
  assert.deepEqual(slashMatches(COMMANDS, '/co'), ['compact', 'config', 'context', 'cost']);
  assert.equal(slashMatches(COMMANDS, '/').length, 8);
  assert.deepEqual(slashMatches(COMMANDS, '/'), [...COMMANDS].sort().slice(0, 8));
  assert.deepEqual(slashMatches(['a', 'a', 'b'], '/'), ['a', 'b'], 'duplicates once');
  // Only '/' plus one word: no list once there's a space, without the slash, or with no commands or no match.
  for (const text of ['/re ', '/review it', 're', ' /re', '', '/re\nx']) assert.deepEqual(slashMatches(COMMANDS, text), [], JSON.stringify(text));
  assert.deepEqual(slashMatches([], '/re'), []);
  assert.deepEqual(slashMatches(COMMANDS, '/zzz'), []);
});

async function openPage(commands) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => ws.send(m));
    setTimeout(() => ws.send(JSON.stringify({ t: 'init', model: 'claude-opus-5-5', cwd: '/tmp', mode: 'default', commands })), 300);
  });
  await page.goto(base + '/');
  await page.waitForFunction((n) => (state.commands || []).length === n, commands.length, { timeout: 10000 });
  return { ctx, page, errors };
}

test('typing /re lists /review before /pr-review; Enter inserts it without sending', { skip: noBrowser }, async () => {
  const { ctx, page, errors } = await openPage(COMMANDS);
  const input = page.locator('#input');
  await input.click();
  await input.pressSequentially('/re');
  const pop = page.locator('#slashPop');
  await pop.waitFor({ state: 'visible' });
  assert.deepEqual(await pop.locator('.cm-opt').allTextContents(), ['/release-notes', '/review', '/pr-review']);
  assert.equal(await input.getAttribute('aria-expanded'), 'true');
  assert.equal(await pop.locator('.cm-opt[aria-selected="true"]').textContent(), '/release-notes');
  // ↓ moves to /review; Enter inserts it and doesn't send (the chat list stays empty, the menu closes).
  await input.press('ArrowDown');
  assert.equal(await pop.locator('.cm-opt[aria-selected="true"]').textContent(), '/review');
  assert.equal(await input.getAttribute('aria-activedescendant'), 'slashOpt1');
  await input.press('Enter');
  assert.equal(await input.inputValue(), '/review ');
  assert.equal(await pop.isHidden(), true);
  assert.equal(await page.evaluate(() => state.cid), null, 'Enter picked the command, it did not send');
  // Up from the top wraps to the last; Tab inserts too; Esc closes until the text changes.
  await input.fill('');
  await input.pressSequentially('/c');
  await pop.waitFor({ state: 'visible' });
  await input.press('ArrowUp');
  assert.equal(await pop.locator('.cm-opt[aria-selected="true"]').textContent(), '/doctor');
  await input.press('Tab');
  assert.equal(await input.inputValue(), '/doctor ');
  await input.fill('');
  await input.pressSequentially('/he');
  await pop.waitFor({ state: 'visible' });
  await input.press('Escape');
  assert.equal(await pop.isHidden(), true);
  await input.press('l');
  await pop.waitFor({ state: 'visible' });
  // A click picks one and keeps the textarea focused.
  await pop.locator('.cm-opt', { hasText: '/help' }).click();
  assert.equal(await input.inputValue(), '/help ');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'input');
  assert.deepEqual(errors.filter((e) => !/renderMetrics|load/i.test(e)), []);
  await ctx.close();
});

test('no list when the SDK reported no commands', { skip: noBrowser }, async () => {
  const { ctx, page } = await openPage([]);
  const input = page.locator('#input');
  await input.click();
  await input.pressSequentially('/re');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#slashPop').isHidden(), true);
  assert.equal(await page.locator('#slashPop .cm-opt').count(), 0);
  await ctx.close();
});
