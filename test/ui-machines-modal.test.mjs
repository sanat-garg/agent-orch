// The Machines window on a desktop (#480) against an isolated server (CW_NO_ORCHESTRATOR=1, temp data dir) with the head
// and three fake workers: at 1440×900 it is a wide window with a margin and a backdrop (not full screen), titled
// 'Machines', its four machine cards around the star (#498), and the head's KPIs and charts (#serverDetails) show only
// once the head is clicked in the graph, in its side panel. Esc and the backdrop close it.
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
import { PROTOCOL_VERSION, WS_PATH, createSender } from '../cluster-protocol.mjs';
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'machines-modal-password';
const CID = 'chat-fleet';
const GB = 2 ** 30;
const mac = macChromiumEnv();
let browser, skip = false;
try {
  browser = await chromium.launch(mac.AGENT_ORCH_BROWSER_PATH ? { executablePath: mac.AGENT_ORCH_BROWSER_PATH, env: { ...process.env, ...mac } } : {});
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;
const workers = [];

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const call = async (p, method = 'GET', body, auth = true) => {
  const r = await fetch(base + p, { method, headers: { ...(auth ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
async function fakeWorker(name, kind, cores) {
  const { body: { code } } = await call('/api/cluster/pair', 'POST');
  const { body: { node, token } } = await call('/api/cluster/claim', 'POST', { code, name, os: kind, arch: 'arm64' }, false);
  const ws = new WebSocket(base.replace('http', 'ws') + WS_PATH, { headers: { authorization: `Bearer ${token}` } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const sender = createSender('w'), tx = (t, f) => ws.readyState === 1 && ws.send(sender(t, f));
  tx('hello', { node, protocol: PROTOCOL_VERSION, version: 'test', jobs: [] });
  tx('inventory', { node, name, os: kind, arch: 'arm64', cores, mem: 16 * GB, versions: {}, agents: [{ id: 'claude', installed: true, signedIn: true }] });
  tx('resources', { memAvailable: 8 * GB, load: [1, 1, 1], running: [] });
  const beat = setInterval(() => tx('heartbeat'), 2000);
  beat.unref();
  workers.push(ws);
  return node;
}

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mxmodal-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Fleet', cwd: path.join(dataDir, 'fleet'), mode: 'orchestrator',
    agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true, fallbacks: [] }]));
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
  await fakeWorker('build-vps', 'linux', 4);
  await fakeWorker('studio-mac', 'darwin', 10);
  await fakeWorker('air-mac', 'darwin', 8);
});

after(async () => {
  await browser?.close();
  for (const ws of workers) ws.terminate();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const box = (page, sel) => page.locator(sel).evaluate((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; });

test('desktop 1440×900: a wide window titled Machines, four cards in a row, the head KPIs only after a click', { skip, timeout: 60000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${CID}`);
  await page.locator('#machinesBtn').click();
  await page.locator('#mxModal:not([hidden]) #caWrap:not([hidden]) .cc').nth(3).waitFor();
  await page.evaluate(() => Promise.all(document.querySelector('#mxModal .mx-panel').getAnimations().map((a) => a.finished.catch(() => {}))));

  // A centred window with a margin all round, min(1400px, 96vw) wide and at most 90vh tall, over a backdrop.
  const panel = await box(page, '#mxModal .mx-panel');
  assert.ok(Math.abs(panel.w - 1382) <= 1, `96vw wide: ${JSON.stringify(panel)}`);
  assert.ok(panel.h <= 810 + 1 && panel.t >= 24 && panel.l >= 24 && 1440 - panel.r >= 24 && 900 - panel.b >= 24, `not full screen: ${JSON.stringify(panel)}`);
  assert.ok(Math.abs(panel.l - (1440 - panel.r)) <= 1 && Math.abs(panel.t - (900 - panel.b)) <= 1, 'centred');
  assert.equal(await page.locator('#mxModal > .modal-backdrop').isVisible(), true);

  // Titled 'Machines', not the server's name.
  assert.equal((await page.locator('#mxTitle').textContent()).trim(), 'Machines');
  assert.equal(await page.locator('#mxModal [role="dialog"]').first().getAttribute('aria-labelledby'), 'mxTitle');

  // The four machines' cards around the star, none overlapping, all inside the window.
  await page.waitForFunction(() => document.querySelectorAll('#caWrap .cc').length === 4 && [...document.querySelectorAll('#caWrap .cc')].every((c) => c.getAnimations().length === 0));
  const cards = (await page.locator('#caWrap .cc').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; })))
    .sort((a, b) => a.l - b.l);
  for (const a of cards) for (const b of cards) if (a !== b) assert.ok(!(a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t), `no overlap: ${JSON.stringify(cards)}`);
  cards.sort((a, b) => a.r - b.r);
  const main = await box(page, '#mxMain');
  assert.ok(cards[0].l >= main.l && cards[3].r <= main.r && cards[0].l >= panel.l, `inside the window: ${JSON.stringify({ cards, main })}`);
  assert.equal(await page.locator('#caWrap .cc [data-act="assign"]').count(), 4, 'Assign task stays');

  // By default: the summary, the graph and the queue, but none of the head's KPIs or charts.
  assert.match(await page.locator('#mcSum').textContent(), /^Cluster: 4 machines/);
  assert.equal(await page.locator('#mxQueue').isVisible(), true);
  assert.equal(await page.locator('#serverDetails').isVisible(), false);
  assert.equal(await page.evaluate(() => document.querySelector('#sdStash').contains(document.querySelector('#serverDetails'))), true);
  assert.equal(await page.locator('#nodeModal').isHidden(), true);

  // Clicking the head in the graph brings them, in its side panel, like any machine.
  await page.locator('#caWrap .cc.head .cc-open').click();
  await page.locator('#mxModal #nodeModal:not([hidden]) #ndBody #serverDetails').waitFor();
  assert.equal(await page.locator('#serverDetails').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#serverDetails').isVisible(), false);
  assert.equal(await page.locator('#mxModal').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#mxModal').isHidden(), true);

  // The backdrop closes it too.
  await page.locator('#machinesBtn').click();
  await page.locator('#mxModal:not([hidden])').waitFor();
  await page.mouse.click(8, 450);
  assert.equal(await page.locator('#mxModal').isHidden(), true);
  await ctx.close();
  assert.deepEqual(errors, []);
});
