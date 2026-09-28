// The "Add machine" wizard (Server details → Machines): the pairing API flow (POST /api/cluster/pair → GET
// /api/cluster/pair/:code waiting → a worker claims it → paired), the install scripts served at /install/…, and the UI
// showing a one-line command per OS with the fresh code that flips to "Paired: <name>" once the code is claimed.
// Then the Machines view with seeded fake nodes (a worker socket sending inventory/resources, running tasks in the DB):
// one card per node with its Machine settings, the cluster summary, live updates, and a 390px fit.
// Boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir). The browser part skips when Playwright's Chromium can't launch.
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
import { PROTOCOL_VERSION, WS_PATH, createSender } from '../cluster-protocol.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'machines-ui-password';
let browser, noBrowser = false;
try { browser = await chromium.launch(); } catch (e) { noBrowser = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const call = async (p, method = 'GET', body, auth = true) => {
  const r = await fetch(base + p, { method, headers: { ...(auth ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const claim = (code, name) => call('/api/cluster/claim', 'POST', { code, name, os: 'linux', arch: 'arm64' }, false);

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-machines-'));
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
});

after(async () => {
  for (const ws of workers) ws.terminate();
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('install scripts are served without a session', async () => {
  for (const [p, f] of [['/install/worker-linux.sh', 'install-worker.sh'], ['/install/worker-macos.sh', 'install-worker-macos.sh']]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), fs.readFileSync(path.join(ROOT, 'bin', f), 'utf8'));
  }
});

test('pairing API: waiting → claimed once → paired with the node', async () => {
  assert.equal((await call('/api/cluster/pair', 'POST', undefined, false)).status, 401);
  const { body: { code, expiresAt } } = await call('/api/cluster/pair', 'POST');
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(expiresAt > Date.now());
  assert.equal((await call(`/api/cluster/pair/${code}`, 'GET', undefined, false)).status, 401);
  assert.deepEqual((await call(`/api/cluster/pair/${code}`)).body, { state: 'waiting', expiresAt });
  assert.equal((await call('/api/cluster/pair/ZZZZ-ZZZZ')).body.state, 'unknown');
  const c = await claim(code.toLowerCase(), 'vps-2');
  assert.equal(c.status, 200);
  assert.match(c.body.token, /^aon_/);
  assert.equal((await claim(code, 'again')).status, 401, 'a code is single use');
  const p = (await call(`/api/cluster/pair/${code}`)).body;
  assert.equal(p.state, 'paired');
  assert.equal(p.node.id, c.body.node);
  assert.equal(p.node.name, 'vps-2');
  assert.equal(p.node.connected, false);
  assert.equal(p.node.token_hash, undefined);
});

test('UI: Add machine shows a command per OS with a fresh code, then the machine that claimed it', { skip: noBrowser, timeout: 60000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/`);
  await page.locator('#miniStats').click();
  await page.locator('#mMachines li').first().waitFor();
  assert.match(await page.locator('#mMachines').textContent(), /this server/);
  await page.locator('#addMachine').click();
  const cmds = page.locator('#amBody pre.am-cmd');
  await cmds.nth(1).waitFor();
  const [linux, mac] = await cmds.evaluateAll((els) => els.map((e) => e.dataset.copy));
  const code = linux.match(/--code (\S+)/)[1];
  assert.equal(linux, `curl -fsSL ${base}/install/worker-linux.sh | bash -s -- --controller ${base} --code ${code} --agents claude,codex`);
  assert.equal(mac, `curl -fsSL ${base}/install/worker-macos.sh | sudo bash -s -- --controller ${base} --code ${code} --agents claude,codex`);
  assert.equal((await call(`/api/cluster/pair/${code}`)).body.state, 'waiting', 'the UI code is fresh and live');
  assert.match(await page.locator('.am-status').textContent(), /Waiting for the machine to connect/);
  // A worker claims it: the server's 'cluster' push makes the wizard re-check.
  assert.equal((await claim(code, 'mac-mini')).status, 200);
  await page.locator('.am-status', { hasText: 'Paired: mac-mini' }).waitFor({ timeout: 10000 });
  assert.match(await page.locator('.am-next').textContent(), /sign the agents in on mac-mini/);
  assert.equal(await cmds.count(), 0);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#machineModal').isHidden(), true);
  assert.equal(await page.locator('#mxModal').isVisible(), true, 'Escape closes only the wizard');
  await page.locator('#mMachines li', { hasText: 'mac-mini' }).waitFor();
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('UI: Connections shows a machine switcher once workers exist, and a worker tab shows that machine', { skip: noBrowser, timeout: 60000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/`);
  await page.locator('#connFoot').dispatchEvent('click'); // the sidebar is off-canvas on a phone
  const tabs = page.locator('#connsMachines button');
  await tabs.nth(1).waitFor();
  assert.equal(await page.locator('#connsMachines').isVisible(), true);
  const names = await tabs.allTextContents();
  assert.equal(names[0], 'Controller');
  assert.ok(names.includes('vps-2') && names.includes('mac-mini'), names.join(','));
  assert.equal(await tabs.first().getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('#connsApp').textContent(), /agent-orch server/);
  await page.locator('#connsMachines button', { hasText: 'vps-2' }).click();
  await page.locator('#connsApp', { hasText: 'vps-2' }).waitFor();
  assert.match(await page.locator('#connsList').textContent(), /vps-2 is offline/);
  const fits = await page.locator('#connsModal .modal-panel').evaluate((p) => p.scrollWidth <= p.clientWidth + 1);
  assert.ok(fits, 'the switcher does not widen the sheet');
  await page.locator('#connsMachines button', { hasText: 'Controller' }).click();
  await page.locator('#connsApp', { hasText: 'agent-orch server' }).waitFor();
  await ctx.close();
  assert.deepEqual(errors, []);
});

const workers = []; // fake worker sockets, closed in after()
// A fake worker: pairs, dials the hub with its token and reports inventory + resources; heartbeats keep it online.
async function fakeWorker(name, kind, { cores, mem, avail, load, agents }) {
  const { body: { code } } = await call('/api/cluster/pair', 'POST');
  const { body: { node, token } } = await call('/api/cluster/claim', 'POST', { code, name, os: kind, arch: 'arm64' }, false);
  const ws = new WebSocket(base.replace('http', 'ws') + WS_PATH, { headers: { authorization: `Bearer ${token}` } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const sender = createSender('w'), tx = (t, f) => ws.readyState === 1 && ws.send(sender(t, f));
  tx('hello', { node, protocol: PROTOCOL_VERSION, version: 'test', jobs: [] });
  tx('inventory', { node, name, os: kind, arch: 'arm64', cores, mem, versions: {}, agents: agents.map((id) => ({ id, installed: true, signedIn: true })) });
  tx('resources', { memAvailable: avail, load, running: [] });
  const beat = setInterval(() => tx('heartbeat'), 2000);
  beat.unref();
  workers.push(ws);
  return { node, ws, tx };
}

test('Machines view: one card per node with its state, capacity, running tasks and its Machine settings', { skip: noBrowser, timeout: 60000 }, async () => {
  const GB = 2 ** 30;
  const vps = await fakeWorker('build-vps', 'linux', { cores: 4, mem: 24 * GB, avail: 16 * GB, load: [1.5, 1, 1], agents: ['claude', 'codex'] });
  const mac = await fakeWorker('studio-mac', 'darwin', { cores: 10, mem: 16 * GB, avail: 8 * GB, load: [2, 2, 2], agents: ['claude'] });
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,created_at) VALUES(?,?,'active',0)").run(path.join(dataDir, 'proj'), 'Seeded').lastInsertRowid);
  const seed = db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,agent,ran_agent,ran_model,started_at,created_at,node_id) VALUES(?,'work',?,'seed','running',?,?,?,?,0,?)");
  const now = Math.floor(Date.now() / 1000);
  const t1 = Number(seed.run(pid, 'Build the machines view', 'codex', 'codex', 'gpt-5.5', now - 750, vps.node).lastInsertRowid);
  seed.run(pid, 'Tidy the settings sheet', 'claude', 'claude', 'opus', now - 60, 'controller');
  db.close();

  const nodes = (await call('/api/cluster/nodes')).body.nodes;
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'build-vps-2' : undefined));
  await page.goto(`${base}/`);
  await page.locator('#miniStats').dispatchEvent('click'); // the sidebar is off-canvas on a phone
  const cards = page.locator('#mMachines .mc-node');
  await page.locator('#mMachines .mc-node[data-node]', { hasText: 'studio-mac' }).waitFor();
  assert.equal(await cards.count(), nodes.length, 'one card per node');
  assert.deepEqual(await cards.evaluateAll((els) => els.map((e) => e.dataset.node)), nodes.map((n) => n.id));
  for (let i = 0; i < nodes.length; i++) assert.equal(await cards.nth(i).locator('details.mc-set:not([open]) input[data-act="accept"]').count(), 1, `${nodes[i].name} has a closed Machine settings with Run tasks on this machine`);
  // The cards sit in the full-screen Machines view (the sidebar card opens all of them), and the summary counts the connected machines.
  assert.equal(await page.evaluate(() => document.querySelector('#mxMain').contains(document.querySelector('#mMachines'))), true);
  assert.match(await page.locator('#mcSum').textContent(), /^Cluster: 3 machines · \d+ cores · [\d.]+ GB free · 2 of \d+ slots running · 2 offline$/);

  const card = page.locator('.mc-node', { hasText: 'build-vps' });
  const text = await card.textContent();
  for (const want of ['Online', 'Linux · arm64', '4 cores', 'load 1.50', '8.0 GB used', '16.0 GB free of 24.0 GB', 'Claude Code', 'Build the machines view', '#' + t1, '13m', 'Running · 1 of 4 slots']) {
    assert.ok(text.includes(want), `build-vps card shows "${want}": ${text}`);
  }
  assert.match(await page.locator('.mc-node', { hasText: 'studio-mac' }).textContent(), /macOS · arm64[\s\S]*Nothing running|macOS · arm64[\s\S]*Idle/);
  assert.match(await page.locator('.mc-node', { hasText: 'vps-2' }).first().textContent(), /Offline/);
  const local = page.locator('.mc-node[data-node="controller"]');
  assert.match(await local.textContent(), /this server[\s\S]*Tidy the settings sheet/);
  assert.equal(await local.locator('[data-act="remove"]').count(), 0, 'the controller cannot be disabled or removed');

  // Machine settings (open across the live re-renders): Run tasks on this machine off (live through the 'cluster'
  // push), Auto slots, Rename.
  await card.locator('summary[data-act="settings"]').click();
  assert.deepEqual(await card.locator('.mc-set[open] h5').allTextContents(), ['Work', 'Manage']);
  await card.locator('input[data-act="accept"]').click();
  await page.locator('.mc-node', { hasText: 'build-vps' }).locator('.mc-st', { hasText: 'Draining' }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator('.mc-node', { hasText: 'build-vps' }).locator('input[data-act="accept"]').isChecked(), false);
  assert.match(await page.locator('.mc-node', { hasText: 'build-vps' }).locator('.mc-set[open]').textContent(), /Finish current tasks, then stop/);
  assert.equal((await call('/api/cluster/nodes')).body.nodes.find((n) => n.id === vps.node).draining, true);
  await page.locator('.mc-node', { hasText: 'build-vps' }).locator('.seg-sm button', { hasText: 'Auto' }).click();
  await page.locator('.mc-node', { hasText: 'build-vps' }).locator('.seg-sm button[aria-pressed="true"]', { hasText: 'Auto' }).waitFor();
  assert.equal((await call('/api/cluster/nodes')).body.nodes.find((n) => n.id === vps.node).maxSlots, null);
  await page.locator('.mc-node', { hasText: 'build-vps' }).locator('[data-act="rename"]').click();
  await page.locator('.mc-node .mc-name', { hasText: 'build-vps-2' }).waitFor();
  // A worker's new reading shows up live.
  vps.tx('resources', { memAvailable: 20 * GB, load: [0.25, 0.5, 0.5], running: [] });
  await page.locator('.mc-node', { hasText: 'build-vps-2' }).locator('.mc-meter', { hasText: '20.0 GB free' }).waitFor({ timeout: 15000 });

  const fits = await page.evaluate(() => {
    const p = document.querySelector('#mxModal .mx-panel');
    return document.documentElement.scrollWidth <= innerWidth && p.scrollWidth <= p.clientWidth + 1
      && [...document.querySelectorAll('.mc-node')].every((c) => c.scrollWidth <= c.clientWidth + 1);
  });
  assert.ok(fits, 'the Machines view fits 390px');
  const small = await page.evaluate(() => [...document.querySelectorAll('.mc-set[open] :is(summary, button)')].filter((b) => b.getBoundingClientRect().height < 44).length);
  assert.equal(small, 0, 'every settings control is a 44pt target on a phone');
  // Tapping a running task opens its drawer over the view.
  await page.locator('#mMachines .mc-task', { hasText: 'Build the machines view' }).click();
  await page.locator('#taskDrawer:not([hidden])').waitFor();
  assert.equal(await page.locator('#mxModal').isVisible(), true);
  assert.equal(await page.evaluate(() => O.drawer), t1);
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('the controller node opens this server’s details in the node detail: its CPU/RAM charts, then a worker’s tiles in the same order', { skip: noBrowser, timeout: 60000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/`);
  // The sidebar card opens the Machines view; the diagram's head opens the controller's node detail.
  await page.locator('#miniStats').click();
  await page.locator('#mxModal:not([hidden]) #caWrap:not([hidden]) .ca-node.head .ca-name').click();
  await page.locator('#nodeModal:not([hidden]) #ndBody #serverDetails').waitFor();
  assert.equal(await page.locator('.modal:not([hidden])').count(), 1, 'one window (the Machines view), no separate Server details');
  assert.match(await page.locator('#ndSub').textContent(), /^This server · the head/);
  const charts = async () => page.evaluate(() => ['cpu', 'mem'].map((k) => document.querySelector(`#ndBody #t-${k} .sline path.line`)?.getAttribute('d') || ''));
  for (const k of ['cpu', 'mem', 'disk', 'net']) assert.equal(await page.locator(`#ndBody #t-${k}`).isVisible(), true, `the ${k} tile`);
  await page.waitForFunction(() => ['cpu', 'mem'].every((k) => document.querySelector(`#ndBody #t-${k} .sline path.line`)?.getAttribute('d')?.startsWith('M')), null, { timeout: 20000 });
  assert.match(await page.locator('#ndBody #t-cpu .big').textContent(), /^\d+%$/, 'the live CPU reading');
  // Sections in order: charts, Running here, Top processes, then the log.
  const order = await page.evaluate(() => [...document.querySelectorAll('#ndBody #mGrid, #ndBody #ndRun, #ndBody #mTopCard, #ndBody #ndLog')].map((e) => e.id));
  assert.deepEqual(order, ['mGrid', 'ndRun', 'mTopCard', 'ndLog']);
  await page.locator('#mTop tbody tr').first().waitFor();
  // A worker from the diagram: its tiles in the same order and style, then back to this server.
  const vps = (await call('/api/cluster/nodes')).body.nodes.find((n) => n.connected && !n.local);
  await page.locator(`#caWrap .ca-node[data-node="${vps.id}"] .ca-name`).click();
  await page.locator('#ndTitle', { hasText: vps.name }).waitFor();
  assert.equal(await page.locator('#ndBody #serverDetails').count(), 0, "this server's details are parked");
  assert.deepEqual(await page.locator('#ndCharts .m-card').evaluateAll((els) => els.map((e) => e.dataset.chart)), ['cpu', 'mem', 'disk', 'net', 'load']);
  assert.equal(await page.locator('#ndCharts [data-chart="cpu"] .big').count(), 1);
  assert.equal(await page.locator('#ndBack').isVisible(), true);
  await page.locator('#ndBack').click();
  await page.locator('#ndBody #serverDetails').waitFor();
  // Clicking the controller node keeps its charts in the node detail.
  await page.locator('#caWrap .ca-node[data-node="controller"] .ca-name').click();
  assert.equal(await page.locator('#ndBack').isHidden(), true);
  assert.ok((await charts()).every((d) => d.startsWith('M')), 'the CPU and RAM charts are drawn');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#nodeModal').isHidden(), true);
  assert.equal(await page.evaluate(() => document.querySelector('#sdStash').contains(document.querySelector('#serverDetails'))), true);
  await ctx.close();
  assert.deepEqual(errors, []);
});
