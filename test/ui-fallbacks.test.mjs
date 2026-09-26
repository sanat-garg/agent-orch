// The fallback sheet in a real browser: boots server.mjs (stub codex/agy CLIs, CW_NO_ORCHESTRATOR=1, temp data dir) on a
// spare port. Chat: the composer's Fallbacks button opens it, and remove, undo, reorder (Alt+↑ and drag) and add each
// persist through PUT /api/convos/:id/fallbacks. Reflection: the settings popover opens the same sheet at once, without
// any request, and saves via PUT /api/orch/projects/:id/reflect-fallbacks. Skips when Playwright's Chromium can't launch.
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
let child, base, dataDir, home, cookie, db, pid;
const PROJECT = () => path.join(dataDir, 'no-such-project');

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
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Fallbacks', cwd: PROJECT(), mode: 'orchestrator',
    agent: 'codex', model: 'gpt-5.5', createdAt: 1, updatedAt: 1, fullAccess: true, fallbacks: START }]));
  const bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/codex-stub.mjs'), path.join(bin, 'codex'));
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/agy-stub.mjs'), path.join(bin, 'agy'));
  const port = await freePort();
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  const PATH = isolatedPath(bin);
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
  // The chat's project (reflection fallbacks live on it) and a codex usage limit (the limited dot).
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  pid = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,reflect_fallbacks,created_at) VALUES(?,?,'paused',?,?,0)")
    .run(PROJECT(), 'fb', CID, JSON.stringify([{ agent: 'antigravity', model: 'gemini-3.1-pro-high' }])).lastInsertRowid);
  db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)').run('blocked_until:codex', String(Math.floor(Date.now() / 1000) + 3600));
});

