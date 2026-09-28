// The composer's one model pill (model + fallbacks) in a real browser: boots server.mjs (stub codex CLI with a wide
// catalog, CW_NO_ORCHESTRATOR=1, temp data dir) on a spare port. The pill reads 'primary → first fallback +N' with the
// whole chain in its title; it opens one sheet whose Model section sets the primary (the sheet stays open) and whose
// fallback section adds, removes and reorders via PUT /api/convos/:id/fallbacks; the old Fallbacks button is gone; at
// 390px it fits, the fallback part truncates first and the sheet is a bottom sheet. Skips when Chromium can't launch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedPath } from './helpers/isolated-path.mjs';
import { macChromiumEnv } from './helpers/mac-chromium.mjs';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'model-fallbacks-ui-password';
const CID = 'chat-pill';
const START = [
  { agent: 'codex', model: 'gpt-6-sol' },
  { agent: 'codex', model: 'gpt-6-astra' },
  { agent: 'codex', model: 'gpt-6-nova' },
];
const macEnv = macChromiumEnv(); // Chromium on the MacBook worker's LaunchDaemon needs a shim (helpers/mac-chromium.mjs)
let browser, skip = false;
try {
  browser = await chromium.launch({ env: { ...process.env, ...macEnv }, ...(macEnv.AGENT_ORCH_BROWSER_PATH && { executablePath: macEnv.AGENT_ORCH_BROWSER_PATH }) });
} catch (e) { skip = `Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, home, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pill-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pill-home-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Pill', cwd: path.join(dataDir, 'no-such-project'), mode: 'bypassPermissions',
    agent: 'codex', model: 'gpt-5.5', createdAt: 1, updatedAt: 1, fullAccess: true, fallbacks: START }]));
  const bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/codex-stub.mjs'), path.join(bin, 'codex'));
  const port = await freePort();
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH: isolatedPath(bin), CODEX_STUB_MODELS: 'wide',
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
  // PUT validates against discovered models: wait for the stub catalog.
  for (let i = 0; ; i++) {
    const a = await (await fetch(base + '/api/agents', { headers: { cookie } })).json();
    if (a.agents.find((x) => x.id === 'codex')?.models.length) break;
    if (i > 100) assert.fail('model discovery never finished');
    await new Promise((res) => setTimeout(res, 200));
  }
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  for (const d of [dataDir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const convo = async () => (await (await fetch(base + '/api/convos', { headers: { cookie } })).json()).find((c) => c.id === CID);
async function open(viewport, extra = {}) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport, ...extra });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [], puts = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (r.method() === 'PUT' && r.url().endsWith(`/api/convos/${CID}/fallbacks`)) puts.push(JSON.parse(r.postData()).fallbacks.map((f) => f.model)); });
  await page.goto(`${base}/#${CID}`);
  return { ctx, page, errors, puts };
}
const pillLabel = (page) => page.locator('#modelChip').getAttribute('aria-label');
const waitLabel = (page, want) => page.waitForFunction((w) => document.querySelector('#modelChip')?.getAttribute('aria-label') === w, want);
async function lastPut(puts, want, what) {
  for (let i = 0; i < 50 && JSON.stringify(puts.at(-1)) !== JSON.stringify(want); i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(puts.at(-1), want, what);
}

test('the pill reads "primary → first fallback +N", picks the primary in the same sheet, and its fallback edits PUT the list', { skip, timeout: 90000 }, async () => {
  const { ctx, page, errors, puts } = await open({ width: 1280, height: 860 });
  await waitLabel(page, 'Model GPT-5.5, then GPT-6-Sol, then GPT-6-Astra, then GPT-6-Nova');
  const pill = page.locator('#modelChip');
  assert.equal(await page.locator('#modelLabel').textContent(), 'GPT-5.5');
  assert.equal(await page.locator('#modelFb').textContent(), '→GPT-6-Sol+2');
  assert.equal(await pill.getAttribute('title'), 'Model GPT-5.5, then GPT-6-Sol, then GPT-6-Astra, then GPT-6-Nova');
  // The old Fallbacks button is gone: the pill is the only model/fallback control in the composer.
  assert.equal(await page.locator('#fbChip').count(), 0);
  assert.equal(await page.locator('#composer button', { hasText: /fallbacks/i }).count(), 0);
  assert.equal(await page.locator('#composer .fb-chip').count(), 0);

  await pill.click();
  assert.equal(await page.locator('#fbModal').isVisible(), true);
  assert.equal(await pill.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#fbModelTitle').innerText(), 'Model');
  assert.equal(await page.locator('#fbTitle').innerText(), 'If GPT-5.5 hits its limit');
  const opts = page.locator('#fbModels .cm-opt');
  assert.deepEqual(await page.locator('#fbModels .cm-opt[aria-selected="true"] .cm-l').allInnerTexts(), ['GPT-5.5']);
  assert.ok((await page.locator('#fbModels .cm-head').allInnerTexts()).some((h) => /^Codex/.test(h)), 'grouped by agent');
  // Search filters the list; choosing a model sets the primary and keeps the sheet open.
  await page.locator('#fbModelSearch').fill('lumen');
  assert.deepEqual(await opts.locator('.cm-l').allInnerTexts(), ['GPT-6-Lumen']);
  await opts.first().click();
  await waitLabel(page, 'Model GPT-6-Lumen, then GPT-6-Sol, then GPT-6-Astra, then GPT-6-Nova');
  assert.equal(await page.locator('#fbModal').isVisible(), true, 'the sheet stays open');
  assert.equal(await page.locator('#fbTitle').innerText(), 'If GPT-6-Lumen hits its limit');
  assert.equal(await page.locator('#modelLabel').textContent(), 'GPT-6-Lumen');
  for (let i = 0; i < 50 && (await convo()).model !== 'gpt-6-lumen'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await convo()).model, 'gpt-6-lumen', 'the chat saved its new model');
  assert.equal(puts.length, 0, 'picking the model does not touch the fallbacks');

  // Fallbacks in the same sheet: remove, Alt+↑, add; each change PUTs the whole list and the pill follows.
  const rows = page.locator('#fbModal .fe-list .fe-row');
  assert.deepEqual(await rows.locator('.fe-model').allInnerTexts(), ['GPT-6-Sol', 'GPT-6-Astra', 'GPT-6-Nova']);
  await rows.nth(1).locator('.fe-rm').click();
  await lastPut(puts, ['gpt-6-sol', 'gpt-6-nova'], 'remove');
  await waitLabel(page, 'Model GPT-6-Lumen, then GPT-6-Sol, then GPT-6-Nova');
  assert.equal(await page.locator('#modelFb').textContent(), '→GPT-6-Sol+1');
  await rows.nth(1).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await lastPut(puts, ['gpt-6-nova', 'gpt-6-sol'], 'Alt+↑');
  assert.equal(await page.locator('#modelFb').textContent(), '→GPT-6-Nova+1');
  await page.locator('#fbModal .fe-add-btn').click();
  await page.locator('#fbBody .fe-search').fill('gpt-6');
  assert.equal(await page.locator('#fbBody .fe-opt', { hasText: 'GPT-6-Lumen' }).isDisabled(), true, 'the primary cannot be its own fallback');
  await page.locator('#fbBody .fe-opt', { hasText: 'GPT-6-Astra' }).click();
  await lastPut(puts, ['gpt-6-nova', 'gpt-6-sol', 'gpt-6-astra'], 'add');
  // Drag the last row to the top by its handle.
  await page.waitForTimeout(300);
  const grip = await rows.nth(2).locator('.fe-grip').boundingBox(), first = await rows.nth(0).boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y - 10, { steps: 4 });
  await page.mouse.move(grip.x + grip.width / 2, first.y + 2, { steps: 8 });
  await page.mouse.up();
  await lastPut(puts, ['gpt-6-astra', 'gpt-6-nova', 'gpt-6-sol'], 'drag');
  await waitLabel(page, 'Model GPT-6-Lumen, then GPT-6-Astra, then GPT-6-Nova, then GPT-6-Sol');
  assert.deepEqual((await convo()).fallbacks.map((f) => f.model), ['gpt-6-astra', 'gpt-6-nova', 'gpt-6-sol']);

  // Esc closes it and focus goes back to the pill; so does a click outside.
  await page.locator('#fbModels .cm-opt').first().focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#fbModal').isHidden(), true);
  assert.equal(await pill.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'modelChip');
  await pill.click();
  assert.equal(await page.locator('#fbModal').isVisible(), true);
  await page.mouse.click(640, 80);
  assert.equal(await page.locator('#fbModal').isHidden(), true);
  // A task's list still opens the same sheet without the Model section.
  await page.evaluate(() => openFallbacks({ ...chatFallbacks(), models: false, url: null }, document.body));
  assert.equal(await page.locator('#fbModelSec').isHidden(), true);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('390px: the pill fits, its fallback part truncates first, and it opens a bottom sheet', { skip, timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await page.waitForFunction(() => /^Model .+, then /.test(document.querySelector('#modelChip')?.getAttribute('aria-label') || ''));
  const fit = () => page.evaluate(() => {
    const chip = document.querySelector('#modelChip').getBoundingClientRect(), prim = document.querySelector('#modelLabel'), fb = document.querySelector('#modelFb');
    const cut = (e) => e.scrollWidth > e.clientWidth + 1;
    return { page: document.documentElement.scrollWidth <= innerWidth, controls: document.querySelector('#composer .controls').scrollWidth <= document.querySelector('#composer .controls').clientWidth,
      inside: chip.left >= 0 && chip.right <= innerWidth, primCut: cut(prim), fbCut: cut(fb) || cut(fb.querySelector('.fb-name')), fbShown: fb.getBoundingClientRect().width > 0 };
  });
  const roomy = await fit();
  assert.deepEqual([roomy.page, roomy.controls, roomy.inside, roomy.primCut], [true, true, true, false]);
  // A narrow pill gives up the fallback part before the primary's name.
  await page.addStyleTag({ content: '#modelChip { max-width: 150px !important; }' });
  const tight = await fit();
  assert.deepEqual([tight.page, tight.inside, tight.primCut, tight.fbCut], [true, true, false, true]);

  await page.locator('#modelChip').tap();
  await page.waitForFunction(() => !document.querySelector('#fbModal .modal-panel').getAnimations().length); // it slides up
  const sheet = await page.evaluate(() => {
    const r = document.querySelector('#fbModal .modal-panel').getBoundingClientRect();
    return { bottom: Math.round(r.bottom), left: Math.round(r.left), width: Math.round(r.width), vh: innerHeight, vw: innerWidth,
      grip: getComputedStyle(document.querySelector('#fbModal .sheet-grip')).display, models: !document.querySelector('#fbModelSec').hidden };
  });
  assert.deepEqual(sheet, { bottom: sheet.vh, left: 0, width: sheet.vw, vh: sheet.vh, vw: sheet.vw, grip: 'block', models: true });
  // A pick keeps the bottom sheet open; a tap above it closes it.
  await page.locator('#fbModels .cm-opt').filter({ has: page.locator('.cm-l', { hasText: /^GPT-5\.5$/ }) }).tap();
  await page.waitForFunction(() => document.querySelector('#modelLabel').textContent === 'GPT-5.5');
  assert.equal(await page.locator('#fbModal').isVisible(), true);
  await page.touchscreen.tap(195, 20);
  assert.equal(await page.locator('#fbModal').isHidden(), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});
