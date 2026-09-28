// The sidebar machine card (app.js MINI) rotating through the head and every online worker, with fake nodes.
// In Node: app.js's rotation block (from `const MINI` to miniClick) with mock timers: the order (head first, offline and
// disabled workers skipped, offline ones counted), a step every MINI_MS, a hold while hovered/focused, a dot's jump
// (which restarts the full interval), one machine without a timer, and the click opening the machine shown.
// In a browser: boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) with GET /api/cluster/nodes answered by the same
// fake nodes, then checks the card's rotation, dots, fixed height, hover hold, the click and reduced motion. The browser
// part skips when Playwright's Chromium can't launch.
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
const GB = 2 ** 30;
const node = (id, name, os, extra = {}) => ({
  id, name, os, arch: 'arm64', local: false, connected: true, enabled: true, status: 'online', draining: false, lastSeen: Date.now() - 5000,
  inventory: { cores: 4, mem: 16 * GB, agents: [{ id: 'claude', installed: true, signedIn: true }] },
  resources: { memAvailable: 8 * GB, load: [1, 1, 1], cpu: [20, 30, 40, 50], at: Date.now() }, tasks: [], used: 0, slots: 2,
  drops: null, update: null, policy: null, ...extra,
});
const task = (id, title) => ({ id, title, project: 'Seeded', agent: 'claude', model: 'opus', started_at: Math.floor(Date.now() / 1000) - 60 });
const HEAD = node('controller', 'oracle-vm', 'linux', { local: true, tasks: [task(11, 'Plan the next push')], used: 1,
  inventory: { cores: 4, mem: 24 * GB, agents: [] } });
const NODES = [
  HEAD,
  node('n-vps', 'build-vps', 'linux', { tasks: [task(12, 'Build'), task(13, 'Test')], used: 2,
    inventory: { cores: 4, mem: 24 * GB, agents: [] }, resources: { memAvailable: 6 * GB, load: [2, 2, 2], cpu: [70, 60, 50, 60], at: Date.now() } }),
  node('n-old', 'old-vps', 'linux', { connected: false, away: 'lost', awayLabel: 'connection lost' }),
  node('n-mac', 'studio-mac', 'darwin', { inventory: { cores: 10, mem: 32 * GB, agents: [] }, resources: { memAvailable: 20 * GB, load: [1, 1, 1], cpu: Array(10).fill(10), at: Date.now() } }),
  node('n-off', 'spare-vps', 'linux', { enabled: false }),
];

// ---- the rotation block, straight from app.js
const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const block = appJs.match(/^const MINI = .*?^function miniClick\(\) \{.*?^}$/ms)[0];
function load(nodes) {
  const calls = [], MC = { nodes };
  const mini = new Function('MC', 'miniRender', 'openServer', 'openNode', 'closeSidebar',
    `${block}\nreturn { MINI, MINI_MS, miniMachines, miniShown, miniNext, miniGo, miniArm, miniClick };`)(
    MC, () => calls.push('render'), () => calls.push('server'), (id) => calls.push(`node:${id}`), () => calls.push('closeSidebar'));
  return Object.assign(mini, { MC, calls, shown: () => mini.miniShown(mini.miniMachines(MC.nodes, 'Oracle VM').list).name });
}

test('rotation order: the head, then the online workers; offline ones are counted, disabled ones left out', () => {
  const m = load(NODES), { list, offline } = m.miniMachines(NODES, 'Oracle VM');
  assert.deepEqual(list.map((n) => n.name), ['oracle-vm', 'build-vps', 'studio-mac']);
  assert.equal(offline, 1);
  assert.equal(m.shown(), 'oracle-vm', 'starts at the head');
  assert.equal(m.MINI_MS, 5000);
  // Before GET /api/cluster/nodes answers, the head alone, named from /api/status.
  assert.deepEqual(m.miniMachines([], 'Oracle VM').list.map((n) => [n.id, n.name, n.local]), [['controller', 'Oracle VM', true]]);
});

