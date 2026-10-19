// Code block downloads (public/code-download.js): boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) with a chat and a
// done reflect task whose result is Markdown, and drives replies through app.js renderEvent. A block's Download (a bar
// before the pre, never inside it) saves the code's exact bytes as snippet.<ext>, unknown or missing languages as .txt;
// empty blocks are disabled and a failed save says why. Streamed deltas and a reopened task drawer never duplicate the
// bar; shell click-to-copy and selecting code still work; on a phone the button is a 44px target inside the screen.
// Skips when Chromium can't launch.
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
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'code-download-password';
const CID = 'c-code';
const PY = 'def main():\n\tprint("héllo <b> & \'q\'")  \n\n    return   1\n';
const REPLY = ['Here is the script:', '', '```python', PY + '```', '', 'And a weird one:', '', '```foobar', 'x = 1', '```', '',
  'Plain:', '', '```', 'no language', '```', '', 'Run it:', '', '```bash', 'npm test', '```', '', 'Empty:', '', '```js', '```'].join('\n');

let browser, skip = false;
try { browser = await chromium.launch({ env: { ...process.env, ...macChromiumEnv() } }); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, taskId;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-codedl-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const cwd = path.join(dataDir, 'p', 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Code', cwd, mode: 'orchestrator',
    agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true, fallbacks: [] }]));
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
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,created_at) VALUES(?,'Code','active',?,0)").run(cwd, CID).lastInsertRowid);
  taskId = Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,result,created_at) VALUES(?,'reflect','Look around','look','done',?,0)")
    .run(pid, 'Found this:\n\n```ts\nconst a: number = 1;\n```\n\nand\n\n```yaml\nk: v\n```\n').lastInsertRowid);
  db.close();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open({ phone = false } = {}) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => { if (!/renderMetrics/.test(e.stack)) errors.push(e.message); });
  await page.goto(`${base}/#${CID}`);
  await page.locator('#app:not([inert]) #input').waitFor();
  await page.waitForFunction(() => typeof renderEvent === 'function' && state.ws?.readyState === 1);
  return { ctx, page, errors };
}
const reply = (page, text) => page.evaluate((text) => { renderEvent({ t: 'text', text }); }, text);
const lastMsg = (page) => page.locator('#messages .msg.text').last();
async function save(page, button, tap = false) {
  const [dl] = await Promise.all([page.waitForEvent('download'), tap ? button.tap() : button.click()]);
  return { name: dl.suggestedFilename(), bytes: fs.readFileSync(await dl.path()) };
}

