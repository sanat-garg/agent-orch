// Push notifications in the UI: /sw.js is served without a session and registered on load, Settings has the
// 'Notify this device' switch, and a notification's '#task-<id>' link opens that task's drawer.
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
import { findBrowser } from '../browser.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'push-ui-password';
const CID = 'chat-push';
let browser, skip = false;
try { browser = await chromium.launch(); } catch {
  try { browser = await chromium.launch({ executablePath: findBrowser() || undefined }); } catch (e) { skip = `no Chromium: ${e.message.split('\n')[0]}`; }
}
let child, base, dataDir, home, cookie, db, taskId;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pushui-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pushui-home-'));
  const project = path.join(dataDir, 'no-such-project');
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Pushes', cwd: project, mode: 'orchestrator', createdAt: 1, updatedAt: 1, fullAccess: true, fallbacks: [] }]));
  fs.mkdirSync(path.join(home, 'bin'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH: isolatedPath(path.join(home, 'bin')),
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
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,created_at) VALUES(?,?,'active',?,0)").run(project, 'Pushes', CID).lastInsertRowid);
  taskId = Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,position,created_at) VALUES(?,'work','Ship the push notifications','p','queued',1,0)")
    .run(pid).lastInsertRowid);
});

after(async () => {
  db?.close();
  await browser?.close();
  child?.kill('SIGKILL');
  for (const d of [dataDir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const newPage = async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  return { ctx, page: await ctx.newPage() };
};

test('/sw.js loads without a session, uncached, allowed for the whole origin', { skip }, async () => {
  const r = await fetch(base + '/sw.js', { redirect: 'manual' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('service-worker-allowed'), '/');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.match(r.headers.get('content-type'), /javascript/);
  const src = await r.text();
  assert.match(src, /addEventListener\('push'/);
  assert.doesNotMatch(src, /addEventListener\('fetch'/, 'caches nothing: no fetch handler');
});

test('the app registers /sw.js, Settings has the switch, and #task-<id> opens the drawer', { skip, timeout: 60000 }, async () => {
  const { ctx, page } = await newPage();
  await page.goto(`${base}/#${CID}`);
  const scriptURL = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.scriptURL
    || (await navigator.serviceWorker.ready).active.scriptURL);
  assert.match(scriptURL, /\/sw\.js$/);
  assert.equal(await page.locator('#settingsModal #stPush[role="switch"]').count(), 1);
  assert.match(await page.locator('#settingsModal').innerHTML(), /Notify this device/);

  await page.evaluate((id) => { location.hash = `#task-${id}`; }, taskId);
  await page.locator('#taskDrawer').waitFor({ state: 'visible' });
  await page.waitForFunction(() => /Ship the push notifications/.test(document.getElementById('taskDrawer').innerText));
  assert.equal(await page.evaluate(() => location.hash), `#${CID}`, 'the chat link stays in the address bar');
  await ctx.close();
});

test('opening the app at #task-<id> opens that task once the first state arrives', { skip, timeout: 60000 }, async () => {
  const { ctx, page } = await newPage();
  await page.goto(`${base}/#task-${taskId}`);
  await page.locator('#taskDrawer').waitFor({ state: 'visible' });
  await page.waitForFunction(() => /Ship the push notifications/.test(document.getElementById('taskDrawer').innerText));
  await ctx.close();
});
