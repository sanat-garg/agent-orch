// The "Add machine" wizard (Server details → Machines): the pairing API flow (POST /api/cluster/pair → GET
// /api/cluster/pair/:code waiting → a worker claims it → paired), the install scripts served at /install/…, and the UI
// showing a one-line command per OS with the fresh code that flips to "Paired: <name>" once the code is claimed.
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
import { chromium } from 'playwright-core';

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
  assert.equal(await page.locator('#serverModal').isVisible(), true, 'Escape closes only the wizard');
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
