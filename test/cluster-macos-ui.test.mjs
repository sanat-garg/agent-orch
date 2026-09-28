// The many-Macs UI (public/app.js): "Add machine" for 3 machines shows one code with the install lines, lists each Mac as
// it pairs and can revoke the code; a Mac card shows why its power policy pauses it and a Power panel whose menus save
// the policy, which reaches the worker as node.policy. Boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir); skips
// when Playwright's Chromium can't launch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';
import { PROTOCOL_VERSION, WS_PATH, FEATURE_LIST, createSender } from '../cluster-protocol.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'macos-ui-password';
let browser, noBrowser = false;
try { browser = await chromium.launch(); } catch (e) { noBrowser = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;
const sockets = [];
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const call = async (p, method = 'GET', body, auth = true) => {
  const r = await fetch(base + p, { method, headers: { ...(auth ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const claim = (code, name) => call('/api/cluster/claim', 'POST', { code, name, os: 'darwin', arch: 'arm64' }, false);

before(async () => {
  if (noBrowser) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-macos-ui-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1', AGENT_ORCH_MEMINFO: path.join(ROOT, 'test/fixtures/meminfo-ample') } });
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
});

after(async () => {
  for (const ws of sockets) ws.terminate();
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(ctxOpts) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(ctxOpts);
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/`);
  await page.locator('#miniStats').dispatchEvent('click'); // the sidebar is off-canvas on a phone
  await page.locator('#mMachines li').first().waitFor();
  return { ctx, page, errors };
}

test('Add machine for 3 Macs: one code, each Mac listed as it pairs, then revoked', { skip: noBrowser, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1280, height: 900 } });
  await page.locator('#addMachine').click();
  await page.locator('#amBody pre.am-cmd').nth(1).waitFor();
  await page.locator('#amUses').selectOption('3');
  await page.locator('.am-status', { hasText: '0 of 3 paired' }).waitFor();
  assert.match(await page.locator('.am-uses').textContent(), /valid 1 hour/);
  const mac = await page.locator('#amBody pre.am-cmd').nth(1).getAttribute('data-copy');
  const code = mac.match(/--code (\S+)/)[1];
  assert.equal(mac, `curl -fsSL ${base}/install/worker-macos.sh | sudo bash -s -- --controller ${base} --code ${code} --agents claude,codex`);
  const p = (await call(`/api/cluster/pair/${code}`)).body;
  assert.deepEqual([p.state, p.uses, p.used], ['waiting', 3, 0], 'the wizard made a code for 3 machines');
  assert.match(await page.locator('.am-note').first().textContent(), /same line on each machine/);
  // Two Macs pair with it: the 'cluster' push shows each by name; the install lines stay for the third.
  assert.equal((await claim(code, 'MacBook Pro (Sanat-MBP-2)')).status, 200);
  assert.equal((await claim(code, 'MacBook Air (Sanat-MBA)')).status, 200);
  await page.locator('.am-list li', { hasText: 'MacBook Air (Sanat-MBA)' }).waitFor({ timeout: 10000 });
  assert.deepEqual(await page.locator('.am-list .am-name').allTextContents(), ['MacBook Pro (Sanat-MBP-2)', 'MacBook Air (Sanat-MBA)']);
  assert.match(await page.locator('.am-status').textContent(), /2 of 3 paired/);
  assert.equal(await page.locator('#amBody pre.am-cmd').count(), 2);
  // Revoke: no third machine can use it.
  await page.locator('.am-acts button', { hasText: 'Revoke code' }).click();
  await page.locator('.am-status', { hasText: 'Code revoked: 2 of 3 paired' }).waitFor();
  assert.equal(await page.locator('#amBody pre.am-cmd').count(), 0);
  assert.equal((await claim(code, 'MacBook Pro (late)')).status, 401);
  // Reopened: a fresh one-time code (the revoked one isn't shown again).
  await page.keyboard.press('Escape');
  await page.locator('#addMachine').click();
  await page.locator('.am-status', { hasText: 'Waiting for the machine to connect' }).waitFor();
  assert.equal(await page.locator('#amUses').inputValue(), '1');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('a Mac card: Paused with its reason, and a Power panel that saves the policy to the worker', { skip: noBrowser, timeout: 60000 }, async () => {
  const GB = 2 ** 30;
  const { body: { code } } = await call('/api/cluster/pair', 'POST');
  const { body: { node, token } } = await claim(code, 'MacBook Air (Kitchen)');
  const ws = new WebSocket(base.replace('http', 'ws') + WS_PATH, { headers: { authorization: `Bearer ${token}` } });
  sockets.push(ws);
  const frames = [], sender = createSender('w'), tx = (t, f) => ws.readyState === 1 && ws.send(sender(t, f));
  ws.on('message', (d) => { const f = JSON.parse(d); frames.push(f); if (f.t === 'heartbeat') tx('heartbeat'); });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  tx('hello', { node, protocol: PROTOCOL_VERSION, version: 'test', jobs: [], features: FEATURE_LIST });
  await waitFor(() => frames.find((f) => f.t === 'welcome'), { timeout: 5000 });
  tx('inventory', { node, name: 'MacBook Air (Kitchen)', os: 'darwin', arch: 'arm64', cores: 8, mem: 16 * GB, versions: {}, agents: [{ id: 'claude', installed: true, signedIn: true }] });
  tx('resources', { memAvailable: 9 * GB, load: [1, 1, 1], running: [], battery: { pct: 42, charging: false, source: 'battery' },
    intake: { ok: false, reason: 'battery', text: 'On battery at 42%: takes new tasks above 50%' }, awake: false });

  const { ctx, page, errors } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const card = page.locator('.mc-node', { hasText: 'MacBook Air (Kitchen)' });
  await card.locator('.mc-st', { hasText: 'Paused' }).waitFor({ timeout: 10000 });
  assert.match(await card.textContent(), /On battery at 42%: takes new tasks above 50%\. Its running tasks go on\./);
  // Auto on a Mac: min(cores − 1, (9 GB free − 3 GB kept for its owner) / 1.2 GB per run) = 5.
  assert.match(await card.textContent(), /Running · 0 of 5 slots/);
  await card.locator('button[data-act="power"]').click();
  const panel = card.locator('.mc-power');
  await panel.waitFor();
  assert.equal(await card.locator('button[data-act="power"]').getAttribute('aria-expanded'), 'true');
  assert.equal(await panel.locator('select[data-act="policy-minBattery"]').inputValue(), '50');
  assert.equal(await panel.locator('select[data-act="policy-reserveGB"]').inputValue(), '3');
  await panel.locator('select[data-act="policy-minBattery"]').selectOption({ label: 'Above 25%' });
  const sent = await waitFor(() => frames.find((f) => f.t === 'node.policy'), { timeout: 10000, message: 'node.policy frame' });
  assert.deepEqual(sent.policy, { minBattery: 25, keepAwake: 'ac', thermal: 'heavy', reserveGB: 3, maxTasks: null });
  assert.equal((await call('/api/cluster/nodes')).body.nodes.find((n) => n.id === node).policy.minBattery, 25);
  await panel.locator('select[data-act="policy-keepAwake"]').selectOption('"always"');
  await waitFor(() => frames.filter((f) => f.t === 'node.policy').at(-1).policy.keepAwake === 'always', { timeout: 10000, message: 'keepAwake' });
  // The worker, now within its policy, reports intake again: the card is Online, the panel still open.
  tx('resources', { memAvailable: 9 * GB, load: [1, 1, 1], running: [], battery: { pct: 42, charging: false, source: 'battery' }, intake: { ok: true }, awake: false });
  await page.locator('#ndTitle').click(); // leave the menu: a render waits while it has focus
  await card.locator('.mc-st', { hasText: 'Online' }).waitFor({ timeout: 15000 });
  assert.equal(await card.locator('.mc-power').count(), 1);
  const fits = await page.evaluate(() => [...document.querySelectorAll('.mc-node')].every((c) => c.scrollWidth <= c.clientWidth + 1)
    && document.documentElement.scrollWidth <= innerWidth);
  assert.ok(fits, 'the cards and their Power panel fit 390px');
  await ctx.close();
  assert.deepEqual(errors, []);
});
