// Auto Delegate fallback editor in a real browser: boots server.mjs (stub codex/agy CLIs, CW_NO_ORCHESTRATOR=1, temp
// data dir) on a spare port, opens the composer popup and checks that remove, undo, reorder (Alt+↑ and drag), add and
// reset each persist through PUT /api/convos/:id/fallbacks. Skips when Playwright's cached Chromium can't launch.
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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'fallbacks-ui-password';
const CID = 'chat-fb';
const START = [
  { agent: 'codex', model: 'gpt-6-sol' },
  { agent: 'antigravity', model: 'gemini-3.1-pro-high' },
  { agent: 'antigravity', model: 'claude-sonnet-4-6' },
];
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, home, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fbui-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fbui-home-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Fallbacks', cwd: path.join(dataDir, 'no-such-project'), mode: 'chat',
    agent: 'codex', model: 'gpt-5.5', createdAt: 1, updatedAt: 1, fullAccess: true, fallbacks: START }]));
  const bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/codex-stub.mjs'), path.join(bin, 'codex'));
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/agy-stub.mjs'), path.join(bin, 'agy'));
  const port = await freePort();
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  const PATH = `${bin}:/usr/local/bin:/usr/bin:/bin:${path.dirname(process.execPath)}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH, AA_API_KEY: '', CW_AA_BASE: 'http://127.0.0.1:9',
    PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  // PUT validates against discovered models: wait for both stub catalogs.
  for (let i = 0; ; i++) {
    const a = await (await fetch(base + '/api/agents', { headers: { cookie } })).json();
    if (['codex', 'antigravity'].every((id) => a.agents.find((x) => x.id === id)?.models.length)) break;
    if (i > 100) assert.fail('model discovery never finished');
    await new Promise((res) => setTimeout(res, 200));
  }
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  for (const d of [dataDir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const saved = async () => (await (await fetch(base + '/api/convos', { headers: { cookie } })).json()).find((c) => c.id === CID).fallbacks;
const models = (list) => list && list.map((f) => f.model);
async function until(want, what) {
  let got;
  for (let i = 0; i < 50; i++) {
    got = models(await saved());
    if (JSON.stringify(got) === JSON.stringify(want)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(got, want, what);
}

test('fallback editor: remove, undo, Alt+↑, drag, add and reset persist via PUT /api/convos/:id/fallbacks', { skip, timeout: 90000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript((cid) => localStorage.setItem(`cw.auto.${cid}`, '1'), CID);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${CID}`);
  await page.locator('#apChip').click();
  const rows = page.locator('#apModal .fe-list .fe-row');
  const names = () => rows.locator('.fe-model').allInnerTexts();
  await assert.doesNotReject(rows.nth(2).waitFor());
  assert.deepEqual(await names(), ['GPT-6-Sol', 'Gemini 3.1 Pro (High)', 'Claude Sonnet 4.6 (Thinking)']);
  assert.deepEqual(await rows.locator('.fe-pos').allInnerTexts(), ['1', '2', '3']);

  // Remove the second model: saved at once, the composer summary follows.
  await rows.nth(1).locator('.fe-rm').click();
  await until(['gpt-6-sol', 'claude-sonnet-4-6'], 'remove persisted');
  assert.deepEqual(await names(), ['GPT-6-Sol', 'Claude Sonnet 4.6 (Thinking)']);
  assert.doesNotMatch(await page.locator('#apChip').getAttribute('title'), /Gemini 3\.1 Pro/);
  // Undo from the toast puts it back in place.
  await page.locator('#toast .toast-act').click();
  await until(['gpt-6-sol', 'gemini-3.1-pro-high', 'claude-sonnet-4-6'], 'undo persisted');
  await rows.nth(1).locator('.fe-rm').click();
  await until(['gpt-6-sol', 'claude-sonnet-4-6'], 'remove persisted again');

  // Move the (now) second model up with Alt+↑ on the focused row; focus stays on it.
  await rows.nth(1).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await until(['claude-sonnet-4-6', 'gpt-6-sol'], 'Alt+↑ persisted');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.key), 'antigravity/claude-sonnet-4-6');

  // Drag the second row above the first by its handle (pointer events, mouse).
  // Let the post-save refetch settle first so the rows aren't replaced mid-gesture.
  await page.waitForFunction(() => document.querySelector('#apModal .fe-list .fe-row')?.dataset.key === 'antigravity/claude-sonnet-4-6');
  await page.waitForTimeout(300);
  const grip = await rows.nth(1).locator('.fe-grip').boundingBox(), first = await rows.nth(0).boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y - 10, { steps: 4 });
  await page.mouse.move(grip.x + grip.width / 2, first.y + 4, { steps: 6 });
  await page.mouse.up();
  await until(['gpt-6-sol', 'claude-sonnet-4-6'], 'drag persisted');

  // Add from the searchable list, then reset to automatic.
  await page.locator('#apModal .fe-add-btn').click();
  await page.locator('#apModal .fe-search').fill('flash');
  await page.locator('#apModal .fe-opt', { hasText: 'Gemini 3.8 Flash' }).click();
  await until(['gpt-6-sol', 'claude-sonnet-4-6', 'gemini-3.8-flash-high'], 'add persisted');
  await page.locator('#apModal .fe-reset').click();
  await until(null, 'reset persisted');
  await page.locator('#apModal .fe-hint', { hasText: 'Automatic' }).waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});
