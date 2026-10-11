// The phone layout (phone.css + app.js addTool / convoItem / settings groups) in a real browser at 390×844 with touch:
// back-to-back tool calls fold into one "Ran 3 commands" line (a lone call stays a card), opening a chat doesn't focus
// the composer (no keyboard over the chat), the drawer's project rows carry a letter badge and a status line, Settings
// rows sit in inset groups, and the queue hint uses touch wording. Desktop keeps the old cards and flat rows.
// Boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) on a spare port; skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'phone-layout-password';
const CID = 'chat-phone', OLD = 'chat-old';
const OLD_AT = Date.UTC(2026, 2, 3, 12); // a Tuesday in March: older than a week, so the row shows "Mar 3"
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() };
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-phone-'));
  const web = path.join(dataDir, 'web'), old = path.join(dataDir, 'old');
  fs.mkdirSync(web); fs.mkdirSync(old);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const convo = (id, title, cwd, at) => ({ id, title, cwd, mode: 'chat', agent: 'claude', model: 'opus', createdAt: 1, updatedAt: at, fullAccess: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([convo(CID, 'Web', web, Date.now() - 5 * 60e3), convo(OLD, 'Old', old, OLD_AT)]));
  const bash = (id, description) => [{ t: 'tool_use', id, name: 'Bash', input: { command: `echo ${id}`, description } },
    { t: 'tool_result', id, text: id, isError: false }];
  const events = [
    { t: 'user', text: 'check the build' },
    ...bash('b1', 'Check the build'), ...bash('b2', 'Run the tests'), ...bash('b3', 'List the files'),
    { t: 'text', text: 'All good. One more look:' },
    ...bash('b4', 'Show the log'),
    { t: 'text', text: 'Done.' },
    { t: 'result', ok: true, ms: 1200 },
  ];
  fs.mkdirSync(path.join(dataDir, 'logs'));
  fs.writeFileSync(path.join(dataDir, 'logs', `${CID}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
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
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
async function open(opts = PHONE) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(opts);
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${CID}`);
  await page.locator('#messages .msg.user').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg.text').length === 2);
  return { ctx, page, errors };
}

test('phone chat: back-to-back tool calls fold into one line, a lone call stays a card, and the composer is not focused', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  const view = await page.evaluate(() => ({
    kids: [...document.getElementById('messages').children].map((n) => n.classList.contains('tool-stack') ? 'stack' : n.matches('details.tool') ? 'tool' : n.classList[0]),
    sum: document.querySelector('.tool-stack .tk-sum')?.textContent,
    inStack: document.querySelectorAll('.tool-stack .tk-body > .tool').length,
    focused: document.activeElement?.id,
  }));
  assert.deepEqual(view.kids, ['msg', 'stack', 'msg', 'tool', 'msg', 'meta']);
  assert.equal(view.sum, 'Ran 3 commands');
  assert.equal(view.inStack, 3);
  assert.notEqual(view.focused, 'input', 'opening a chat on a phone leaves the keyboard down');
  const sum = page.locator('.tool-stack > summary');
  const box = await sum.boundingBox();
  assert.ok(box.height >= 44, `the folded line is a 44pt target (${box.height})`);
  await sum.tap();
  assert.equal(await page.locator('.tool-stack .tk-body > .tool').first().isVisible(), true);
  // The composer is one field: text on top, '+' / model / send in a row inside its border.
  const r = await page.evaluate(() => {
    const rect = (id) => document.getElementById(id).getBoundingClientRect();
    const b = document.querySelector('#composer .box').getBoundingClientRect();
    return { box: [b.top, b.bottom], input: rect('input').bottom, send: [rect('send').top, rect('send').bottom], plus: rect('plusBtn').top };
  });
  assert.ok(r.send[0] >= r.input - 1 && r.send[1] <= r.box[1], 'send sits under the text, inside the field');
  assert.ok(Math.abs(r.plus - r.send[0]) < 8, '+ and send share the bottom row');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone drawer: project rows show the name and a status line (no letter badge); Settings rows sit in inset groups', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  await page.locator('#openSidebar').tap();
  const row = (cid) => page.locator(`#convoList .convo[data-cid="${cid}"]`);
  await row(OLD).waitFor();
  assert.equal(await row(CID).locator('.cav').count(), 0);
  assert.match(await row(CID).locator('.csub').innerText(), /^5m ago$/);
  const old = await row(OLD).locator('.csub').innerText();
  assert.ok(/Mar/.test(old) && !old.includes('/'), `an old project shows a short date (${old})`);
  assert.ok((await row(CID).boundingBox()).height >= 60);
  // The tiles sit in one row.
  const tops = await page.$$eval('.side-links .side-link', (ls) => ls.map((l) => Math.round(l.getBoundingClientRect().top)));
  assert.equal(new Set(tops).size, 1);
  await page.locator('#settingsBtn').tap();
  await page.locator('#settingsModal .st-group').first().waitFor();
  const groups = await page.$$eval('#settingsModal .st-group', (gs) => gs.map((g) => [getComputedStyle(g).display, g.querySelectorAll(':scope > .st-row').length]));
  assert.ok(groups.length >= 4);
  assert.ok(groups.every(([d, n]) => d === 'block' && n >= 1));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('touch wording in the Queue hint; desktop keeps cards, flat settings and the focused composer', { skip, timeout: 60000 }, async () => {
  const { ctx, page } = await open();
  assert.equal(await page.locator('#qSub .touch-only').evaluate((e) => getComputedStyle(e).display), 'inline');
  assert.equal(await page.locator('#qSub .fine-only').evaluate((e) => getComputedStyle(e).display), 'none');
  await ctx.close();
  const desk = await open({ viewport: { width: 1280, height: 800 } });
  const v = await desk.page.evaluate(() => ({
    stacks: document.querySelectorAll('.tool-stack').length,
    tools: document.querySelectorAll('#messages > details.tool').length,
    group: getComputedStyle(document.querySelector('#settingsModal .st-group')).display,
  }));
  assert.deepEqual(v, { stacks: 0, tools: 4, group: 'contents' });
  await desk.page.waitForFunction(() => document.activeElement?.id === 'input');
  await desk.ctx.close();
});
