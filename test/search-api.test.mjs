// Chat search end to end: GET /api/convos?q= answers search.mjs matches (only the matching chat, with a snippet) while
// the plain GET /api/convos list is unchanged, and in the UI the sidebar's search field lists the match, opens it on a
// click and restores the chat list when cleared. Boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) with two seeded
// chats; skips the browser part when Playwright's Chromium can't launch.
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
const PASSWORD = 'search-api-password';
let browser, noBrowser = false;
try { browser = await chromium.launch(); } catch (e) { noBrowser = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const get = (p, auth = true) => fetch(base + p, { headers: auth ? { cookie } : {} });

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-search-api-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const now = Date.now(), line = (ev) => JSON.stringify(ev) + '\n';
  const chat = (id, title, at) => ({ id, title, renamed: true, cwd: path.join(dataDir, id), createdAt: at - 60_000, updatedAt: at, mode: 'default', fullAccess: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([chat('pelican', 'Bird tracker', now - 3_600_000), chat('ledger', 'Accounts', now - 7_200_000)]));
  fs.mkdirSync(path.join(dataDir, 'logs'));
  fs.writeFileSync(path.join(dataDir, 'logs', 'pelican.jsonl'), line({ t: 'user', text: 'Count the <b>pelicans</b> on the pier', ts: now - 3_700_000 })
    + line({ t: 'text', text: 'I counted 12 pelicans near the lighthouse.', ts: now - 3_650_000 }));
  fs.writeFileSync(path.join(dataDir, 'logs', 'ledger.jsonl'), line({ t: 'user', text: 'Reconcile the March statement', ts: now - 7_300_000 }));
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
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/convos?q= returns only matching chats with snippets; without q the full list', async () => {
  const hits = await (await get('/api/convos?q=PELICANS')).json();
  assert.deepEqual(hits.map((h) => h.id), ['pelican']);
  assert.equal(hits[0].title, 'Bird tracker');
  assert.equal(hits[0].hits.length, 2);
  assert.match(hits[0].hits[0].snippet, /12 pelicans near the lighthouse/);
  assert.deepEqual(await (await get('/api/convos?q=zebra')).json(), []);
  const list = await (await get('/api/convos')).json();
  assert.deepEqual(list.map((c) => c.id).sort(), ['ledger', 'pelican']);
  assert.ok(list.every((c) => 'busy' in c && !('hits' in c)), 'the plain list is the public chat list');
  assert.equal((await get('/api/convos?q=pelican', false)).status, 401);
});

test('UI: the sidebar search lists the match, opens it and restores the list when cleared', { skip: noBrowser, timeout: 60000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/`);
  const list = page.locator('#convoList');
  await list.locator('.convo', { hasText: 'Accounts' }).waitFor();
  const field = page.locator('#chatSearch');
  assert.equal(await field.getAttribute('placeholder'), 'Search chats');

  await field.fill('pelicans pier');
  const hit = list.locator('.convo.search-hit');
  await hit.first().waitFor();
  assert.equal(await hit.count(), 1);
  assert.equal(await hit.locator('.ct').textContent(), 'Bird tracker');
  assert.equal(await hit.locator('.cs').textContent(), 'Count the <b>pelicans</b> on the pier', 'the snippet is text, not HTML');
  assert.deepEqual(await hit.locator('mark').allTextContents(), ['pelicans', 'pier']);
  assert.match(await hit.locator('.cm').textContent(), /h ago/);

  await hit.click();
  await page.waitForFunction(() => location.hash === '#pelican');
  await page.locator('#messages', { hasText: 'I counted 12 pelicans' }).waitFor();

  await field.fill('zebra');
  await list.getByText('No chats match').waitFor();
  await field.fill('');
  await list.locator('.convo', { hasText: 'Accounts' }).waitFor();
  assert.equal(await list.locator('.search-hit').count(), 0);

  await field.fill('march');
  await list.locator('.search-hit', { hasText: 'Accounts' }).waitFor();
  await field.press('Escape');
  await list.locator('.convo', { hasText: 'Bird tracker' }).waitFor();
  assert.equal(await field.inputValue(), '');
  assert.equal(await list.locator('.search-hit').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});