test('each machine shows for MINI_MS, wrapping back to the head; hover/focus holds it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = load(NODES), seen = [m.shown()];
  m.miniArm();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(4999); assert.equal(m.shown(), seen.at(-1), 'not before 5 s'); t.mock.timers.tick(1); seen.push(m.shown()); }
  assert.deepEqual(seen, ['oracle-vm', 'build-vps', 'studio-mac', 'oracle-vm']);
  m.MINI.hold.add('hover');
  m.miniArm();
  t.mock.timers.tick(30000);
  assert.equal(m.shown(), 'oracle-vm', 'held while hovered');
  m.MINI.hold.add('focus');
  m.MINI.hold.delete('hover');
  m.miniArm();
  t.mock.timers.tick(30000);
  assert.equal(m.shown(), 'oracle-vm', 'held while focused');
  m.MINI.hold.delete('focus');
  m.miniArm();
  t.mock.timers.tick(5000);
  assert.equal(m.shown(), 'build-vps', 'moves on once released');
});

test('a dot jumps to its machine, which then gets its full interval', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = load(NODES);
  m.miniArm();
  t.mock.timers.tick(3000);
  m.miniGo(0, 'n-mac');
  assert.equal(m.shown(), 'studio-mac');
  assert.ok(m.calls.includes('render'), 'the jump paints');
  t.mock.timers.tick(4999);
  assert.equal(m.shown(), 'studio-mac');
  t.mock.timers.tick(1);
  assert.equal(m.shown(), 'oracle-vm', 'then on to the next (wrapping)');
  m.miniGo(0, 'n-vps');
  // A shown worker that goes offline: the card falls back to the head.
  m.MC.nodes = NODES.map((n) => (n.id === 'n-vps' ? { ...n, connected: false } : n));
  assert.equal(m.shown(), 'oracle-vm');
  assert.equal(m.miniNext(m.miniMachines(m.MC.nodes, '').list, 'n-vps'), 'controller');
});

test('one machine: no rotation', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = load([HEAD, NODES[2]]);
  assert.equal(m.miniMachines(m.MC.nodes, '').list.length, 1);
  m.miniArm();
  assert.equal(m.MINI.timer, null);
  t.mock.timers.tick(20000);
  assert.equal(m.shown(), 'oracle-vm');
});

test('a click opens the machine shown: Server details for the head, the node detail for a worker', () => {
  const m = load(NODES);
  m.miniClick();
  assert.deepEqual(m.calls, ['server']);
  m.calls.length = 0;
  m.miniGo(0, 'n-mac');
  m.miniClick();
  assert.deepEqual(m.calls.filter((c) => c !== 'render'), ['closeSidebar', 'node:n-mac']);
  clearTimeout(m.MINI.timer);
});

// ---- in a browser
const PASSWORD = 'mini-rotate-password';
let browser, noBrowser = false;
try { browser = await chromium.launch(); } catch (e) { noBrowser = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (noBrowser) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mini-rotate-'));
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

async function openApp(ctxOpts, nodes) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...ctxOpts });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/cluster/nodes', (route) => route.fulfill({ json: { nodes: nodes() } }));
  await page.route('**/api/cluster/nodes/*/metrics*', (route) => route.fulfill({ json: { samples: [] } }));
  await page.goto(`${base}/`);
  return { ctx, page, errors };
}
const shown = (page) => page.evaluate(() => [document.getElementById('hostName').textContent,
  [...document.querySelectorAll('#miniDots .ms-dot')].findIndex((d) => d.getAttribute('aria-current') === 'true')]);

