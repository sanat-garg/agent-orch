// The browser tab title counts held actions waiting for the owner ('(2) Invoices · agent-orch'), the same count the Home
// Screen badge uses, so the owner notices from another tab; once they are resolved the plain title returns. Zen keeps it plain.
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
const PASSWORD = 'title-badge-password';
const CID = 'chat-title-badge';
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-title-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-title-home-'));
  const project = path.join(dataDir, 'no-such-project');
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Invoices', cwd: project, mode: 'orchestrator', createdAt: 1, updatedAt: 1, fullAccess: true, fallbacks: [] }]));
  fs.mkdirSync(path.join(home, 'bin'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH: isolatedPath(path.join(home, 'bin')),
    PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 90000);
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
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,created_at) VALUES(?,?,'active',?,0)").run(project, 'Invoices', CID).lastInsertRowid);
  taskId = Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,position,started_at,capabilities,node_id,created_at) VALUES(?,'work','Email the invoice to the client','p','running',1,?,'[\"browser\"]','mac',0)")
    .run(pid, Date.now() / 1000 - 120).lastInsertRowid);
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO approvals(id,task_id,run_id,node,created_at,expires_at,server,tool,action,reason_class,key,url,args,status)
    VALUES(?,'${taskId}',1,'mac',?,?,'playwright','browser_click',?,'target matches "Send"',?,'https://mail.google.com/','{}','pending')`);
  ins.run('mtitle0001', now - 60_000, now + 23 * 3600_000, 'Click "Send" button on mail.google.com · Invoice 42', 'k1');
  ins.run('mtitle0002', now - 50_000, now + 23 * 3600_000, 'Click "Send" button on mail.google.com · Invoice 43', 'k2');
});

after(async () => {
  db?.close();
  await browser?.close();
  child?.kill('SIGKILL');
  for (const d of [dataDir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const decide = (id) => fetch(`${base}/api/orch/approvals/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ decision: 'deny', reason: 'not now' }) }).then((r) => { assert.equal(r.status, 200, id); return r.arrayBuffer(); });

test('the tab title counts pending approvals and drops the count once they are resolved', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  await page.goto(`${base}/#${CID}`);
  await page.waitForFunction(() => !document.getElementById('app').inert);
  await page.waitForFunction(() => document.title.startsWith('(2) '));
  const plain = (await page.title()).slice(4); // the page's own title, whatever it names the chat
  assert.match(plain, /^[^(].* · agent-orch$/);

  // Zen holds notices: the plain title, and the count comes back on leaving.
  await page.evaluate(() => setZen(true));
  assert.equal(await page.title(), plain);
  await page.evaluate(() => setZen(false));
  await page.locator('#zenModal').evaluate((m) => m.close?.()).catch(() => {});
  assert.equal(await page.title(), `(2) ${plain}`);

  await decide('mtitle0001');
  await page.waitForFunction(() => document.title.startsWith('(1) '));
  await decide('mtitle0002');
  await page.waitForFunction(() => !document.title.startsWith('('));
  assert.equal(await page.title(), plain);
  await ctx.close();
});