test('downloads each block\'s exact bytes and filename, .txt for unknown languages, disabled when empty', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  await reply(page, REPLY);
  const msg = lastMsg(page);
  await msg.locator('.cd-bar').nth(4).waitFor();
  assert.equal(await msg.locator('pre').count(), 5);
  assert.equal(await msg.locator('.cd-bar').count(), 5, 'one bar per block');
  assert.equal(await msg.locator('pre .cd-bar, pre .cd-btn').count(), 0, 'the action is outside the pre');
  assert.equal(await msg.evaluate((m) => [...m.querySelectorAll('pre')].every((p) => p.previousElementSibling?.classList.contains('cd-bar'))), true);

  const btn = (i) => msg.locator('.cd-btn').nth(i);
  let f = await save(page, btn(0));
  assert.equal(f.name, 'snippet.py');
  assert.ok(f.bytes.equals(Buffer.from(PY, 'utf8')), `exact bytes, tabs and trailing spaces kept: ${JSON.stringify(f.bytes.toString())}`);
  assert.equal(await btn(0).getAttribute('aria-label'), 'Download code as snippet.py');
  assert.equal(await msg.locator('.cd-bar').nth(0).locator('.cd-lang').textContent(), 'python');
  f = await save(page, btn(1));
  assert.deepEqual([f.name, f.bytes.toString()], ['snippet.txt', 'x = 1\n'], 'unknown language falls back to .txt');
  f = await save(page, btn(2));
  assert.deepEqual([f.name, f.bytes.toString()], ['snippet.txt', 'no language\n']);
  assert.equal(await msg.locator('.cd-bar').nth(2).locator('.cd-lang').count(), 0, 'no label without a language');
  f = await save(page, btn(3));
  assert.deepEqual([f.name, f.bytes.toString()], ['snippet.sh', 'npm test\n']);
  assert.equal(await btn(4).isDisabled(), true, 'empty block cannot be downloaded');
  assert.equal(await btn(4).getAttribute('aria-label'), 'Download (empty code block)');

  // A failed save says so in a toast.
  await page.evaluate(() => { URL.createObjectURL = () => { throw new Error('quota exceeded'); }; });
  await btn(1).click();
  await page.locator('#toasts .toast-error .toast-msg').waitFor();
  assert.equal(await page.locator('#toasts .toast-error .toast-msg').last().textContent(), 'Couldn’t download the code: quota exceeded');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('shell click-to-copy and selecting code still work beside the Download bar', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await reply(page, 'Run:\n\n```bash\nnpm test\n```\n');
  const msg = lastMsg(page);
  await msg.locator('.cd-bar').waitFor();
  assert.equal(await msg.locator('pre').getAttribute('class'), 'copy-cmd');
  await page.evaluate(() => navigator.clipboard.writeText('before'));
  await msg.locator('.cd-btn').click();
  assert.equal(await page.locator('.copy-tip').count(), 0, 'Download does not trigger copy');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'before');
  await msg.locator('pre').click();
  await page.locator('.copy-tip').waitFor();
  assert.equal(await page.locator('.copy-tip').textContent(), 'Copied');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'npm test');
  const sel = await msg.evaluate((m) => {
    const r = document.createRange();
    r.selectNodeContents(m);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    return { text: String(getSelection()), pre: getComputedStyle(m.querySelector('pre')).userSelect, bar: getComputedStyle(m.querySelector('.cd-bar')).userSelect };
  });
  assert.notEqual(sel.pre, 'none');
  assert.equal(sel.bar, 'none', 'the bar stays out of selections');
  assert.match(sel.text, /npm test/);
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('a streamed reply and a reopened task drawer never duplicate the bar', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  const parts = ['Sure:\n\n```js\n', 'const a = 1;\n', 'const b = 2;\n', '```\n\nThen:\n\n```py\nx', ' = 3\n```\n'];
  for (const p of parts) {
    await page.evaluate((text) => renderEvent({ t: 'delta', text }), p);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const n = await page.evaluate(() => { const m = state.live; return { pres: m.querySelectorAll('pre').length, bars: m.querySelectorAll('.cd-bar').length }; });
    assert.equal(n.bars, n.pres, `one bar per block while streaming (${JSON.stringify(n)})`);
  }
  let f = await save(page, page.locator('#messages .msg.streaming .cd-btn').first());
  assert.deepEqual([f.name, f.bytes.toString()], ['snippet.js', 'const a = 1;\nconst b = 2;\n'], 'mid-stream the latest text downloads');
  await reply(page, parts.join(''));
  const msg = lastMsg(page);
  await msg.locator('.cd-bar').nth(1).waitFor();
  assert.equal(await msg.locator('.cd-bar').count(), 2);
  assert.equal(await page.locator('#messages .cd-bar').count(), 2, 'no orphan bars left behind');
  f = await save(page, msg.locator('.cd-btn').nth(1));
  assert.deepEqual([f.name, f.bytes.toString()], ['snippet.py', 'x = 3\n']);

  for (let i = 0; i < 3; i++) {
    await page.evaluate((id) => openTask(id), taskId);
    await page.locator('#drBody .dr-said .cd-bar').nth(1).waitFor();
    await page.waitForFunction(() => O.detail);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    assert.deepEqual(await page.evaluate(() => [document.querySelectorAll('#drBody pre').length, document.querySelectorAll('#drBody .cd-bar').length]),
      [2, 2], `reopen ${i}: one bar per block`);
    await page.evaluate(() => closeTask());
  }
  await page.evaluate((id) => openTask(id), taskId);
  f = await save(page, page.locator('#drBody .dr-said .cd-btn').first());
  assert.deepEqual([f.name, f.bytes.toString()], ['snippet.ts', 'const a: number = 1;\n']);
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('phone: the Download button is a 44px target on screen beside a wide block, and a tap saves the file', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ phone: true });
  const wide = `const s = '${'wide '.repeat(60)}';`;
  await reply(page, `Wide:\n\n\`\`\`js\n${wide}\n\`\`\`\n`);
  const btn = lastMsg(page).locator('.cd-btn');
  await btn.waitFor();
  await btn.scrollIntoViewIfNeeded();
  const r = await btn.evaluate((b) => {
    const r = b.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { left: r.left, right: r.right, w: r.width, h: r.height, hit: hit === b, vw: innerWidth, sw: document.documentElement.scrollWidth };
  });
  assert.ok(r.h >= 44 && r.w >= 44, `44px target (${r.w}×${r.h})`);
  assert.ok(r.left >= 0 && r.right <= r.vw, `inside the screen (${r.left}–${r.right} of ${r.vw})`);
  assert.ok(r.hit, 'nothing covers it');
  assert.ok(r.sw <= r.vw, 'the page does not widen');
  const f = await save(page, btn, true);
  assert.deepEqual([f.name, f.bytes.toString()], ['snippet.js', wide + '\n']);
  await ctx.close();
  assert.deepEqual(errors, []);
});
