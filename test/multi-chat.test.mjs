// Several chats per project folder: boot keeps them all (no folding), the oldest is the main chat (it alone carries the
// project rank), POST /api/convos {folder} adds another chat named from its first message and sharing the repo, and
// deleting the main chat hands the project to the next oldest. In a browser, the other chats sit indented under the main
// one and their menu offers "New chat in this project" (and leaves the header's View menu alone).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'multi-chat-password';
let child, base, dataDir, proj, cookie, browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const repo = { full: 'me/shop', url: 'https://github.com/me/shop' };

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-multi-'));
  proj = fs.mkdtempSync(path.join(os.homedir(), '.cw-multi-proj-')); // chat folders must be inside the home directory
  execFileSync('git', ['init', '-q', proj]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/me/shop.git'], { cwd: proj });
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([
    { id: 'c-new', title: 'fix the header', renamed: true, cwd: proj, mode: 'bypassPermissions', fullAccess: true, model: '', createdAt: 2000, updatedAt: 5000, repo },
    { id: 'c-old', title: 'x', cwd: proj, mode: 'bypassPermissions', fullAccess: true, model: '', createdAt: 1000, updatedAt: 1000, repo },
  ]));
  fs.mkdirSync(path.join(dataDir, 'logs'));
  for (const id of ['c-new', 'c-old']) fs.writeFileSync(path.join(dataDir, 'logs', `${id}.jsonl`), JSON.stringify({ t: 'user', text: `hello from ${id}` }) + '\n');
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
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  for (const d of [dataDir, proj]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const call = async (p, method = 'GET', body) => {
  const r = await fetch(base + p, { method, headers: { cookie, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const list = async () => Object.fromEntries((await call('/api/convos')).body.map((c) => [c.id, c]));

test('chats of one folder all survive boot; the oldest is the main chat', async () => {
  const byId = await list();
  assert.deepEqual(Object.keys(byId).sort(), ['c-new', 'c-old']);
  assert.equal(byId['c-old'].title, path.basename(proj), 'the main chat is named after its folder');
  assert.equal(byId['c-new'].title, 'fix the header', 'an extra chat keeps its own name');
  assert.equal(byId['c-old'].mainId, 'c-old');
  assert.equal(byId['c-new'].mainId, 'c-old');
  assert.equal(byId['c-new'].project, null, 'only the main chat carries the project rank');
  for (const id of ['c-new', 'c-old']) assert.match(fs.readFileSync(path.join(dataDir, 'logs', `${id}.jsonl`), 'utf8'), new RegExp(`hello from ${id}`));
});

test('POST /api/convos {folder} adds another chat named from its first message', async () => {
  const r = await call('/api/convos', 'POST', { folder: proj, mode: 'bypassPermissions', title: '  Add   a dark mode toggle to the settings page please  ' });
  assert.equal(r.status, 200);
  const c = r.body;
  assert.notEqual(c.id, 'c-old');
  assert.equal(c.title, 'Add a dark mode toggle to the settings page please');
  assert.equal(c.cwd, proj);
  assert.equal(c.mainId, 'c-old');
  assert.deepEqual(c.repo, repo, 'it shares the folder repo');
  assert.equal(Object.keys(await list()).length, 3);
});

test('new-chat screen: no recent-project buttons; Import from GitHub opens the picker on its import pane', { skip }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    await ctx.addCookies([{ name, value, url: base }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/github/repos', (r) => r.fulfill({ json: { repos: [{ full: 'me/site', description: 'my site' }] } }));
    await page.goto(base + '/');
    await page.locator('#app:not([inert]) .empty').waitFor();
    assert.equal(await page.locator('.empty').getByText(/recent project/i).count(), 0);
    await page.locator('.empty .gh-import').click();
    await page.locator('#pkGithub').waitFor();
    assert.equal(await page.textContent('#pickerTitle'), 'Import from GitHub');
    assert.equal(await page.isHidden('#pkProjects'), true);
    await page.locator('#pkGhList', { hasText: 'me/site' }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('sidebar: other chats nest under the main chat; their menu starts another chat in the folder', { skip }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    await ctx.addCookies([{ name, value, url: base }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/');
    await page.locator('#app:not([inert])').waitFor();
    const rows = await page.locator('#convoList .convo').evaluateAll((ns) => ns.map((n) => [n.dataset.cid, n.classList.contains('sub')]));
    const at = rows.findIndex(([id]) => id === 'c-old');
    assert.deepEqual(rows[at], ['c-old', false]);
    assert.deepEqual(rows.slice(at + 1).map(([, sub]) => sub), [true, true], 'both other chats right under it, indented');
    assert.equal(rows[at + 2][0], 'c-new', 'newest first');
    const labels = await page.locator('#convoList .group-label').allTextContents();
    assert.ok(!labels.some((l) => /today|this week|older|other projects/i.test(l)), `no date or "other" labels: ${labels}`);
    const card = page.locator('.convo[data-cid="c-old"]');
    assert.equal(await card.locator('.cm').count(), 0, 'an idle card is one row: no mode or age line');
    assert.ok((await card.boundingBox()).height < 40, 'compact card');
    await page.locator('.convo[data-cid="c-new"] .more').click();
    await page.locator('.menu button', { hasText: 'New chat in this project' }).click();
    assert.equal(await page.evaluate(() => state.cid), null);
    assert.equal(await page.evaluate(() => state.draft.path), proj);
    assert.equal(await page.locator('#viewMenu').count(), 1, "a chat menu never removes the header's View menu");
    await page.locator('#input').click();
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('deleting the main chat hands the project to the next oldest chat', async () => {
  assert.equal((await call('/api/convos/c-old', 'DELETE')).status, 200);
  const byId = await list();
  assert.equal(byId['c-old'], undefined);
  for (const c of Object.values(byId)) assert.equal(c.mainId, 'c-new');
});
