// A long chat in a real browser (owner, 2026-10-12: switching projects took up to 30 s on the phone): it opens with only
// its recent prompts (chat-log.mjs logWindow), "Show earlier messages" prepends older ones without moving what's on
// screen, tool cards build their contents only when opened, and a card whose output was clipped fetches it whole.
// Boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) on a spare port. Skips when Playwright's Chromium can't launch.
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
import { CLIP_CHARS } from '../chat-log.mjs';
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'history-ui-password';
const CID = 'chat-history';
const TURNS = 30, CALLS = 20; // 30 prompts of 43 events each: several windows
const BIG = `${'line of output\n'.repeat(Math.ceil((CLIP_CHARS * 2) / 15))}END-OF-OUTPUT`;
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() }; // the MacBook worker's LaunchDaemon needs a shim (helpers/mac-chromium.mjs)
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-historyui-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Long chat', cwd: dataDir, mode: 'default',
    agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true }]));
  const evs = [];
  for (let n = 0; n < TURNS; n++) {
    evs.push({ t: 'user', text: `prompt ${n}`, ts: 1000 + n });
    for (let k = 0; k < CALLS; k++) {
      const big = n === TURNS - 1 && k === 0, id = `toolu_${n}_${k}`;
      evs.push({ t: 'tool_use', id, name: 'Bash', input: { command: big ? 'cat big-output.txt' : `echo ${n}.${k}`, description: big ? 'Print the big output' : `Step ${k}` } });
      evs.push({ t: 'tool_result', id, text: big ? BIG : `${n}.${k}` });
    }
    evs.push({ t: 'text', text: `**reply ${n}**` }, { t: 'result', ok: true, ms: 1200, turns: CALLS });
  }
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'logs', `${CID}.jsonl`), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
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
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(viewport, mobile = false) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(mobile ? { viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${CID}`);
  await page.locator('#messages .msg.user', { hasText: `prompt ${TURNS - 1}` }).waitFor();
  return { ctx, page, errors };
}
const prompts = (page) => page.locator('#messages .msg.user').evaluateAll((els) => els.map((e) => e.firstChild.textContent));
// Shows earlier messages with the view at the top, as a reader scrolling up would; → how far the old first prompt moved.
async function showEarlier(page) {
  const before = (await prompts(page)).length;
  const shift = await page.evaluate(async () => {
    const sc = document.getElementById('scroller'), first = document.querySelector('#messages .msg.user');
    sc.scrollTop = 0;
    await new Promise(requestAnimationFrame);
    const top = first.getBoundingClientRect().top;
    document.querySelector('#messages > .history-more').click();
    for (let i = 0; i < 200 && document.querySelector('#messages .msg.user') === first; i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise(requestAnimationFrame);
    return Math.abs(first.getBoundingClientRect().top - top);
  });
  assert.ok((await prompts(page)).length > before, 'older prompts were added');
  return shift;
}

test('desktop: a long chat opens with its recent prompts; earlier ones load above without moving the view', { skip, timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  const first = await prompts(page);
  assert.ok(first.length >= 2 && first.length < TURNS / 2, `opened with ${first.length} of ${TURNS} prompts`);
  assert.deepEqual(first, first.map((_, i) => `prompt ${TURNS - first.length + i}`));
  assert.equal(await page.locator('#messages > .history-more').innerText(), 'Show earlier messages');
  assert.ok(await page.evaluate(() => { const s = document.getElementById('scroller'); return s.scrollHeight - s.scrollTop - s.clientHeight < 2; }), 'opens at the bottom');

  // Closed cards are built when opened; the clipped one fetches its output whole.
  assert.equal(await page.locator('#messages details.tool:not([open]) > .body').first().evaluate((b) => b.childElementCount), 0);
  const big = page.locator('#messages details.tool', { hasText: 'Print the big output' });
  assert.equal(await big.locator('.body').evaluate((b) => b.childElementCount), 0);
  await big.locator('summary .tn').click(); // the label: a click on a Bash command copies it
  await big.locator('pre.out', { hasText: 'END-OF-OUTPUT' }).waitFor();
  assert.equal(await big.locator('pre.out').innerText(), BIG.trim());
  assert.equal(await big.locator('pre.cmd').innerText(), '$ cat big-output.txt');
  const small = page.locator('#messages details.tool', { hasText: `Step 3` }).last();
  await small.locator('summary .tn').click();
  assert.equal(await small.locator('pre.out').innerText(), `${TURNS - 1}.3`);

  // Page back to the first prompt: each batch lands above without moving what was on screen.
  let pages = 0;
  while (await page.locator('#messages > .history-more').count()) {
    assert.ok((await showEarlier(page)) < 2, 'the view stays put');
    assert.ok(++pages < TURNS, 'reaches the start');
  }
  assert.deepEqual(await prompts(page), Array.from({ length: TURNS }, (_, i) => `prompt ${i}`));
  assert.equal(await page.locator('#messages details.tool').count(), TURNS * CALLS);
  assert.equal(await page.locator('#messages .msg.text', { hasText: 'reply 0' }).count(), 1);
  assert.equal(await page.locator('#messages details.tool.running').count(), 0, 'every earlier call shows finished');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: the same window with folded tool runs; Show earlier is a 44pt target', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844 }, true);
  const first = await prompts(page);
  assert.ok(first.length < TURNS / 2);
  assert.ok(await page.locator('#messages > .tool-stack').count() >= first.length, 'tool runs fold into stacks');
  const more = page.locator('#messages > .history-more');
  assert.ok((await more.boundingBox()).height >= 44);
  assert.ok((await showEarlier(page)) < 2);
  // A card inside a stack fills when opened.
  const stack = page.locator('#messages > .tool-stack').last();
  await stack.locator(':scope > summary').click();
  const card = stack.locator('details.tool', { hasText: 'Step 5' });
  await card.locator('summary .tn').click();
  assert.equal(await card.locator('pre.out').innerText(), `${TURNS - 1}.5`);
  assert.deepEqual(errors, []);
  await ctx.close();
});
