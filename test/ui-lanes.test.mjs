// Running-project sidebar dot (and no lanes in the Queue window) in an isolated server, seeded without running agent CLIs.
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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'lanes-ui-password';
const CID = 'chat-lanes';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, home, cookie, db, pid;
const PROJECT = () => path.join(dataDir, 'no-such-project');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lanesui-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lanesui-home-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Parallel work', cwd: PROJECT(), mode: 'orchestrator',
    agent: 'codex', model: 'gpt-5.5', createdAt: 1, updatedAt: 1, fullAccess: true, fallbacks: [] }]));
  const bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/codex-stub.mjs'), path.join(bin, 'codex'));
  const port = await freePort();
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  const PATH = isolatedPath(bin);
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH, AA_API_KEY: '', CW_AA_BASE: 'http://127.0.0.1:9',
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
  // Seed a project and three running agents without starting workers.
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  pid = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,created_at) VALUES(?,?,'active',?,0)")
    .run(PROJECT(), 'Lanes', CID).lastInsertRowid);
  for (const [i, agent] of ['claude', 'codex', 'claude'].entries()) {
    db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,agent,ran_agent,ran_model,started_at,created_at) VALUES(?,'work',?,'seed','running',?,?,?, ?,0)")
      .run(pid, ['Build lanes UI', 'Verify scheduler', 'Document parallel work'][i], agent, agent, 'test-model', Math.floor(Date.now()/1000)-120);
  }
  if (process.env.CW_LANES_KEEP) console.log(`KEEP ${base}/#${CID} ${cookie}`);

});

after(async () => {
  db?.close();
  if (process.env.CW_LANES_KEEP) { await browser?.close(); return; }
  await browser?.close();
  child?.kill('SIGKILL');
  for (const d of [dataDir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});


test('running projects get a sidebar dot; the Queue window shows no lanes', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  await page.goto(`${base}/#${CID}`);
  await page.locator('#obQueue').click();
  if (process.env.CW_LANES_KEEP) return;
  await page.waitForFunction(() => document.querySelector('#qBody').textContent.includes('Build lanes UI'));
  assert.equal(await page.locator('#qLanes, .lane-card').count(), 0);
  // Each running task names its machine instead ('on vps-2'; 'waiting for …' while that machine is away).
  await page.evaluate(() => { const t = [...O.tasks.values()].find((x) => x.title === 'Build lanes UI'); onOrch({ t: 'otask', task: { ...t, node: 'n_1', node_name: 'vps-2' } }); });
  await page.locator('#qBody .tcard', { hasText: 'Build lanes UI' }).locator('.tc-node', { hasText: 'on vps-2' }).waitFor();
  await page.evaluate(() => { const t = [...O.tasks.values()].find((x) => x.title === 'Build lanes UI'); onOrch({ t: 'otask', task: { ...t, waiting_for: 'Mac mini (Mac asleep)' } }); });
  await page.locator('#qBody .tcard', { hasText: 'Build lanes UI' }).locator('.tc-node', { hasText: 'waiting for Mac mini (Mac asleep)' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => closeQueue());
  await page.waitForFunction((cid) => document.querySelector(`.convo[data-cid="${cid}"] .run-dot`), CID);
  await page.evaluate(() => { for (const t of O.tasks.values()) onOrch({ t: 'otask', task: { ...t, status: 'done', finished_at: Date.now()/1000 } }); });
  await page.waitForFunction((cid) => !document.querySelector(`.convo[data-cid="${cid}"] .run-dot`), CID);
  // Another project's running lane (from server state) marks it too.
  await page.evaluate(() => onOrch({ t: 'ostate', state: { ...O.state, lanes: [{ agent: 'codex', task: 1, project_id: O.project.id, title: 'x' }] } }));
  await page.waitForFunction((cid) => document.querySelector(`.convo[data-cid="${cid}"] .run-dot`), CID);
  await ctx.close();
});
