// Searching the Queue's Up next (app.js QS / queueFilter): boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) with
// one orchestrator project holding a running task and five queued ones (a three-deep dependency chain plus two loose
// tasks, each with declared files), then checks matching by title, #number, bare number and file path; that a matching
// dependent keeps its ancestors as context rows; the counts, Clear, Escape and the no-results card; that reordering is
// off while filtered and back once cleared; that the away digest and Running stay; that typing survives a task update
// (value, focus, caret); and the 390px layout. Skips when Chromium can't launch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrowser } from '../browser.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'queue-search-password';
const CID = 'chat-queue-search';
let browser, skip = false;
try { browser = await chromium.launch(); } catch {
  try { browser = await chromium.launch({ executablePath: findBrowser() || undefined }); } catch (e) { skip = `no Chromium: ${e.message.split('\n')[0]}`; }
}
let child, base, dataDir, cookie;
const ids = {};

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-qsearch-ui-'));
  const project = path.join(dataDir, 'no-such-project');
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Billing', cwd: project, mode: 'orchestrator', createdAt: 1, updatedAt: 1, fullAccess: true, fallbacks: [] }]));
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
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,created_at) VALUES(?,?,'active',?,0)").run(project, 'Billing', CID).lastInsertRowid);
  db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,agent,started_at,created_at) VALUES(?,'work','Running migration','seed','running','claude',?,0)")
    .run(pid, Math.floor(Date.now() / 1000) - 60);
  const add = (key, title, files, after, pos) => {
    ids[key] = Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,files,depends_on,position,created_at) VALUES(?,'work',?,'seed','queued',?,?,?,0)")
      .run(pid, title, JSON.stringify(files), after ?? null, pos).lastInsertRowid);
  };
  add('schema', 'Set up billing schema', ['db/schema.sql'], null, 1);
  add('pdf', 'Invoice PDF export', ['src/pdf/render.mjs'], ids.schema, 2);
  add('mail', 'Email receipts', ['src/mail/receipt.mjs'], ids.pdf, 3);
  add('dark', 'Dark mode for settings', ['public/App.css'], null, 4);
  add('refactor', 'Tidy helpers', ['public/app.js'], null, 5);
  db.close();
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const NOW = Date.now();
const DIGEST = { since: NOW - 3 * 3600e3, at: NOW, counts: { done: 1, failed: 0, needsYou: 0 },
  projects: [{ id: 1, name: 'Billing', done: [{ id: 900, title: 'Shipped earlier', finished_at: NOW - 60e3, result: 'ok' }], failed: [], needsYou: [] }] };

