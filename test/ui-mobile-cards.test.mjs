// Chat task cards on phones (UI-REVIEW #3): boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir), seeds a delegated
// task with a 90-character title (plus one with a 55-character title) and a chat log that shows their cards, then opens
// the chat at 390×844. Titles wrap to two lines (the 90-character one needs three at this width, so it is clamped to two),
// the tags sit on their own row under the title and the model chip uses the short 'X · moved' form. At desktop width the
// card keeps one row and the full 'moved from …' text. Skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'cards-ui-password';
const CID = 'chat-cards';
const TITLE = 'Write end-to-end tests for the shipping address form, including validation and error state';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
const SHORT = 'Write end-to-end tests for the shipping address form UI';
let child, base, dataDir, cookie, taskId, shortId;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  assert.equal(TITLE.length, 90);
  assert.equal(SHORT.length, 55);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cardsui-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const cwd = path.join(dataDir, 'p', 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Cards', cwd, mode: 'orchestrator',
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
  // A finished task that moved from Opus to Codex at a limit, and the chat event that shows its card.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,created_at) VALUES(?,?,'active',?,0)").run(cwd, 'Cards', CID).lastInsertRowid);
  const moves = JSON.stringify([{ at: 1, from: { agent: 'claude', model: 'opus' }, to: { agent: 'codex', model: 'gpt-5.5' }, until: 2000000000, by: 'limit' }]);
  const add = (title) => Number(db.prepare(`INSERT INTO tasks(project_id,kind,title,prompt,status,agent,model,ran_agent,ran_model,delegated_from,moves,finished_at,created_at)
    VALUES(?,'work',?,'seed','done','codex','gpt-5.5','codex','gpt-5.5','claude/opus',?,1,0)`).run(pid, title, moves).lastInsertRowid);
  taskId = add(TITLE);
  shortId = add(SHORT);
  db.close();
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'logs', `${CID}.jsonl`), [
    { t: 'user', text: 'Add e2e tests', ts: 1 },
    { t: 'tasks', ids: [taskId, shortId], source: 'planner', ts: 2 },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(viewport, mobile) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${CID}`);
  await page.locator(`.task-cards .tcard[data-task="${taskId}"] .tc-tag.model`).waitFor();
  return { ctx, page, errors };
}

const measure = (page, id) => page.evaluate((id) => {
  const card = document.querySelector(`.task-cards .tcard[data-task="${id}"]`);
  const q = (s) => card.querySelector(s);
  const title = q('.tc-title'), r = (e) => e.getBoundingClientRect();
  return { text: title.textContent, scrollH: title.scrollHeight, clientH: title.clientHeight, lineH: parseFloat(getComputedStyle(title).lineHeight),
    titleBottom: r(title).bottom, main: r(q('.tc-main')), tags: r(q('.tc-tags')), chev: r(q('.chev')), glyph: r(q('.tc-glyph')), card: r(card),
    chip: q('.tc-tag.model').textContent, chipTip: q('.tc-tag.model').title, chipClipped: q('.tc-tag.model').scrollWidth > q('.tc-tag.model').clientWidth };
}, id);

test('390×844: a long title wraps to two lines and the model chip gets its own row in the short form', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844 }, true);
  const m = await measure(page, taskId);
  assert.equal(m.text, TITLE);
  assert.ok(m.clientH > 1.5 * m.lineH && m.clientH < 2.5 * m.lineH, `title clamped to two lines (height ${m.clientH}, line-height ${m.lineH})`);
  const s = await measure(page, shortId);
  assert.equal(s.text, SHORT);
  assert.ok(s.scrollH <= s.clientH, `title fits its box (scrollHeight ${s.scrollH} > clientHeight ${s.clientH})`);
  assert.ok(s.clientH > 1.5 * s.lineH, `title spans two lines (height ${s.clientH}, line-height ${s.lineH})`);
  assert.ok(s.tags.top >= s.titleBottom, 'tags sit below the wrapped title');
  assert.ok(m.tags.top >= m.titleBottom, `tags (top ${m.tags.top}) sit below the title (bottom ${m.titleBottom})`);
  assert.ok(m.tags.top >= m.main.bottom, 'tags sit below .tc-main');
  assert.ok(Math.abs(m.tags.left - m.main.left) < 1, 'tags line up with the title');
  assert.ok(m.chev.top < m.tags.top && m.chev.right > m.main.right, 'chevron stays on the title row, at the right');
  assert.ok(m.card.right <= 390, 'card fits the screen');
  assert.match(m.chip, /^\S.* · moved$/);
  assert.doesNotMatch(m.chip, /from/);
  assert.equal(m.chipClipped, false, `chip not truncated: ${m.chip}`);
  assert.match(m.chipTip, /moved from/, 'full text stays in the tooltip');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('1280×800: desktop keeps one row and the full chip text', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 1280, height: 800 }, false);
  const m = await measure(page, taskId);
  assert.ok(m.clientH < 1.5 * m.lineH, 'title stays on one line');
  assert.ok(Math.abs((m.tags.top + m.tags.bottom) / 2 - (m.main.top + m.main.bottom) / 2) < 2, 'tags beside the title');
  assert.match(m.chip, / · moved from /);
  await ctx.close();
  assert.deepEqual(errors, []);
});
