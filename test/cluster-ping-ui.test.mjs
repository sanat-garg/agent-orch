// The Ping button in the Machines view (public/app.js pingNode/pingBox; server.mjs POST /api/cluster/nodes/:id/ping and
// the unauthenticated GET /api/health): one per worker card plus 'Ping all', a connected Mac's summary with its failures
// in red and the hint, a disconnected Mac's last seen and its copyable test command. Boots server.mjs
// (CW_NO_ORCHESTRATOR=1, temp data dir); the browser part skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'ping-ui-password';
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
const DIAG = {
  host: 'head.example', dns: { ok: false, code: 'ENOTFOUND', error: 'getaddrinfo ENOTFOUND head.example', ms: 30 },
  head: { ok: false, url: 'https://head.example/api/health', code: 'ENOTFOUND', ms: 31 }, github: { ok: true, status: 200, ms: 90 }, conn: { since: 1, attempt: 2 },
};
// A paired Mac whose fake worker answers every ping with DIAG.
async function mac(name) {
  const { body: { code } } = await call('/api/cluster/pair', 'POST');
  const { body: { node, token } } = await call('/api/cluster/claim', 'POST', { code, name, os: 'darwin', arch: 'arm64' }, false);
  const ws = new WebSocket(base.replace('http', 'ws') + WS_PATH, { headers: { authorization: `Bearer ${token}` } });
  sockets.push(ws);
  const frames = [], sender = createSender('w'), tx = (t, f) => ws.readyState === 1 && ws.send(sender(t, f));
  ws.on('message', (d) => {
    const f = JSON.parse(d);
    frames.push(f);
    if (f.t === 'heartbeat') tx('heartbeat');
    if (f.t === 'ping') tx('pong', { id: f.id, diag: DIAG });
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  tx('hello', { node, protocol: PROTOCOL_VERSION, version: 'test', jobs: [], features: FEATURE_LIST });
  await waitFor(() => frames.find((f) => f.t === 'welcome'), { timeout: 5000 });
  return { node, ws, frames };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ping-ui-'));
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

test('the API: /api/health needs no session; POST …/ping needs one and answers a connected and a disconnected Mac', async () => {
  const h = await call('/api/health', 'GET', undefined, false);
  assert.deepEqual([h.status, h.body], [200, { ok: true }]);
  const a = await mac('Ping API Mac');
  assert.equal((await call(`/api/cluster/nodes/${a.node}/ping`, 'POST', undefined, false)).status, 401);
  const r = await call(`/api/cluster/nodes/${a.node}/ping`, 'POST');
  assert.equal(r.status, 200);
  assert.equal(r.body.connected, true);
  assert.ok(r.body.parts.some((p) => p.bad && p.text === 'DNS failed (ENOTFOUND, 30 ms)'));
  a.ws.terminate();
  await waitFor(async () => (await call('/api/cluster/nodes')).body.nodes.find((n) => n.id === a.node)?.connected === false, { timeout: 10000 });
  const d = await call(`/api/cluster/nodes/${a.node}/ping`, 'POST');
  assert.deepEqual([d.status, d.body.connected, d.body.command], [200, false, `curl -sS -o /dev/null -w '%{http_code} %{time_total}s\\n' ${base}/api/health`]);
  await call(`/api/cluster/nodes/${a.node}`, 'DELETE');
});

test('a Ping button per worker card and Ping all: a chip group with a red pill per failure, a disconnected Mac\'s test command', { skip: noBrowser, timeout: 60000 }, async () => {
  const up = await mac('MacBook Air (Desk)');
  const away = await mac('MacBook Pro (Bag)');
  away.ws.terminate();
  await waitFor(async () => (await call('/api/cluster/nodes')).body.nodes.find((n) => n.id === away.node)?.connected === false, { timeout: 10000 });

  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage(), errors = [];
  // Server details' own charts can't read load averages on a macOS head (renderMetrics): not this view's concern.
  page.on('pageerror', (e) => { if (!/renderMetrics/.test(e.stack)) errors.push(e.message); });
  await page.goto(`${base}/`);
  await page.locator('#miniStats').dispatchEvent('click');
  const upCard = page.locator('.mc-node', { hasText: 'MacBook Air (Desk)' }), awayCard = page.locator('.mc-node', { hasText: 'MacBook Pro (Bag)' });
  await awayCard.waitFor();
  // One per worker card, under Machine settings → Manage → Check connection (the controller is this server: nothing to
  // ping), and Ping all in the header.
  for (const c of [upCard, awayCard]) await c.locator('summary[data-act="settings"]').click();
  assert.equal(await page.locator('.mc-node button[data-act="ping"]').count(), 2);
  assert.equal(await page.locator('.mc-node', { hasText: '(this server)' }).locator('button[data-act="ping"]').count(), 0);
  assert.equal(await upCard.locator('button[data-act="ping"]').textContent(), 'Check');
  assert.match(await awayCard.locator('.mc-row', { has: page.locator('button[data-act="ping"]') }).textContent(), /^Check connectionWhy it dropped, and a command to test from itCheck$/);
  assert.equal(await page.locator('#pingAll').isVisible(), true);

  await upCard.locator('button[data-act="ping"]').click();
  const chip = upCard.locator('.mc-ping .pg-pill').first();
  await chip.waitFor({ timeout: 10000 });
  assert.match(await upCard.locator('.mc-ping .pg-rtt').textContent(), /^\d+ ms$/);
  const pills = await upCard.locator('.mc-ping .pg-pill').evaluateAll((xs) => xs.map((x) => [x.className, x.title]));
  assert.deepEqual(pills, [['pg-pill bad', 'DNS failed (ENOTFOUND, 30 ms)'], ['pg-pill bad', 'head HTTPS failed (ENOTFOUND)'], ['pg-pill ok', 'GitHub ok']]);
  const dot = (i) => upCard.locator('.mc-ping .pg-dot').nth(i).evaluate((e) => getComputedStyle(e).backgroundColor);
  assert.notEqual(await dot(0), await dot(2), 'failures are coloured');
  // The hints open on a tap.
  assert.equal(await upCard.locator('.mc-ping .pg-det').isVisible(), false);
  await upCard.locator('.mc-ping button[data-act="ping-more"]').click();
  assert.match(await upCard.locator('.mc-ping .pg-det .mc-health.bad').first().textContent(), /^DNS lookup of the head failed on this Mac: its router or ISP can't resolve head\.example\./);

  await awayCard.locator('button[data-act="ping"]').click();
  await awayCard.locator('.mc-ping .pg-pill').waitFor({ timeout: 10000 });
  assert.match(await awayCard.locator('.mc-ping .pg-hint').textContent(), /^Last seen .* · connection lost$/);
  await awayCard.locator('.mc-ping button[data-act="ping-more"]').click();
  const cmd = awayCard.locator('.mc-cmd code');
  assert.equal(await cmd.textContent(), `curl -sS -o /dev/null -w '%{http_code} %{time_total}s\\n' ${base}/api/health`);
  assert.match(await awayCard.locator('.mc-ping').textContent(), /Drops in the last 24 h: 1 \(unexplained 1\)/);

  // Ping all asks every worker again.
  const before = up.frames.filter((f) => f.t === 'ping').length;
  await page.locator('#pingAll').click();
  await waitFor(() => up.frames.filter((f) => f.t === 'ping').length > before, { timeout: 10000, message: 'Ping all reached the connected Mac' });
  await upCard.locator('.mc-ping .pg-pill').first().waitFor({ timeout: 10000 });
  if (process.env.PING_SHOT) await page.locator('#mMachines').screenshot({ path: process.env.PING_SHOT });
  await ctx.close();
  assert.deepEqual(errors, []);
});