// A phone-sized signed-in page with the Queue open, away long enough for the digest card (stubbed).
async function open() {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript((t) => localStorage.setItem('cw.digestSeen', String(t)), NOW - 3 * 3600e3);
  const page = await ctx.newPage();
  await page.route('**/api/orch/digest*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(DIGEST) }));
  await page.goto(`${base}/#${CID}`);
  await page.locator('#obQueue').click();
  await page.locator('#qList .tcard').nth(4).waitFor();
  await page.locator('#qBody > .sy').waitFor();
  return { ctx, page };
}
const shown = (page) => page.locator('#qList .tcard').evaluateAll((cs) => cs.map((c) => Number(c.dataset.task)));
const search = (page) => page.getByRole('searchbox', { name: 'Search queued tasks' });
const count = (page) => page.locator('#qBody .q-search-count').innerText();

test('matches titles, #numbers, bare numbers and files; dependents keep context; counts; reordering off until cleared', { skip, timeout: 60000 }, async () => {
  const { ctx, page } = await open();
  assert.equal(await page.locator('#qList .q-card').count(), 5, 'reorderable before searching');
  assert.equal(await page.locator('#qBody .q-search-clear').isVisible(), false, 'no Clear while empty');

  await search(page).fill('pdf');
  assert.deepEqual(await shown(page), [ids.schema, ids.pdf], 'the match plus its queued prerequisite');
  assert.equal(await count(page), '1 of 5');
  const ctxCard = page.locator(`#qList .tcard[data-task="${ids.schema}"]`);
  assert.equal(await ctxCard.evaluate((c) => c.classList.contains('q-context')), true, 'the ancestor is marked context-only');
  assert.match(await ctxCard.locator('.q-ctx').innerText(), /context/i);
  assert.equal(await page.locator(`#qList .tcard[data-task="${ids.pdf}"]`).evaluate((c) => c.classList.contains('q-context')), false);
  assert.equal(await page.locator('#qList .q-card').count(), 0, 'no drag handles while filtered');
  assert.match(await page.locator('#qBody .q-search-note').innerText(), /Reordering is off/);

  await search(page).fill('RECEIPT.MJS');
  assert.deepEqual(await shown(page), [ids.schema, ids.pdf, ids.mail], 'a deep dependent keeps the whole chain');
  assert.deepEqual(await page.locator('#qList .q-context').evaluateAll((cs) => cs.map((c) => Number(c.dataset.task))), [ids.schema, ids.pdf]);
  assert.equal(await count(page), '1 of 5');

  await search(page).fill(`#${ids.dark}`);
  assert.deepEqual(await shown(page), [ids.dark]);
  await search(page).fill(String(ids.refactor));
  assert.deepEqual(await shown(page), [ids.refactor], 'a bare number matches the task number');
  await search(page).fill('app.css');
  assert.deepEqual(await shown(page), [ids.dark], 'file paths match case-insensitively');
  await search(page).fill('public');
  assert.deepEqual(await shown(page), [ids.dark, ids.refactor]);
  assert.equal(await count(page), '2 of 5');
  await search(page).fill('billing SCHEMA');
  assert.deepEqual(await shown(page), [ids.schema], 'every term must match');
  assert.equal(await page.locator('#qList .q-context').count(), 0, 'a matching root is not context');

  // The away digest and Running stay while filtering.
  assert.equal(await page.locator('#qBody').evaluate((b) => b.firstElementChild.classList.contains('sy')), true);
  assert.equal(await page.locator('#qBody .tcard', { hasText: 'Running migration' }).count(), 1);

  await page.locator('#qBody .q-search-clear').click();
  assert.equal(await search(page).inputValue(), '');
  assert.equal(await page.evaluate(() => document.activeElement === QS.input), true, 'Clear keeps focus in the field');
  assert.deepEqual(await shown(page), [ids.schema, ids.pdf, ids.mail, ids.dark, ids.refactor]);
  assert.equal(await page.locator('#qList .q-card').count(), 5, 'reordering is back');
  assert.equal(await page.locator('#qBody .q-search-note').count(), 0);
  assert.equal(await count(page), '');

  await search(page).fill('pdf');
  await search(page).press('Escape');
  assert.equal(await search(page).inputValue(), '', 'Escape empties the search first');
  assert.equal(await page.evaluate(() => document.getElementById('queueModal').hidden), false, '…without closing the Queue');
  await ctx.close();
});

test('no matches: a status card says so and Clear search restores the list', { skip, timeout: 60000 }, async () => {
  const { ctx, page } = await open();
  await search(page).fill('zebra');
  const none = page.locator('#qBody .q-none');
  assert.match(await none.locator('.q-none-h').innerText(), /No queued task matches “zebra”/);
  assert.match(await none.locator('.q-none-tip').innerText(), /#42/);
  assert.equal(await page.locator('#qList .tcard').count(), 0);
  assert.equal(await count(page), '0 of 5');
  await none.getByRole('button', { name: 'Clear search' }).click();
  assert.equal(await page.locator('#qBody .q-none').count(), 0);
  assert.equal(await page.locator('#qList .tcard').count(), 5);
  assert.equal(await page.evaluate(() => document.activeElement === QS.input), true);
  await ctx.close();
});

test('typing through a task update keeps the value, focus and caret; 390px layout', { skip, timeout: 60000 }, async () => {
  const { ctx, page } = await open();
  const box = search(page);
  await box.click();
  await page.keyboard.type('Inv');
  await page.evaluate(() => QS.input.setSelectionRange(1, 1));
  await page.evaluate((id) => onOrch({ t: 'otask', task: { ...O.tasks.get(id), title: 'Invoice PDF export v2' } }), ids.pdf);
  await page.locator('#qList .tcard', { hasText: 'Invoice PDF export v2' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement === QS.input), true, 'focus survives the re-render');
  assert.deepEqual(await page.evaluate(() => [QS.input.value, QS.input.selectionStart, QS.input.selectionEnd]), ['Inv', 1, 1], 'value and caret survive');
  await page.keyboard.press('End');
  await page.keyboard.type('oice v2');
  assert.equal(await box.inputValue(), 'Invoice v2');
  assert.deepEqual(await shown(page), [ids.schema, ids.pdf]);

  const vw = 390;
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll at 390px');
  for (const sel of ['.q-search-input', '.q-search-count', '.q-search-clear']) {
    const r = await page.locator(`#qBody ${sel}`).boundingBox();
    assert.ok(r && r.x >= 0 && r.x + r.width <= vw, `${sel} fits inside 390px`);
  }
  const input = await page.locator('#qBody .q-search-input').boundingBox(), clear = await page.locator('#qBody .q-search-clear').boundingBox();
  assert.ok(input.height >= 44 && clear.height >= 44, '44pt targets on a phone');
  assert.ok(Math.abs((input.y + input.height / 2) - (clear.y + clear.height / 2)) < 2, 'field, count and Clear share one row');
  assert.ok(input.width >= 200, 'the field keeps most of the row');
  for (const c of await page.locator('#qList .tcard').all()) {
    const r = await c.boundingBox();
    assert.ok(r.x + r.width <= vw, 'cards fit inside 390px');
  }
  if (process.env.CW_QSEARCH_SHOTS) await page.screenshot({ path: path.join(process.env.CW_QSEARCH_SHOTS, 'queue-search-mobile.png') });
  await ctx.close();
});
