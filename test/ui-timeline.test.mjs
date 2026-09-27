// Worker reports in the UI, on a phone-sized viewport: a remote task's drawer shows its phase timeline (a bar sized by
// each step's time, the steps with their durations, the running step counting up, progress hints and the worker's
// errors), and the Machines view shows each worker's health (disk, an automatic drain and why, its last error, a Mac's
// battery and thermal state). Boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) with fake workers and a seeded
// run; skips the browser part when Playwright's Chromium can't launch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';
import { PROTOCOL_VERSION, WS_PATH, FEATURE_LIST, createSender } from '../cluster-protocol.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'timeline-ui-password';
const GB = 2 ** 30;
let browser, noBrowser = false;
try { browser = await chromium.launch(); } catch (e) { noBrowser = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, taskId;
const sockets = [];

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const call = async (p, method = 'GET', body, auth = true) => {
  const r = await fetch(base + p, { method, headers: { ...(auth ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  return r.json();
};
// A fake worker: pairs, dials in, reports inventory and one telemetry frame, answers heartbeats.
async function fakeWorker(name, kind, agents, tele) {
  const { code } = await call('/api/cluster/pair', 'POST');
  const { node, token } = await call('/api/cluster/claim', 'POST', { code, name, os: kind, arch: 'arm64' }, false);
  const ws = new WebSocket(base.replace('http', 'ws') + WS_PATH, { headers: { authorization: `Bearer ${token}` } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  sockets.push(ws);
  const sender = createSender('w'), tx = (t, f = {}) => ws.readyState === 1 && ws.send(sender(t, f));
  ws.on('message', (d) => { if (JSON.parse(d).t === 'heartbeat') tx('heartbeat'); });
  tx('hello', { node, protocol: PROTOCOL_VERSION, version: '1.0.0', jobs: [], features: FEATURE_LIST });
  tx('inventory', { node, name, os: kind, arch: 'arm64', cores: tele.cpu.length, mem: 16 * GB, versions: {}, agents: agents.map((id) => ({ id, installed: true, signedIn: true })) });
  tx('resources', { memAvailable: 8 * GB, load: [1, 1, 1], running: [], swapUsedPct: 0, ...tele });
  return { node, tx };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-timeline-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
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

  const vps = await fakeWorker('build-vps', 'linux', ['codex'], { cpu: [60, 40], disk: { path: '/home/w/.agent-orch-worker', free: 18.4 * GB, total: 45 * GB } });
  const mac = await fakeWorker('studio-mac', 'darwin', ['claude'], { cpu: [10, 10, 10, 10], disk: { path: '/Users/a/.agent-orch-worker', free: 1.4 * GB, total: 460 * GB },
    battery: { pct: 64, charging: true, source: 'ac' }, thermal: { pressure: 'throttled', speedLimit: 76, warning: null } });
  mac.tx('node.error', { kind: 'exception', message: 'handling job.start failed: ENOSPC: no space left on device', stack: 'Error: ENOSPC\n    at writeSync' });
  await waitFor(async () => (await call('/api/cluster/nodes')).nodes.find((n) => n.id === mac.node)?.drainReason, { timeout: 10000, message: 'studio-mac auto-drained' });

  // A task running on build-vps whose worker has reported four steps, progress hints and a push that failed twice.
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,created_at) VALUES(?,?,'active',0)").run(path.join(dataDir, 'proj'), 'Seeded').lastInsertRowid);
  const now = Date.now() / 1000, at = Date.now() - 290_000;
  taskId = Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,agent,ran_agent,ran_model,started_at,created_at,node_id) VALUES(?,'work',?,'seed','running','codex','codex','gpt-5.5',?,?,?)")
    .run(pid, 'Report worker phases', now - 290, now - 300, vps.node).lastInsertRowid);
  const phases = [
    { phase: 'queued', at, w: at, ms: 400 }, { phase: 'fetching', at: at + 400, w: at + 400, ms: 3100 }, { phase: 'installing', at: at + 3500, w: at + 3500, ms: 41_000 },
    { phase: 'running', at: at + 44_500, w: at + 44_500, progress: { tools: 23, files: 5, last: 'Bash · npm test' } },
  ];
  const errors = [{ at: Date.now() - 60_000, kind: 'push_failed', message: 'push of agent-orch/task-1 failed: remote: Internal Server Error', stderr: 'fatal: unable to access: The requested URL returned error: 500', count: 2 }];
  db.prepare("INSERT INTO runs(task_id,purpose,agent,node_id,started_at,phases,errors) VALUES(?,'work','codex',?,?,?,?)").run(taskId, vps.node, now - 290, JSON.stringify(phases), JSON.stringify(errors));
  db.close();
});

after(async () => {
  for (const ws of sockets) ws.terminate();
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the task detail API carries each run’s phases and errors', async () => {
  const d = await call(`/api/orch/task/${taskId}`);
  assert.deepEqual(d.runs[0].phases.map((p) => p.phase), ['queued', 'fetching', 'installing', 'running']);
  assert.ok(d.runs[0].phases.every((p) => p.w === undefined), "the worker's own clock stays on the server");
  assert.equal(d.runs[0].errors[0].kind, 'push_failed');
});

test('UI: machine health on the cards, and the phase timeline in a remote task’s drawer (390px)', { skip: noBrowser, timeout: 60000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/`);
  await page.locator('#miniStats').dispatchEvent('click'); // the sidebar is off-canvas on a phone
  const mac = page.locator('.mc-node', { hasText: 'studio-mac' });
  await mac.locator('.mc-health').first().waitFor();
  const macText = await mac.textContent();
  for (const want of ['Draining', 'Drained automatically', 'only 1.4 GB is free on the disk that holds its repos', 'Error just now: handling job.start failed: ENOSPC',
    'Battery 64% · charging', 'Running hot: CPU limited to 76%', '1.4 GB free of 460.0 GB']) assert.ok(macText.includes(want), `studio-mac card shows "${want}": ${macText}`);
  assert.equal(await mac.locator('.mc-health.warn', { hasText: 'Drained automatically' }).count(), 1);
  assert.match(await page.locator('.mc-node', { hasText: 'build-vps' }).locator('.mc-meter', { hasText: 'Disk' }).textContent(), /18\.4 GB free of 45\.0 GB/);

  await page.locator('.mc-task', { hasText: 'Report worker phases' }).click();
  const tl = page.locator('#drBody .dr-sec', { has: page.locator('.tl-bar') });
  await tl.waitFor();
  assert.equal(await tl.locator('h3').textContent(), 'Timeline');
  assert.deepEqual(await tl.locator('.tl-steps li .n').allTextContents(), ['Queued', 'Fetch', 'Install', 'Agent']);
  assert.deepEqual((await tl.locator('.tl-steps li .t').allTextContents()).slice(0, 3), ['0s', '3s', '41s']);
  assert.match(await tl.locator('.tl-steps li.cur').textContent(), /^Agent\s*[45]m…$/, 'the step in progress counts up');
  assert.deepEqual(await tl.locator('.tl-bar i').evaluateAll((els) => els.map((e) => e.className)), ['', '', '', 'cur']);
  const widths = await tl.locator('.tl-bar i').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  assert.ok(widths[3] > widths[2] && widths[2] > widths[1] && widths[0] >= 3, `segments sized by time: ${widths}`);
  assert.equal(await tl.locator('.tl-hint').textContent(), '23 tool calls · 5 files edited · last: Bash · npm test');
  assert.match(await tl.locator('.tl-err summary').textContent(), /^Push failed \(2×\): push of agent-orch\/task-1 failed/);
  await tl.locator('.tl-err summary').click();
  await tl.locator('.tl-err pre', { hasText: 'returned error: 500' }).waitFor();
  const fits = await page.evaluate(() => { const b = document.querySelector('#drBody'); return b.scrollWidth <= b.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth; });
  assert.ok(fits, 'the drawer fits 390px');
  await ctx.close();
  assert.deepEqual(errors, []);
});
