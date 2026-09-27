// The Effort control in a real browser: boots server.mjs (stub codex CLI, CW_NO_ORCHESTRATOR=1, temp data dir) on a spare
// port. The composer's pill shows only for Claude/Codex, opens a popover with a discrete slider (arrow keys save at once
// via PUT /api/convos/:id/effort, with a toast), Esc closes it, Default resets, switching agents clamps, it collapses to the
// level word at 390px, and the task drawer shows where a task's effort comes from, overrides it, and each run's level.
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
import { isolatedPath } from './helpers/isolated-path.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'effort-ui-password';
const CLAUDE_CHAT = 'chat-claude', CODEX_CHAT = 'chat-codex';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, home, cookie, db, taskId;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const convo = (id) => JSON.parse(fs.readFileSync(path.join(dataDir, 'convos.json'), 'utf8')).find((c) => c.id === id);

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-effui-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-effui-home-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const chat = (id, agent, model, effort) => ({ id, title: id, cwd: path.join(dataDir, id), mode: 'orchestrator', agent, model, effort, createdAt: 1, updatedAt: 1, fullAccess: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([chat(CLAUDE_CHAT, 'claude', '', 'high'), chat(CODEX_CHAT, 'codex', 'gpt-6-sol', 'ultra')]));
  const bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/codex-stub.mjs'), path.join(bin, 'codex'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH: isolatedPath(bin), AA_API_KEY: '', CW_AA_BASE: 'http://127.0.0.1:9',
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
  for (let i = 0; ; i++) {
    const a = await (await fetch(base + '/api/agents', { headers: { cookie } })).json();
    if (a.agents.find((x) => x.id === 'codex')?.models.length) break;
    if (i > 100) assert.fail('model discovery never finished');
    await new Promise((res) => setTimeout(res, 200));
  }
  // A queued Claude task in the Claude chat's project, with two runs that used different levels.
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,created_at) VALUES(?,?,'paused',?,0)").run(path.join(dataDir, CLAUDE_CHAT), 'p', CLAUDE_CHAT).lastInsertRowid);
  taskId = Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,status,created_at) VALUES(?,?,?,'queued',1)").run(pid, 'Refactor the parser', 'Refactor it').lastInsertRowid);
  for (const [effort, outcome] of [['low', 'aborted'], ['high', 'rate_limited']]) {
    db.prepare("INSERT INTO runs(task_id,purpose,agent,effort,outcome,started_at,finished_at) VALUES(?,'work','claude',?,?,1,2)").run(taskId, effort, outcome);
  }
});

