// Archiving a project and merging its chats (server.mjs PATCH /api/convos/:id {archived}, POST /api/convos/:id/merge;
// sidebar in public/app.js). Archive flags every chat of the folder and a new chat in it brings it back; the sidebar folds
// archived projects into one "Archived · n" row at the bottom. Merging splices the other chat's log into the main chat's
// as one block where it began (between two notices), keeps a recap for the main chat's next message and removes the chat.
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
const PASSWORD = 'archive-merge-password';
let child, base, dataDir, shop, notes, cookie, browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const jsonl = (evs) => evs.map((e) => JSON.stringify(e) + '\n').join('');
const readLog = (id) => fs.readFileSync(path.join(dataDir, 'logs', `${id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-archmerge-'));
  shop = fs.mkdtempSync(path.join(os.homedir(), '.cw-arch-shop-')); // chat folders must be inside the home directory
  notes = fs.mkdtempSync(path.join(os.homedir(), '.cw-arch-notes-'));
  for (const [dir, name] of [[shop, 'shop'], [notes, 'notes']]) {
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['remote', 'add', 'origin', `https://github.com/me/${name}.git`], { cwd: dir });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const chat = (id, title, cwd, createdAt, updatedAt, name) => ({ id, title, renamed: true, cwd, mode: 'bypassPermissions', fullAccess: true, model: '',
    createdAt, updatedAt, repo: { full: `me/${name}`, url: `https://github.com/me/${name}` } });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([
    chat('main', 'shop', shop, 1000, 4000, 'shop'), chat('side', 'dark mode', shop, 2000, 3000, 'shop'), chat('n1', 'notes', notes, 1500, 1500, 'notes'),
  ]));
  fs.mkdirSync(path.join(dataDir, 'logs'));
  // The two shop chats overlap in time: the side chat's block goes where it began, before the main chat's later turn.
  fs.writeFileSync(path.join(dataDir, 'logs', 'main.jsonl'), jsonl([
    { t: 'user', text: 'build the shop', ts: 1000 }, { t: 'text', text: 'Shop built.', ts: 1100 },
    { t: 'user', text: 'add a cart', ts: 2500 }, { t: 'text', text: 'Cart added.', ts: 2600 },
  ]));
  fs.writeFileSync(path.join(dataDir, 'logs', 'side.jsonl'), jsonl([
    { t: 'user', text: 'make it dark', ts: 2000 }, { t: 'text', text: 'Dark mode is on.', ts: 2100 },
  ]));
  fs.writeFileSync(path.join(dataDir, 'logs', 'n1.jsonl'), jsonl([{ t: 'user', text: 'notes', ts: 1500 }]));
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
  for (const d of [dataDir, shop, notes]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const call = async (p, method = 'GET', body) => {
  const r = await fetch(base + p, { method, headers: { cookie, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const list = async () => Object.fromEntries((await call('/api/convos')).body.map((c) => [c.id, c]));

async function page() {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.goto(base + '/');
  await pg.locator('#app:not([inert])').waitFor();
  return { ctx, pg, errors };
}

test('archive flags every chat of the folder; unarchive clears it; a new chat in it brings it back', async () => {
  assert.equal((await call('/api/convos/side', 'PATCH', { archived: true })).status, 200);
  let byId = await list();
  assert.ok(byId.main.archived > 0 && byId.side.archived > 0, 'the whole folder');
  assert.equal(byId.n1.archived, undefined, 'other projects untouched');
  await call('/api/convos/main', 'PATCH', { archived: false });
  byId = await list();
  assert.equal(byId.main.archived, undefined);
  assert.equal(byId.side.archived, undefined);

  await call('/api/convos/n1', 'PATCH', { archived: true });
  const r = await call('/api/convos', 'POST', { folder: notes, mode: 'bypassPermissions', title: 'more notes' });
  assert.equal(r.status, 200);
  byId = await list();
  assert.equal(byId.n1.archived, undefined, 'starting a chat in it unarchives the project');
  assert.equal(byId[r.body.id].archived, undefined);
  assert.equal((await call(`/api/convos/${r.body.id}`, 'DELETE')).status, 200);
});

test('sidebar: an archived project folds into "Archived · n" at the bottom; the menu archives and unarchives', { skip }, async () => {
  const { ctx, pg, errors } = await page();
  try {
    await pg.evaluate(() => localStorage.removeItem('cw.archivedOpen'));
    await pg.locator('.convo[data-cid="n1"] .more').click();
    await pg.locator('.menu button', { hasText: 'Archive project' }).click();
    const toggle = pg.locator('#convoList .arch-toggle');
    await toggle.waitFor();
    assert.equal(await toggle.textContent(), 'Archived · 1›');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await pg.locator('.convo[data-cid="n1"]').count(), 0, 'folded away');
    assert.equal(await pg.locator('#convoList > *').last().evaluate((n) => n.classList.contains('arch-toggle')), true, 'at the bottom');

    await toggle.click();
    await pg.locator('.convo[data-cid="n1"]').waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await pg.locator('.convo[data-cid="n1"] .more').click();
    await pg.locator('.menu button', { hasText: 'Unarchive project' }).click();
    await toggle.waitFor({ state: 'detached' });
    await pg.locator('.convo[data-cid="n1"]').waitFor();
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('merging puts the other chat into the main chat where it began, then removes it', async () => {
  assert.equal((await call('/api/convos/n1/merge', 'POST')).status, 400, 'a project with one chat has nothing to merge');
  const r = await call('/api/convos/side/merge', 'POST');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, into: 'main', merged: 1 });
  const byId = await list();
  assert.equal(byId.side, undefined);
  assert.equal(byId.main.updatedAt, 4000);
  assert.equal(fs.existsSync(path.join(dataDir, 'logs', 'side.jsonl')), false);
  assert.deepEqual(readLog('main').map((e) => e.text), ['build the shop', 'Shop built.', 'Merged in from the chat "dark mode"',
    'make it dark', 'Dark mode is on.', 'End of "dark mode"', 'add a cart', 'Cart added.']);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'convos.json'), 'utf8')).find((c) => c.id === 'main');
  assert.equal(saved.mergedRecaps.length, 1);
  assert.equal(saved.mergedRecaps[0].title, 'dark mode');
  assert.match(saved.mergedRecaps[0].recap, /Owner: make it dark\nClaude: Dark mode is on\./);
});

test('sidebar: "Merge into the main chat" on an extra chat opens the main chat with its messages', { skip }, async () => {
  const extra = (await call('/api/convos', 'POST', { folder: shop, mode: 'bypassPermissions', title: 'search' })).body;
  fs.writeFileSync(path.join(dataDir, 'logs', `${extra.id}.jsonl`), jsonl([{ t: 'user', text: 'add search', ts: Date.now() }]));
  const { ctx, pg, errors } = await page();
  try {
    await pg.locator(`.convo[data-cid="${extra.id}"]`).click();
    await pg.locator('#messages .msg.user', { hasText: 'add search' }).waitFor();
    pg.once('dialog', (d) => d.accept());
    await pg.locator(`.convo[data-cid="${extra.id}"] .more`).click();
    await pg.locator('.menu button', { hasText: 'Merge into the main chat' }).click();
    await pg.locator(`.convo[data-cid="${extra.id}"]`).waitFor({ state: 'detached' });
    await pg.waitForFunction(() => state.cid === 'main');
    await pg.locator('#messages .notice', { hasText: 'Merged in from the chat "search"' }).waitFor();
    assert.equal(await pg.locator('#messages .msg.user').last().innerText(), 'add search', 'newest last');
    assert.equal(await pg.locator('.convo[data-cid="main"] .more').count(), 1);
    await pg.locator('.convo[data-cid="main"] .more').click();
    assert.equal(await pg.locator('.menu button', { hasText: /^Merge/ }).count(), 0, 'nothing left to merge');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
