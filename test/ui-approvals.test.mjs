// The approval gate in the UI: a held action under its Queue card and at the top of the drawer (exact action, the page,
// Approve once / Always allow / Deny with a reason), and the drawer's Actions timeline from the task's audit log.
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
import { appendAudit } from '../gate.mjs';
import { saveMedia } from '../media.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'approvals-ui-password';
const CID = 'chat-approvals';
const SHOTS = process.env.CW_APPROVAL_SHOTS; // optional dir: save screenshots of the states it checks
let browser, skip = false;
try { browser = await chromium.launch(); } catch {
  try { browser = await chromium.launch({ executablePath: findBrowser() || undefined }); } catch (e) { skip = `no Chromium: ${e.message.split('\n')[0]}`; }
}
let child, base, dataDir, home, cookie, db, taskId;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-apui-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-apui-home-'));
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
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,created_at) VALUES(?,?,'active',?,0)").run(project, 'Invoices', CID).lastInsertRowid);
  taskId = Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,position,started_at,capabilities,node_id,created_at) VALUES(?,'work','Email the invoice to the client','p','running',1,?,'[\"browser\"]','mac',0)")
    .run(pid, Date.now() / 1000 - 120).lastInsertRowid);
  const shot = saveMedia(dataDir, PNG, 'page').id, now = Date.now();
  db.prepare(`INSERT INTO approvals(id,task_id,run_id,node,created_at,expires_at,server,tool,action,reason_class,key,url,args,screenshot,status)
    VALUES('mabc123def','${taskId}',1,'mac',?,?,'playwright','browser_click',?,'target matches "Send"','k','https://mail.google.com/mail/u/0/#inbox?compose=new','{}',?,'pending')`)
    .run(now - 60_000, now + 23 * 3600_000, 'Click "Send" button on mail.google.com/mail/u/0/ · To: bob@example.com, Subject: Invoice 42', shot);
  const file = path.join(dataDir, 'audit', `${taskId}.jsonl`);
  appendAudit(file, { ts: now - 90_000, task: taskId, server: 'playwright', tool: 'browser_navigate', class: 'draft', action: 'Open https://mail.google.com/', args: { url: 'https://mail.google.com/' }, ok: true });
  appendAudit(file, { ts: now - 80_000, task: taskId, server: 'playwright', tool: 'browser_snapshot', class: 'read', action: 'snapshot on mail.google.com', args: {}, ok: true });
  appendAudit(file, { ts: now - 70_000, task: taskId, server: 'playwright', tool: 'browser_click', class: 'outbound', action: 'Click "Delete" button on mail.google.com', args: {}, approval: 'mold', decision: 'deny', note: 'keep that thread', ok: false, screenshot: shot });
});

after(async () => {
  db?.close();
  await browser?.close();
  child?.kill('SIGKILL');
  for (const d of [dataDir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test('a held action shows under its card and in the drawer with the Actions timeline; Deny sends the reason', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  await page.goto(`${base}/#${CID}`);
  await page.locator('#obQueue').click();
  const card = page.locator(`#qBody .tcard[data-task="${taskId}"]`);
  await card.waitFor();
  assert.match(await card.innerText(), /Awaiting your approval/);
  const panel = page.locator('#qBody .ap-panel');
  await panel.waitFor();
  assert.match(await panel.innerText(), /Click "Send" button on mail\.google\.com\/mail\/u\/0\/ · To: bob@example\.com, Subject: Invoice 42/);
  for (const b of ['Approve once', 'Always allow for this task', 'Deny…']) assert.equal(await panel.getByRole('button', { name: b }).count(), 1, b);
  assert.equal(await panel.locator('.shot').count(), 1, 'the page screenshot');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'approval-queue-mobile.png') });

  await card.click();
  const dr = page.locator('#drBody');
  await dr.locator('.ap-panel').waitFor();
  await dr.locator('.dr-actions-log summary').click();
  await dr.locator('.act-list .act').first().waitFor();
  assert.equal(await dr.locator('.act-list .act').count(), 3);
  assert.match(await dr.locator('.act-list').innerText(), /Click "Delete" button on mail\.google\.com[\s\S]*denied by you · "keep that thread"/);
  assert.equal(await dr.locator('.act-list .act-outbound').count(), 1);
  if (SHOTS) {
    await page.screenshot({ path: path.join(SHOTS, 'approval-drawer-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(SHOTS, 'approval-drawer-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
  }
  const p = dr.locator('.ap-panel');
  await p.getByRole('button', { name: 'Deny…' }).click();
  await p.locator('textarea').fill('Wrong amount: fix the invoice first');
  await p.getByRole('button', { name: 'Deny', exact: true }).click();
  const row = async () => db.prepare("SELECT status, note FROM approvals WHERE id='mabc123def'").get();
  for (let i = 0; i < 200 && (await row()).status === 'pending'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual({ ...(await row()) }, { status: 'denied', note: 'Wrong amount: fix the invoice first' });
  await ctx.close();
});