after(async () => {
  db?.close();
  await browser?.close();
  child?.kill('SIGKILL');
  for (const d of [dataDir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

async function page(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.errors = errors;
  return p;
}

test('the pill opens a slider; arrow keys save at once with a toast; Esc closes; Default resets', { skip, timeout: 60000 }, async () => {
  const p = await page();
  await p.goto(`${base}/#${CLAUDE_CHAT}`);
  const chip = p.locator('#effChip');
  await chip.waitFor();
  assert.equal((await chip.textContent()).trim(), 'Effort: high');
  await chip.click();
  await p.locator('#effModal').waitFor();
  assert.equal(await p.evaluate(() => document.activeElement.id), 'effRange');
  assert.deepEqual(await p.locator('#effTicks .eff-tick').allTextContents(), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(await p.locator('#effTicks .eff-tick.on').textContent(), 'high');
  await p.keyboard.press('ArrowRight');
  await p.waitForFunction(() => /Effort set to xhigh\. Queued tasks use it when they start; running tasks switch at their next session\./.test(document.querySelector('#toasts').textContent));
  assert.equal(convo(CLAUDE_CHAT).effort, 'xhigh');
  assert.equal(await p.locator('#effLevel').textContent(), 'xhigh');
  assert.match(await p.locator('#effHint').textContent(), /Deeper reasoning/);
  await p.keyboard.press('Escape');
  await p.locator('#effModal').waitFor({ state: 'hidden' });
  assert.equal(await p.evaluate(() => document.activeElement.id), 'effChip');
  assert.equal((await chip.textContent()).trim(), 'Effort: xhigh');
  await chip.click();
  await p.locator('#effDefault').click();
  await p.waitForFunction(() => /Effort set to the model default/.test(document.querySelector('#toasts').textContent));
  assert.equal(convo(CLAUDE_CHAT).effort, null);
  assert.equal(await p.locator('#effLevel').textContent(), 'Default');
  assert.equal(await p.locator('#effTag').textContent(), 'runs as high');
  assert.equal(await p.locator('#effDefault').getAttribute('aria-pressed'), 'true');
  await p.locator('#effTicks .eff-tick', { hasText: 'medium' }).click();
  await p.waitForFunction(() => /Effort set to medium/.test(document.querySelector('#toasts').textContent));
  assert.equal(convo(CLAUDE_CHAT).effort, 'medium');
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

test('switching Codex → Claude clamps ultra to max; the pill hides for an agent without levels', { skip, timeout: 60000 }, async () => {
  const p = await page();
  await p.goto(`${base}/#${CODEX_CHAT}`);
  await p.locator('#effChip').waitFor();
  assert.equal((await p.locator('#effChip').textContent()).trim(), 'Effort: ultra');
  await p.locator('#model').selectOption('claude|');
  await p.waitForFunction(() => document.querySelector('#effChip').textContent.trim() === 'Effort: max');
  for (let i = 0; i < 50 && convo(CODEX_CHAT).effort !== 'max'; i++) await p.waitForTimeout(100);
  assert.equal(convo(CODEX_CHAT).effort, 'max', 'the server clamped the saved chat on set_model');
  // An agent that declares no levels (none ship today; simulated in the page): no pill.
  await p.evaluate(() => { AGENT_LIST.find((a) => a.id === 'claude').efforts = []; renderEff(); });
  assert.equal(await p.locator('#effChip').isHidden(), true);
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

test('390px: the pill collapses to the level word and the popover is a bottom sheet', { skip, timeout: 60000 }, async () => {
  const p = await page({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await p.goto(`${base}/#${CLAUDE_CHAT}`);
  const chip = p.locator('#effChip');
  await chip.waitFor();
  assert.equal((await chip.innerText()).trim(), 'medium');
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal scroll');
  const box = await chip.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  await chip.tap();
  const panel = p.locator('#effModal .modal-panel');
  await panel.waitFor();
  await p.waitForTimeout(300); // the sheet's slide-up
  const pb = await panel.boundingBox();
  assert.ok(Math.abs(pb.y + pb.height - 844) <= 2 && pb.width >= 388, `a bottom sheet: ${JSON.stringify(pb)}`);
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

test('the task drawer shows where its effort comes from, overrides it, and lists each run\'s level', { skip, timeout: 60000 }, async () => {
  const p = await page();
  await p.goto(`${base}/#${CLAUDE_CHAT}`);
  await p.locator('#effChip').waitFor();
  await p.evaluate((id) => openTask(id), taskId);
  const row = p.locator('#drBody .dr-effort');
  await row.waitFor();
  const chatLevel = convo(CLAUDE_CHAT).effort;
  assert.match(await row.textContent(), new RegExp(`Effort: ${chatLevel} \\(from chat\\)`));
  assert.match(await row.textContent(), /Runs used: low → high/);
  assert.match(await p.locator('#drBody .out-run').first().textContent(), /effort low/);
  await row.locator('select').selectOption('max');
  await p.waitForFunction(() => /Effort: max \(this task\)/.test(document.querySelector('#drBody .dr-effort')?.textContent || ''));
  assert.equal(db.prepare('SELECT effort FROM tasks WHERE id=?').get(taskId).effort, 'max');
  await p.locator('#drBody .dr-effort select').selectOption('');
  await p.waitForFunction(() => /\(from chat\)/.test(document.querySelector('#drBody .dr-effort')?.textContent || ''));
  assert.equal(db.prepare('SELECT effort FROM tasks WHERE id=?').get(taskId).effort, null);
  assert.deepEqual(p.errors, []);
  await p.context().close();
});
