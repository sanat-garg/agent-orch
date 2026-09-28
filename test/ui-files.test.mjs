// Files view (files.js) in a real browser against server.mjs (temporary HOME, data and port; no orchestrator):
// - Changed: lists a modified and an untracked file of a temporary git project with +/− counts, Space opens Quick Look on
//   the coloured diff, the view persists, and on a phone the list fits 375px with 44px rows.
// - Ask in chat from Quick Look and from a Contents hit puts the file's `path[:line]` into the composer and returns to the chat.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'files-ui-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, root, home, dataDir, proj, cookie;

before(async () => {
  if (skip) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-filesui-'));
  home = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  proj = path.join(root, 'proj');
  for (const d of [home, dataDir, path.join(proj, 'src'), path.join(root, 'plain/src')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'plain/src/app.js'), 'const a = 1;\nfunction needle() {}\n');
  const git = (...args) => execFileSync('git', args, { cwd: proj, env: { ...process.env, HOME: home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(proj, 'src/app.js'), 'one\ntwo\nthree\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(proj, 'src/app.js'), 'one\n<b>two</b>\nthree\nfour\n'); // +2 −1
  fs.writeFileSync(path.join(proj, 'notes.md'), 'a\nb\nc\n'); // untracked, 3 lines
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([
    { id: 'c0', title: 'Demo', cwd: proj, mode: 'default', model: '', createdAt: 1, updatedAt: 1 },
    { id: 'c1', title: 'Plain', cwd: path.join(root, 'plain'), mode: 'default', model: '', createdAt: 1, updatedAt: 1 },
  ]));
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
});
after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function open(viewport, mobile = false, cid = 'c0') {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript(() => localStorage.setItem('cw.lastSeen', String(Date.now())));
  const page = await ctx.newPage();
  const errors = [], dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.goto(`${base}/#${cid}`);
  await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
  return { page, errors, dialogs, ctx };
}
async function filesView(page) {
  await page.evaluate(() => setView('files'));
  await page.locator('#fxMain').waitFor();
}
const rowText = (page) => page.$$eval('.fx-changed .fx-row', (rows) => rows.map((r) => r.textContent));

async function openFiles(page) {
  await page.click('.seg button[data-view="files"]');
  await page.locator('#fxMain [role="listbox"], #fxMain [role="tree"]').waitFor();
}

test('Changed lists a modified and an untracked file with counts; Space shows the coloured diff', { skip, timeout: 90000 }, async () => {
  const { page, errors, ctx } = await open({ width: 1280, height: 860 });
  await filesView(page);
  await page.click('[data-fxview="changed"]');
  await page.locator('.fx-changed .fx-row >> nth=1').waitFor();
  assert.deepEqual(await rowText(page), ['?notes.md+3−0', 'Msrc/app.js+2−1']);
  assert.equal(await page.textContent('.fx-changed .fx-row >> nth=1 >> .fx-dir'), 'src/', 'the folder part is its own (dimmed) span');
  assert.equal(await page.getAttribute('[data-fxview="changed"]', 'aria-checked'), 'true');
  assert.equal(await page.evaluate(() => localStorage.getItem('cw.files.view')), 'changed');
  assert.match(await page.textContent('#fxPath'), /Changes on main\s*2 files · \+5 −1\s*Refresh/);

  await page.click('.fx-changed .fx-row >> nth=1');
  await page.keyboard.press(' ');
  await page.locator('#fxQL:not([hidden]) .fx-dl.add').first().waitFor();
  assert.deepEqual(await page.$$eval('#fxQLBody .fx-dl.add', (ls) => ls.map((l) => l.textContent.trim())), ['+<b>two</b>', '+four']);
  assert.deepEqual(await page.$$eval('#fxQLBody .fx-dl.del', (ls) => ls.map((l) => l.textContent.trim())), ['-two']);
  assert.equal(await page.locator('#fxQLBody b').count(), 0, 'diff text is escaped');
  assert.equal(await page.locator('#fxQLBody .fx-dl.hunk').count(), 1);
  assert.equal(await page.textContent('#fxQLSub'), 'Modified · +2 −1');
  assert.match(await page.getAttribute('#fxQLFile', 'href'), /\/api\/files\/raw\?.*path=src%2Fapp\.js/);
  assert.equal(await page.locator('#fxQLFile').isVisible(), true);
  await page.click('#fxQLMode [data-mode="source"]');
  await page.locator('#fxQLBody pre.fx-text').waitFor();
  assert.match(await page.textContent('#fxQLBody pre.fx-text'), /^diff --git/);
  await page.click('#fxQLMode [data-mode="preview"]');
  await page.locator('#fxQLBody .fx-dl').first().waitFor();
  await page.keyboard.press('ArrowLeft'); // Quick Look follows the selection to the untracked file
  await page.waitForFunction(() => document.getElementById('fxQLTitle').textContent === 'notes.md');
  await page.locator('#fxQLBody .fx-dl.add >> nth=2').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#fxQL').isHidden(), true);

  // a clean tree shows the empty state; the view is remembered on reload
  fs.rmSync(path.join(proj, 'notes.md'));
  execFileSync('git', ['checkout', '-q', '--', '.'], { cwd: proj });
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
  await page.evaluate(() => setView('files'));
  await page.locator('.fx-empty strong >> text=No uncommitted changes').waitFor();
  fs.writeFileSync(path.join(proj, 'src/app.js'), 'one\ntwo\n'); // −1
  await page.click('.fx-ch-refresh');
  await page.locator('.fx-changed .fx-row').waitFor();
  assert.deepEqual(await rowText(page), ['Msrc/app.js+0−1']);
  execFileSync('git', ['checkout', '-q', '--', '.'], { cwd: proj });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Ask in chat from Quick Look puts the relative path into the composer and leaves Files', { skip, timeout: 60000 }, async () => {
  const { page, errors, ctx } = await open({ width: 1280, height: 860 }, false, 'c1');
  await page.fill('#input', 'Explain');
  await openFiles(page);
  await page.dblclick('#fxMain [role="option"]:has-text("src"), #fxMain [role="treeitem"]:has-text("src")');
  await page.locator('#fxMain :is([role="option"], [role="treeitem"]):has-text("app.js")').dblclick();
  await page.locator('#fxQL:not([hidden]) #fxQLAsk').click();
  assert.equal(await page.inputValue('#input'), 'Explain src/app.js ');
  assert.equal(await page.locator('#filesView').isHidden(), true, 'the Files view closes');
  assert.equal(await page.locator('#fxQL').isHidden(), true, 'Quick Look closes');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'input');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('375×667 touch: the Changed view fits, rows are 44px+, a tap opens the diff', { skip, timeout: 60000 }, async () => {
  fs.writeFileSync(path.join(proj, 'src/app.js'), 'one\ntwo\nthree\nfour\n');
  const { page, errors, ctx } = await open({ width: 375, height: 667 }, true);
  await filesView(page);
  await page.click('[data-fxview="changed"]');
  await page.locator('.fx-changed .fx-row').waitFor();
  const m = await page.evaluate(() => {
    const v = document.getElementById('filesView'), btn = document.querySelector('[data-fxview="changed"]').getBoundingClientRect();
    const row = document.querySelector('.fx-changed .fx-row').getBoundingClientRect();
    const cnt = document.querySelector('.fx-changed .fx-cnt').getBoundingClientRect();
    return { overflow: v.scrollWidth - v.clientWidth, btnH: btn.height, btnRight: btn.right, rowH: row.height, cntRight: cnt.right, vw: innerWidth };
  });
  assert.equal(m.overflow, 0, 'no sideways scroll');
  assert.ok(m.btnH >= 44 && m.rowH >= 44, `44px targets (${m.btnH}, ${m.rowH})`);
  assert.ok(m.btnRight <= m.vw && m.cntRight <= m.vw, 'the switch and the counts are on screen');
  await page.tap('.fx-changed .fx-row');
  await page.locator('#fxQL:not([hidden]) .fx-dl.add').waitFor();
  execFileSync('git', ['checkout', '-q', '--', '.'], { cwd: proj });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Ask on a Contents hit and Shift+Enter on a Names result add path:line and path', { skip, timeout: 60000 }, async () => {
  const { page, errors, ctx } = await open({ width: 1280, height: 860 }, false, 'c1');
  await openFiles(page);
  await page.fill('#fxFilter', 'needle');
  await page.click('[data-fxmode="contents"]');
  await page.press('#fxFilter', 'Enter');
  await page.locator('.fx-hit .fx-ask').click();
  assert.equal(await page.inputValue('#input'), 'src/app.js:2 ');
  assert.equal(await page.locator('#filesView').isHidden(), true);

  await page.fill('#input', '');
  await openFiles(page); // still showing the Contents results
  await page.fill('#fxFilter', 'app');
  await page.click('[data-fxmode="names"]');
  await page.press('#fxFilter', 'Enter');
  await page.locator('.fx-found [role="option"]').first().click();
  await page.keyboard.press('Shift+Enter');
  assert.equal(await page.inputValue('#input'), 'src/app.js ');
  assert.equal(await page.locator('#filesView').isHidden(), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});