test('UI: the card rotates head → workers with dots, keeps its size, holds on hover, and a click opens the shown machine', { skip: noBrowser, timeout: 90000 }, async () => {
  const { ctx, page, errors } = await openApp({}, () => NODES);
  await page.locator('#miniDots .ms-dot').nth(2).waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#miniDots .ms-dot').count(), 3, 'a dot per online machine');
  assert.deepEqual(await shown(page), ['oracle-vm', 0]);
  assert.equal(await page.locator('#miniRole').isVisible(), true, 'the head says so');
  assert.equal(await page.locator('#miniOff').textContent(), '+1 offline');
  assert.equal(await page.locator('#miniTasks').textContent(), '1 task running');
  const card = page.locator('#miniMachine'), h0 = (await card.boundingBox()).height;
  await page.mouse.move(640, 880); // well away from the card
  await page.locator('#hostName', { hasText: 'build-vps' }).waitFor({ timeout: 8000 });
  assert.deepEqual(await shown(page), ['build-vps', 1]);
  await page.locator('#miniTasks', { hasText: '2 tasks running' }).waitFor();
  assert.match(await page.locator('#miniMem').textContent(), /^18\/24 GB$/);
  assert.equal(await page.locator('#miniRole').isVisible(), false);
  assert.equal(await page.locator('#miniOs svg').count(), 1, 'an OS icon');
  assert.equal((await card.boundingBox()).height, h0, 'the card keeps its height');
  await page.locator('#hostName', { hasText: 'studio-mac' }).waitFor({ timeout: 8000 });
  assert.deepEqual(await shown(page), ['studio-mac', 2]);
  await page.locator('#hostName', { hasText: 'oracle-vm' }).waitFor({ timeout: 8000 });
  assert.deepEqual(await shown(page), ['oracle-vm', 0], 'wraps back to the head');

  // A dot jumps (the pointer then rests on the card, which holds it there).
  await page.locator('#miniDots .ms-dot').nth(2).click();
  await page.locator('#hostName', { hasText: 'studio-mac' }).waitFor({ timeout: 2000 });
  await page.waitForTimeout(6500);
  assert.deepEqual(await shown(page), ['studio-mac', 2], 'held while hovered');

  await page.locator('#miniStats').click();
  await page.locator('#nodeModal:not([hidden])').waitFor();
  assert.equal(await page.locator('#ndTitle').textContent(), 'studio-mac');
  assert.equal(await page.locator('#ndBody #serverDetails').count(), 0, "a worker's detail, not this server's");
  await page.keyboard.press('Escape');
  await page.locator('#nodeModal').waitFor({ state: 'hidden' });
  await page.locator('#miniDots .ms-dot').first().click();
  await page.locator('#hostName', { hasText: 'oracle-vm' }).waitFor({ timeout: 2000 });
  await page.locator('#miniStats').click();
  await page.locator('#nodeModal:not([hidden]) #ndBody #serverDetails').waitFor(); // the head: this server's details
  assert.equal(await page.locator('#ndTitle').textContent(), 'oracle-vm');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('UI: reduced motion switches without a fade; one machine shows no dots', { skip: noBrowser, timeout: 60000 }, async () => {
  let nodes = NODES;
  const { ctx, page, errors } = await openApp({ reducedMotion: 'reduce' }, () => nodes);
  await page.locator('#miniDots .ms-dot').nth(2).waitFor({ timeout: 20000 });
  await page.locator('#miniDots .ms-dot').nth(1).click();
  assert.deepEqual(await page.evaluate(() => [document.getElementById('miniSlide').classList.contains('out'), document.getElementById('hostName').textContent]),
    [false, 'build-vps'], 'no cross-fade');
  assert.equal(await page.locator('#miniSlide').evaluate((e) => getComputedStyle(e).transitionDuration), '0s');

  nodes = [HEAD, NODES[2]];
  await page.reload();
  await page.locator('#miniOff', { hasText: '+1 offline' }).waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#miniDots').isHidden(), true, 'no dots for one machine');
  assert.equal(await page.locator('#hostName').textContent(), 'oracle-vm');
  await ctx.close();
  assert.deepEqual(errors, []);
});
