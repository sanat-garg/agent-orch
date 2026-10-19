// The task drawer's Changes section (changesSection in app.js) in a real browser: boots server.mjs (CW_NO_ORCHESTRATOR=1,
// temp data dir) on a spare port with two done work tasks, and stubs GET /api/orch/tasks/:id/changes in the page. The
// section is collapsed and fetches nothing until opened; then a two-file diff lists each file with +/− counts under a
// total line, a file row opens its hunks with added/removed/context lines coloured and scrolling sideways (the page never
// widens, rows are 44px on a phone), a binary file says so; source 'none' says 'No changes yet'. TC_SHOTS=<dir> saves
// screenshots there. Skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'task-changes-password';
const CID = 'chat-changes';
const SHOTS = process.env.TC_SHOTS || null;
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() };
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, withDiff, empty;

const LONG = `const message = '${'a very long line that must scroll sideways, '.repeat(8)}';`;
const PATCH = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,4 +1,5 @@',
  ' import x from "x";',
  '-const old = 1;',
  '+const fresh = 2;',
  `+${LONG}`,
  ' export default x;',
  ' // end',
  'diff --git a/README.md b/README.md',
  'index 3333333..4444444 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -10,2 +10,2 @@ Setup',
  '-Run it.',
  '+Run it with npm start.',
  ' Done.',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n');
const CHANGES = { source: 'commit', commits: ['abc1234'], truncated: false, patch: PATCH, files: [
  { path: 'src/app.js', add: 2, del: 1, binary: false },
  { path: 'README.md', add: 1, del: 1, binary: false },
  { path: 'logo.png', add: 0, del: 0, binary: true },
] };

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-taskchanges-'));
  const project = path.join(dataDir, 'web');
  fs.mkdirSync(project);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Web', cwd: project, mode: 'orchestrator', agent: 'claude', model: 'opus',
    createdAt: 1, updatedAt: 1, fullAccess: true, fallbacks: [] }]));
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
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,created_at) VALUES(?,'Web','active',?,0)").run(project, CID).lastInsertRowid);
  const task = (title) => Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,created_at) VALUES(?,'work',?,'build','done',0)").run(pid, title).lastInsertRowid);
  withDiff = task('Build the app');
  empty = task('Nothing changed');
  db.close();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(id, body, { phone = false, dark = false } = {}) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: dark ? 'dark' : 'light' }
    : { viewport: { width: 1280, height: 900 }, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [], fetched = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/orch/tasks/*/changes', (route) => {
    fetched.push(Number(route.request().url().match(/tasks\/(\d+)\/changes/)[1]));
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`${base}/#${CID}`);
  await page.waitForFunction(() => typeof openTask === 'function');
  await page.evaluate((tid) => openTask(tid), id);
  await page.locator('#drBody .dr-changes').waitFor();
  return { ctx, page, errors, fetched };
}
const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `task-changes-${name}.png`) });

test('a two-file diff lists files with +/− counts and opens each file\'s coloured hunks; phones get 44px rows', { skip, timeout: 60000 }, async () => {
  for (const phone of [false, true]) {
    const { ctx, page, errors, fetched } = await open(withDiff, CHANGES, { phone });
    const sec = page.locator('#drBody .dr-changes');
    await page.waitForTimeout(300);
    assert.equal(await sec.evaluate((d) => d.open), false, 'collapsed');
    assert.deepEqual(fetched, [], 'nothing fetched until it is opened');
    await sec.locator('summary').click();
    await sec.locator('.chg-total').waitFor();
    assert.deepEqual(fetched, [withDiff]);
    assert.equal(await sec.locator('summary').innerText(), 'Changes · 3');
    assert.equal(await sec.locator('.chg-total').innerText(), '3 files, +3 −2');
    const rows = await sec.locator('.chg-row').evaluateAll((bs) => bs.map((b) => b.innerText.replace(/\s+/g, ' ').trim()));
    assert.deepEqual(rows, ['src/app.js +2 −1', 'README.md +1 −1', 'logo.png binary']);
    const colour = (sel) => sec.locator(sel).first().evaluate((n) => getComputedStyle(n).color);
    assert.notEqual(await colour('.chg-row .chg-add'), await colour('.chg-row .chg-del'));

    await sec.locator('.chg-row', { hasText: 'src/app.js' }).click();
    const diff = sec.locator('.chg-file').first().locator('.chg-diff');
    await diff.waitFor();
    const lines = await diff.locator('.chg-l').evaluateAll((ls) => ls.map((l) => [l.className.replace('chg-l ', ''), l.textContent]));
    assert.deepEqual(lines.map(([c]) => c), ['hunk', 'ctx', 'del', 'add', 'add', 'ctx', 'ctx']);
    assert.equal(lines[2][1], '-const old = 1;');
    assert.equal(lines[4][1], `+${LONG}`);
    const bg = (cls) => diff.locator(`.chg-l.${cls}`).first().evaluate((n) => getComputedStyle(n).backgroundColor);
    const [a, d, c] = [await bg('add'), await bg('del'), await bg('ctx')];
    assert.ok(a !== d && a !== c && d !== c, `add ${a}, del ${d} and context ${c} are coloured apart`);
    assert.equal(await sec.locator('.chg-diff').count(), 1, 'only the clicked file opens');
    // The long line scrolls inside the diff; the page and drawer never widen.
    assert.ok(await diff.evaluate((n) => n.scrollWidth > n.clientWidth), 'the diff scrolls sideways');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('#drBody').evaluate((b) => b.scrollWidth <= b.clientWidth), true);

    await sec.locator('.chg-row', { hasText: 'logo.png' }).click();
    assert.equal(await sec.locator('.chg-file').nth(2).locator('.chg-note').innerText(), 'Binary file');
    if (phone) {
      const h = await sec.locator('.chg-row').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect().height));
      assert.ok(h.every((x) => x >= 44), `phone rows are 44px: ${h}`);
    }
    // A live re-render keeps it open with the same file expanded, and fetches nothing new.
    await page.evaluate(() => renderDrawer(true));
    assert.equal(await page.locator('#drBody .dr-changes .chg-diff').count(), 1);
    assert.deepEqual(fetched, [withDiff]);
    await page.locator('#drBody .dr-changes .chg-diff').first().scrollIntoViewIfNeeded();
    await shot(page, phone ? 'phone' : 'desktop');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  if (SHOTS) {
    const { ctx, page } = await open(withDiff, CHANGES, { dark: true });
    await page.locator('#drBody .dr-changes summary').click();
    await page.locator('#drBody .chg-row', { hasText: 'src/app.js' }).click();
    await page.locator('#drBody .chg-diff').scrollIntoViewIfNeeded();
    await shot(page, 'dark');
    await ctx.close();
  }
});

test('source \'none\' says No changes yet', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, fetched } = await open(empty, { source: 'none', commits: [], files: [], patch: '', truncated: false });
  const sec = page.locator('#drBody .dr-changes');
  await sec.locator('summary').click();
  await page.waitForFunction(() => !/Loading/.test(document.querySelector('#drBody .dr-changes').innerText));
  assert.deepEqual(fetched, [empty]);
  assert.equal(await sec.locator('summary').innerText(), 'Changes');
  assert.match(await sec.innerText(), /No changes yet/);
  assert.equal(await sec.locator('.chg-files').count(), 0);
  await shot(page, 'none');
  assert.deepEqual(errors, []);
  await ctx.close();
});