after(async () => {
  db?.close();
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

test('chat fallbacks: the picker has no Auto Delegate; the sheet removes, undoes, reorders and adds via PUT /api/convos/:id/fallbacks', { skip, timeout: 90000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name, value, url: base }]);
  // A chat that had the old Auto Delegate flag: the flag is dropped (its list was already set, so it stays).
  await ctx.addInitScript((cid) => { if (!sessionStorage.seeded) { localStorage.setItem(`cw.auto.${cid}`, '1'); sessionStorage.seeded = 1; } }, CID);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${CID}`);
  const chip = page.locator('#fbChip');
  await page.waitForFunction(() => document.querySelector('#fbChip')?.textContent === 'Fallbacks · 3');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#model option')].some((o) => /auto/i.test(o.value + o.textContent))), false);
  assert.equal(await page.evaluate((cid) => localStorage.getItem(`cw.auto.${cid}`), CID), null);
  await chip.click();
  assert.equal(await page.locator('#fbTitle').innerText(), 'If GPT-5.5 hits its limit');
  const rows = page.locator('#fbModal .fe-list .fe-row');
  const names = () => rows.locator('.fe-model').allInnerTexts();
  await assert.doesNotReject(rows.nth(2).waitFor());
  assert.deepEqual(await names(), ['GPT-6-Sol', 'Gemini 3.1 Pro (High)', 'Claude Sonnet 4.6 (Thinking)']);
  assert.deepEqual(await rows.locator('.fe-pos').allInnerTexts(), ['1', '2', '3']);
  assert.deepEqual(await rows.locator('.fe-agent').allInnerTexts(), ['Codex', 'Antigravity', 'Antigravity']);
  // Only codex is limited: one small dot, nothing else about usage.
  assert.deepEqual(await rows.evaluateAll((els) => els.map((e) => !!e.querySelector('.fe-lim'))), [true, false, false]);
  assert.equal(await page.locator('#fbModal .fe-reset').count(), 0);

  // Remove the second model: saved at once, the composer button follows.
  await rows.nth(1).locator('.fe-rm').click();
  await until(['gpt-6-sol', 'claude-sonnet-4-6'], 'remove persisted');
  assert.deepEqual(await names(), ['GPT-6-Sol', 'Claude Sonnet 4.6 (Thinking)']);
  assert.equal(await chip.innerText(), 'Fallbacks · 2');
  // Undo from the toast puts it back in place.
  await page.locator('#toasts .toast-act').click();
  await until(['gpt-6-sol', 'gemini-3.1-pro-high', 'claude-sonnet-4-6'], 'undo persisted');
  await rows.nth(1).locator('.fe-rm').click();
  await until(['gpt-6-sol', 'claude-sonnet-4-6'], 'remove persisted again');

  // Move the (now) second model up with Alt+↑ on the focused row; focus stays on it.
  await rows.nth(1).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await until(['claude-sonnet-4-6', 'gpt-6-sol'], 'Alt+↑ persisted');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.key), 'antigravity/claude-sonnet-4-6');

  // Drag the second row above the first by its handle (pointer events, mouse).
  await page.waitForFunction(() => document.querySelector('#fbModal .fe-list .fe-row')?.dataset.key === 'antigravity/claude-sonnet-4-6');
  await page.waitForTimeout(300);
  const grip = await rows.nth(1).locator('.fe-grip').boundingBox(), first = await rows.nth(0).boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y - 10, { steps: 4 });
  await page.mouse.move(grip.x + grip.width / 2, first.y + 4, { steps: 6 });
  await page.mouse.up();
  await until(['gpt-6-sol', 'claude-sonnet-4-6'], 'drag persisted');

  // Add from the searchable picker; the primary model can't be added.
  await page.locator('#fbModal .fe-add-btn').click();
  await page.locator('#fbModal .fe-search').fill('gpt-5.5');
  assert.equal(await page.locator('#fbModal .fe-opt', { hasText: 'GPT-5.5' }).first().isDisabled(), true);
  await page.locator('#fbModal .fe-search').fill('flash');
  await page.locator('#fbModal .fe-opt', { hasText: 'Gemini 3.8 Flash' }).click();
  await until(['gpt-6-sol', 'claude-sonnet-4-6', 'gemini-3.8-flash-high'], 'add persisted');
  // Removing every model leaves an empty list: tasks wait.
  for (let i = 0; i < 3; i++) await rows.nth(0).locator('.fe-rm').click();
  await until([], 'empty list persisted');
  await page.locator('#fbModal .fe-hint', { hasText: 'No fallbacks' }).waitFor();
  assert.equal(await chip.innerText(), 'No fallbacks');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('reflection fallbacks: the settings popover opens the same sheet instantly, without any request, and saves', { skip, timeout: 90000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${CID}`);
  await page.waitForFunction(() => document.querySelector('#obReflectBtn')?.textContent === 'Fallbacks · 1');
  await page.waitForLoadState('networkidle');
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.locator('#obSettingsBtn').click();
  // Rendered in the same task as the click: no fetch, no loading state.
  const shown = await page.evaluate(() => {
    document.querySelector('#obReflectBtn').click();
    return { open: !document.querySelector('#fbModal').hidden, title: document.querySelector('#fbTitle').textContent,
      rows: [...document.querySelectorAll('#fbModal .fe-row .fe-model')].map((e) => e.textContent) };
  });
  assert.equal(shown.open, true);
  assert.match(shown.title, /^If .+ hits its limit$/);
  assert.deepEqual(shown.rows, ['Gemini 3.1 Pro (High)']);
  await page.waitForTimeout(300);
  assert.deepEqual(requests, [], 'opening the reflection sheet fetches nothing');

  await page.locator('#fbModal .fe-add-btn').click();
  await page.locator('#fbModal .fe-search').fill('sol');
  await page.locator('#fbModal .fe-opt', { hasText: 'GPT-6-Sol' }).click();
  const stored = () => db.prepare('SELECT reflect_fallbacks FROM projects WHERE id=?').get(pid).reflect_fallbacks;
  for (let i = 0; i < 50 && JSON.parse(stored()).length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(JSON.parse(stored()), [{ agent: 'antigravity', model: 'gemini-3.1-pro-high' }, { agent: 'codex', model: 'gpt-6-sol' }]);
  assert.ok(requests.some((u) => u.endsWith(`/api/orch/projects/${pid}/reflect-fallbacks`)));
  assert.equal(await page.locator('#obReflectBtn').innerText(), 'Fallbacks · 2');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('task drawer edits its own fallback snapshot', { skip, timeout: 60000 }, async () => {
  const resetChat = await fetch(base + '/api/convos/' + CID + '/fallbacks', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ fallbacks: START }) });
  assert.equal(resetChat.status, 200); await resetChat.json();
  const id = Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,agent,model,fallbacks,created_at) VALUES(?,'Task fallback editing','code','codex','gpt-5.5',?,0)").run(pid, JSON.stringify(START)).lastInsertRowid);
  if (process.env.TASK_FB_SHOT) {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)(process.execPath, ['/home/ubuntu/agent-orch/bin/shot.mjs', base + '/#' + CID,
      '.agent-orch/shots/task-fallbacks-' + process.env.TASK_FB_SHOT + '.png', '--cookie=' + cookie, '--click=#obQueue', '--click=[data-task="' + id + '"]', '--wait=500']);
    console.log(stdout);
    if (process.env.TASK_FB_SHOT === 'before') return;
  }
  const ctx = await browser.newContext();
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  await page.goto(base + '/#' + CID);
  await page.locator('#obQueue').click();
  await page.locator('[data-task="' + id + '"]').first().click();
  const section = page.locator('#drBody .dr-sec').filter({ has: page.locator('h3', { hasText: /^Fallbacks$/ }) });
  await section.waitFor();
  assert.equal(await section.locator('.fe-row').count(), 3);
  await section.locator('.fe-row').nth(1).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await page.waitForFunction(async (id) => (await (await fetch('/api/orch/task/' + id)).json()).task.fallbacks[0].model === 'gemini-3.1-pro-high', id);
  assert.match(await page.locator('#drBody .tc-tag.model').innerText(), /Gemini/);
  await section.locator('.fe-rm').first().click();
  await section.getByText('Custom', { exact: true }).waitFor();
  await page.waitForFunction(async (id) => (await (await fetch('/api/orch/task/' + id)).json()).task.fallbacks.length === 2, id);
  await section.getByRole('button', { name: "Reset to chat's list" }).click();
  await page.waitForFunction(async (id) => (await (await fetch('/api/orch/task/' + id)).json()).task.fallbacks.length === 3, id);
  assert.deepEqual(await saved(), START);
  db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(id);
  await page.reload();
  await page.locator('#obQueue').click();
  await page.locator('[data-task="' + id + '"]').first().click();
  await section.getByText('Changes apply from the next resume or limit event.').waitFor();
  db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(id);
  await page.reload();
  await page.locator('#obQueue').waitFor();
  await page.evaluate((id) => openTask(id), id);
  await page.locator('#drBody h3', { hasText: 'Model' }).waitFor();
  assert.equal(await section.count(), 0);
  await ctx.close();
});
