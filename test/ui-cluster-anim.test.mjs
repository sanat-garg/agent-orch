// The Machines view's cluster diagram (app.js CA) in a real browser. Boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data
// dir) with fake workers on real sockets (two online Linux VPSes, a draining Mac, an asleep Mac and a machine that never
// connected) and running tasks seeded in the DB, then plays the orchestrator's part: task pushes (otask) and lane
// activity (olane) go into the page's socket (Playwright routeWebSocket) and remote phases are patched into GET
// /api/cluster/nodes (the orchestrator, which tracks them, is off here). Checks the layout and states, a dispatch →
// phase cross-fade → merge cycle (the chip reaches the head, which checks it off), the particle throttle, the phone
// list, reduced motion, the pause while hidden and the node detail (charts, phases, log tail). Skips the browser part
// when Playwright's Chromium can't launch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';
import { PROTOCOL_VERSION, WS_PATH, FEATURE_LIST, createSender } from '../cluster-protocol.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'cluster-anim-password';
const GB = 2 ** 30;
let browser, noBrowser = false;
try { browser = await chromium.launch(); } catch (e) { noBrowser = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, pid;
const sockets = [], W = {}, T = {};
const phases = new Map(); // task id → the phase GET /api/cluster/nodes reports for it (what job.phase would have set)

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const call = async (p, method = 'GET', body, auth = true) => {
  const r = await fetch(base + p, { method, headers: { ...(auth ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  return r.json();
};
const db = () => { const d = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db')); d.exec('PRAGMA busy_timeout=5000'); return d; };
// A fake worker: pairs, dials in, reports inventory and telemetry, answers heartbeats and log-tail requests.
async function fakeWorker(name, kind, { cores = 4, avail = 8 * GB, cpu = [20, 20, 20, 20], connect = true } = {}) {
  const { code } = await call('/api/cluster/pair', 'POST');
  const { node, token } = await call('/api/cluster/claim', 'POST', { code, name, os: kind, arch: 'arm64' }, false);
  if (!connect) return { node };
  const ws = new WebSocket(base.replace('http', 'ws') + WS_PATH, { headers: { authorization: `Bearer ${token}` } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  sockets.push(ws);
  const sender = createSender('w'), tx = (t, f = {}) => ws.readyState === 1 && ws.send(sender(t, f));
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.t === 'heartbeat') tx('heartbeat');
    if (m.t === 'logs.tail') tx('logs', { req: m.req, lines: [`${name} worker started`, 'job 1: running agent', 'job 1: pushed agent-orch/task-1'] });
  });
  tx('hello', { node, protocol: PROTOCOL_VERSION, version: '1.0.0', jobs: [], features: FEATURE_LIST });
  tx('inventory', { node, name, os: kind, arch: 'arm64', cores, mem: 16 * GB, versions: {}, agents: [{ id: 'claude', installed: true, signedIn: true }] });
  const res = () => tx('resources', { memAvailable: avail, load: [1, 1, 1], running: [], swapUsedPct: 0, cpu });
  return { node, ws, tx, res };
}
const seed = (title, node, ago = 60) => Number(db().prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,agent,ran_agent,ran_model,started_at,created_at,node_id) VALUES(?,'work',?,'seed','running','claude','claude','opus',?,0,?)")
  .run(pid, title, Math.floor(Date.now() / 1000) - ago, node).lastInsertRowid);

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cluster-anim-'));
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

  W.vps = await fakeWorker('build-vps', 'linux', { cpu: [62, 48, 55, 40] });
  W.gpu = await fakeWorker('gpu-vps', 'linux', { cores: 8, avail: 12 * GB, cpu: [8, 4, 6, 3, 5, 2, 9, 4] });
  W.studio = await fakeWorker('studio-mac', 'darwin', { cores: 10, cpu: Array(10).fill(30) });
  W.air = await fakeWorker('macbook-air', 'darwin');
  W.old = await fakeWorker('old-vps', 'linux', { connect: false });
  await call(`/api/cluster/nodes/${W.studio.node}`, 'PATCH', { draining: true });
  W.air.ws.terminate(); // a Mac that goes silent without a bye is 'lost' (see the moon below)
  // A few telemetry frames: build-vps's chart has a line to draw.
  for (let i = 0; i < 3; i++) { W.vps.res(); W.gpu.res(); await sleep(120); }
  await waitFor(async () => (await call('/api/cluster/nodes')).nodes.find((n) => n.id === W.air.node)?.away === 'lost', { timeout: 10000, message: 'macbook-air lost' });

  const d = db();
  // Asleep is only known after the fact now; a row an older head marked asleep still wears the moon.
  d.prepare("UPDATE nodes SET away='asleep' WHERE id=?").run(W.air.node);
  pid = Number(d.prepare("INSERT INTO projects(path,name,status,created_at) VALUES(?,?,'active',0)").run(path.join(dataDir, 'proj'), 'Seeded').lastInsertRowid);
  d.close();
  T.vps = seed('Report worker phases', W.vps.node, 300);
  T.local = seed('Plan the next push', 'controller', 90);
  phases.set(T.vps, 'running');
  const at = Date.now() - 290_000;
  db().prepare("INSERT INTO runs(task_id,purpose,agent,node_id,started_at,phases) VALUES(?,'work','claude',?,?,?)").run(T.vps, W.vps.node, Math.floor(at / 1000),
    JSON.stringify([{ phase: 'queued', at, w: at, ms: 400 }, { phase: 'fetching', at: at + 400, w: at + 400, ms: 3100 }, { phase: 'installing', at: at + 3500, w: at + 3500, ms: 41_000 },
      { phase: 'running', at: at + 44_500, w: at + 44_500, progress: { tools: 12, files: 3, last: 'Bash · npm test' } }]));
});

after(async () => {
  for (const ws of sockets) ws.terminate();
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// The Machines view open with the diagram drawn. `push(msg)` sends a frame down the page's socket, as the server would.
async function openDiagram(ctxOpts) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(ctxOpts);
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript(() => localStorage.setItem('cw.mx.diagram', '1')); // phones show it behind 'Show diagram' (#433)
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let sock;
  await page.routeWebSocket(/\/ws$/, (ws) => { ws.connectToServer(); sock = ws; });
  await page.route('**/api/cluster/nodes', async (route) => {
    const res = await route.fetch().catch(() => null); // a live re-read still in flight when the test closes its page
    if (!res) return;
    const body = await res.json().catch(() => null);
    if (!body) return;
    for (const n of body.nodes) for (const t of n.tasks) if (phases.has(t.id)) t.phase = phases.get(t.id);
    await route.fulfill({ response: res, json: body }).catch(() => {});
  });
  await page.goto(`${base}/`);
  await page.locator('#miniStats').dispatchEvent('click'); // the Machines view; the sidebar is off-canvas on a phone
  const count = (await call('/api/cluster/nodes')).nodes.length;
  await waitFor(() => page.locator('#caWrap .ca-node').count().then((n) => n === count), { timeout: 15000, message: 'the diagram draws every node' });
  await waitFor(() => sock, { message: 'the page socket is routed' });
  const push = (msg) => sock.send(JSON.stringify(msg));
  const otask = async (id) => push({ t: 'otask', task: (await call(`/api/orch/task/${id}`)).task }); // what pushTask broadcasts
  return { ctx, page, errors, push, otask };
}
// A node's centre in the drawing.
const nodeAt = (page, id) => page.locator(`#caWrap .ca-node[data-node="${id}"]`).evaluate((g) => g.getAttribute('transform').match(/[-\d.]+/g).map(Number));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// How far a point is from a polyline (the route a chip should follow).
const offPath = (p, pts) => Math.min(...pts.slice(1).map((b, i) => {
  const a = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return dist(p, [a[0] + dx * t, a[1] + dy * t]);
}));
// Records every position, opacity and phase-word opacity a chip is drawn with from now on (a MutationObserver sees each
// frame's writes and the last one before the chip is removed, however slowly frames come).
const watchChip = (page, id) => page.evaluate((id) => {
  const rec = window.__chip = { id: String(id), samples: [] }, layer = document.querySelector('#caWrap .ca-chips'), sel = `.ca-chip[data-task="${rec.id}"]`;
  new MutationObserver((ms) => {
    if (window.__chip !== rec) return;
    const g = layer.querySelector(sel) || ms.flatMap((m) => [...m.removedNodes]).find((n) => n.matches?.(sel));
    if (!g?.hasAttribute('transform')) return;
    const [x, y] = g.getAttribute('transform').match(/[-\d.]+/g).map(Number);
    const s = { x, y, o: Number(g.getAttribute('opacity')), ph: [...g.querySelectorAll('.ca-ph')].map((t) => [t.textContent, Number(t.getAttribute('opacity'))]) };
    if (JSON.stringify(s) !== JSON.stringify(rec.samples.at(-1))) rec.samples.push(s);
    if (!g.isConnected) rec.gone = true;
  }).observe(layer, { subtree: true, childList: true, attributes: true });
}, id);
const chipLog = (page) => page.evaluate(() => window.__chip);
// A CSS colour as the page resolves it (to compare a theme variable with what the diagram paints).
const resolved = (page, v) => page.evaluate((v) => { const d = document.createElement('div'); d.style.color = `var(${v})`; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; }, v);

test('the diagram: the head in the middle, a node per worker with its state, and chips for running tasks', { skip: noBrowser, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await openDiagram({ viewport: { width: 1280, height: 900 } });
  const nodes = (await call('/api/cluster/nodes')).nodes;
  assert.deepEqual(await page.locator('#caWrap .ca-node').evaluateAll((els) => els.map((e) => e.dataset.node)), nodes.map((n) => n.id));
  const head = await nodeAt(page, 'controller'), width = await page.locator('#caWrap svg.ca').evaluate((s) => s.viewBox.baseVal.width);
  assert.ok(head[0] > width / 3 && head[0] < (2 * width) / 3, `the head sits in the middle: ${head[0]} of ${width}`);
  const around = await Promise.all(nodes.filter((n) => !n.local).map((n) => nodeAt(page, n.id)));
  assert.ok(around.some((p) => p[0] < head[0] - 100) && around.some((p) => p[0] > head[0] + 100) && around.some((p) => p[1] < head[1] - 60), 'workers surround it');
  assert.equal(await page.locator('#caWrap .ca-link').count(), nodes.length - 1, 'one link per worker');

  // States: offline and asleep grey with a dashed link, the asleep Mac's moon, the draining Mac's amber ring.
  const node = (id) => page.locator(`#caWrap .ca-node[data-node="${id}"]`);
  for (const id of [W.old.node, W.air.node]) assert.match(await node(id).getAttribute('class'), /\boff\b/);
  assert.equal(await page.locator('#caWrap .ca-link.off').count(), 2);
  assert.notEqual(await page.locator('#caWrap .ca-link.off').first().evaluate((p) => getComputedStyle(p).strokeDasharray), 'none');
  assert.match(await node(W.air.node).getAttribute('class'), /\basleep\b/);
  await waitFor(async () => (await node(W.air.node).locator('.ca-moon').evaluate((m) => getComputedStyle(m).opacity)) === '1', { timeout: 3000, message: 'the moon fades in' });
  assert.equal(await node(W.vps.node).locator('.ca-moon').evaluate((m) => getComputedStyle(m).opacity), '0');
  assert.match(await node(W.studio.node).getAttribute('class'), /\bdraining\b/);
  const drain = node(W.studio.node).locator('.ca-drain');
  assert.equal(await drain.evaluate((c) => getComputedStyle(c).opacity), '1');
  assert.equal(await drain.evaluate((c) => getComputedStyle(c).stroke), await resolved(page, '--warn'));
  // Gauges: CPU (mean of the cores) and RAM in the theme's accent, in words on its card too (from 768px).
  assert.deepEqual(await page.locator(`#caWrap .cc[data-node="${W.vps.node}"] .cc-m .v`).allTextContents(), ['51%', '50%']);
  assert.equal(await node(W.gpu.node).locator('.ca-gauge').first().evaluate((c) => getComputedStyle(c).stroke), await resolved(page, '--accent'));
  assert.match(await node(W.vps.node).getAttribute('aria-label'), /^build-vps: Online, CPU 51% · RAM 50%, 1 task running\. Show details$/);
  // Running tasks are rows on their machine's card; their chips rest hidden at the card's edge by the machine (drawn as
  // they are on the first look, not dispatched again), only travelling when they move.
  await page.locator(`#caWrap .cc[data-node="${W.vps.node}"] .cc-task[data-task="${T.vps}"]`).waitFor();
  const chip = page.locator(`#caWrap .ca-chip[data-task="${T.vps}"]`);
  assert.equal(await chip.getAttribute('data-phase'), 'running');
  assert.equal(await chip.getAttribute('opacity'), '0.000');
  const [cx, cy] = (await chip.getAttribute('transform')).match(/[-\d.]+/g).map(Number), vps = await nodeAt(page, W.vps.node);
  assert.ok(dist([cx, cy], vps) < 60, 'the chip rests by its machine');
  assert.equal(await page.locator(`#caWrap .ca-chip[data-task="${T.local}"]`).getAttribute('data-phase'), 'running');
  assert.equal(await page.evaluate(() => CA.anims.size), 0, 'nothing moves on the first look');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('dispatch → merge: a chip travels head → worker, cross-fades its phases, then returns and merges into the head with a check', { skip: noBrowser, timeout: 90000 }, async () => {
  const { ctx, page, errors, push, otask } = await openDiagram({ viewport: { width: 1280, height: 900 } });
  const head = await nodeAt(page, 'controller'), gpu = await nodeAt(page, W.gpu.node);
  // Dispatch: the task starts on gpu-vps (its otask push makes the page re-read the machines).
  const id = seed('Animate the cluster diagram', W.gpu.node);
  phases.set(id, 'installing');
  await watchChip(page, id);
  await otask(id);
  const chip = page.locator(`#caWrap .ca-chip[data-task="${id}"]`);
  await chip.waitFor({ state: 'attached', timeout: 10000 });
  await waitFor(() => page.evaluate(() => CA.anims.size === 0 && window.__chip.samples.length > 0), { timeout: 15000, message: 'the dispatch settles' });
  await page.locator(`#caWrap .cc[data-node="${W.gpu.node}"] .cc-task[data-task="${id}"]`).waitFor();
  let log = await chipLog(page);
  const first = log.samples[0], rest = log.samples.at(-1), seat = [rest.x, rest.y];
  assert.ok(dist([first.x, first.y], head) < 1 && first.o === 0, `it leaves from the head, faded in from nothing: ${JSON.stringify(first)} vs ${head}`);
  assert.ok(dist(seat, gpu) < 60 && dist(seat, head) > 150 && rest.o === 0, `it fades into gpu-vps's card: ${JSON.stringify(rest)}`);
  assert.ok(log.samples.some((s) => s.o === 1), 'seen on its way');
  const off = Math.max(...log.samples.map((s) => offPath([s.x, s.y], [head, gpu, seat])));
  assert.ok(off < 1.5, `it travels along the link through its machine (at most ${off.toFixed(2)}px off)`);
  const moves = new Set(log.samples.map((s) => `${Math.round(s.x)},${Math.round(s.y)}`));
  assert.ok(moves.size >= 4, `drawn in motion, not a jump (${moves.size} positions)`);
  assert.equal(await chip.getAttribute('data-phase'), 'installing');

  // Phase change: 'installing' cross-fades into 'running' (both words part-visible mid-fade).
  phases.set(id, 'running');
  await page.evaluate(() => { window.__chip.samples = []; });
  push({ t: 'cluster', kind: 'resources' });
  await waitFor(async () => (await chip.getAttribute('data-phase')) === 'running', { timeout: 10000, message: 'the chip shows running' });
  await waitFor(() => page.evaluate(() => CA.anims.size === 0), { timeout: 10000, message: 'the cross-fade ends' });
  log = await chipLog(page);
  const word = (s, w) => s.ph.find(([t]) => t === w)?.[1] ?? 0;
  assert.ok(log.samples.some((s) => word(s, 'installing') > 0.05 && word(s, 'installing') < 0.95 && word(s, 'running') > 0.05 && word(s, 'running') < 0.95), 'a frame shows both words part-way');
  const end = log.samples.at(-1);
  assert.equal(word(end, 'running'), 1);
  assert.equal(word(end, 'installing'), 0);

  // Merge: it finishes; the chip travels home, reaches the head and the head checks it off.
  db().prepare("UPDATE tasks SET status='done', finished_at=? WHERE id=?").run(Math.floor(Date.now() / 1000), id);
  await page.evaluate(() => { window.__chip.samples = []; window.__marks = []; const m = document.querySelector('#caWrap .ca-mark');
    new MutationObserver(() => window.__marks.push([m.getAttribute('class'), Number(m.getAttribute('opacity'))])).observe(m, { attributes: true }); });
  await otask(id);
  await waitFor(() => page.evaluate(() => window.__chip.gone), { timeout: 15000, message: 'the chip merges into the head' });
  log = await chipLog(page);
  const home = log.samples.at(-1), back = Math.max(...log.samples.map((s) => offPath([s.x, s.y], [seat, gpu, head])));
  assert.ok(dist([log.samples[0].x, log.samples[0].y], seat) < 1, 'it leaves from its seat');
  assert.ok(back < 1.5, `home along its link (at most ${back.toFixed(2)}px off)`);
  assert.ok(dist([home.x, home.y], head) < 1, `the chip reaches the head: ${JSON.stringify(home)} vs ${head}`);
  assert.ok(home.o < 0.05, 'and merges into it');
  assert.equal(await chip.count(), 0);
  await waitFor(() => page.evaluate(() => window.__marks.some(([c, o]) => /\bok\b/.test(c) && o > 0.9)), { timeout: 5000, message: 'the head shows a check' });
  await waitFor(() => page.evaluate(() => CA.anims.size === 0), { timeout: 10000, message: 'everything settles' });
  assert.equal(await page.locator('#caWrap .ca-mark').getAttribute('opacity'), '0.000', 'the check is brief');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('a heartbeat pulses the machine and its link; job events send particles worker → head, at most ~6 a second per link', { skip: noBrowser, timeout: 60000 }, async () => {
  const { ctx, page, errors, push } = await openDiagram({ viewport: { width: 1280, height: 900 } });
  // Heartbeat: gpu-vps reports (the server's 'cluster' push is coalesced to 5 s; this one comes at once).
  const gpuNode = page.locator(`#caWrap .ca-node[data-node="${W.gpu.node}"]`);
  const beats = Number(await gpuNode.getAttribute('data-beats') || 0);
  await page.evaluate((id) => {
    window.__glow = 0;
    const v = CA.nodes.get(id);
    new MutationObserver(() => { window.__glow = Math.max(window.__glow, Number(v.glow.style.opacity) || 0); }).observe(v.glow, { attributes: true });
    new MutationObserver(() => { window.__halo = Math.max(window.__halo || 0, Number(v.halo.getAttribute('opacity')) || 0); }).observe(v.halo, { attributes: true });
  }, W.gpu.node);
  W.gpu.res();
  await waitFor(async () => (await call('/api/cluster/nodes')).nodes.find((n) => n.id === W.gpu.node).resources.at > Date.now() - 2000, { message: 'the reading lands' });
  push({ t: 'cluster', kind: 'resources' });
  await waitFor(async () => Number(await gpuNode.getAttribute('data-beats')) === beats + 1, { timeout: 10000, message: 'gpu-vps beats' });
  await waitFor(() => page.evaluate(() => window.__glow > 0.5 && window.__halo > 0.3), { timeout: 5000, message: 'its halo and link glow' });
  assert.equal(await page.locator(`#caWrap .ca-node[data-node="${W.vps.node}"]`).getAttribute('data-beats'), null, 'only the machine that reported');
  await page.evaluate(() => {
    window.__dots = [];
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('ca-pt')) window.__dots.push(performance.now()); })
      .observe(document.querySelector('#caWrap .ca-dots'), { childList: true });
  });
  // 15 tool calls a second for a second on build-vps's task.
  for (let i = 0; i < 15; i++) { push({ t: 'olane', taskId: T.vps, activity: 'Bash · npm test' }); await sleep(66); }
  await sleep(500);
  const at = await page.evaluate(() => window.__dots), gaps = at.slice(1).map((t, i) => t - at[i]);
  assert.ok(at.length >= 2 && at.length <= 8, `particles for 15 events in 1 s: ${at.length}`);
  assert.ok(Math.min(...gaps) > 150, `at most ~6 a second: ${gaps.map(Math.round)} ms apart`);
  // They run along build-vps's link, from the worker to the head.
  await waitFor(() => page.evaluate(() => !document.querySelector('#caWrap .ca-dots circle')), { timeout: 5000, message: 'the particles land' });
  const head = await nodeAt(page, 'controller'), vps = await nodeAt(page, W.vps.node);
  const track = page.evaluate(() => new Promise((resolve) => {
    new MutationObserver((ms, obs) => {
      const d = ms.flatMap((m) => [...m.addedNodes])[0];
      if (!d) return;
      obs.disconnect();
      const out = [];
      const tick = () => { if (!d.isConnected) return resolve(out); if (d.hasAttribute('cx')) out.push([Number(d.getAttribute('cx')), Number(d.getAttribute('cy'))]); requestAnimationFrame(tick); };
      tick();
    }).observe(document.querySelector('#caWrap .ca-dots'), { childList: true });
  }));
  push({ t: 'olane', taskId: T.vps, activity: 'Edit · app.js' });
  const pts = await track;
  assert.ok(pts.length >= 2, 'a particle is drawn over several frames');
  const offLink = (p) => Math.abs((vps[0] - head[0]) * (head[1] - p[1]) - (head[0] - p[0]) * (vps[1] - head[1])) / dist(vps, head);
  assert.ok(pts.every((p) => offLink(p) < 3), 'on the link');
  assert.ok(dist(pts.at(-1), head) < dist(pts[0], head) && dist(pts[0], vps) < 40, 'from the worker towards the head');
  // Only for tasks it draws: an unknown one sends nothing.
  await page.evaluate(() => { window.__dots = []; });
  push({ t: 'olane', taskId: 999999, activity: 'Read · x' });
  await sleep(300);
  assert.equal(await page.evaluate(() => window.__dots.length), 0);
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('phone: a vertical list that fits 390px, in the dark theme', { skip: noBrowser, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await openDiagram({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const nodes = (await call('/api/cluster/nodes')).nodes, at = await Promise.all(nodes.map((n) => nodeAt(page, n.id)));
  assert.ok(at.every((p) => p[0] === at[0][0]), 'one column');
  assert.ok(at.every((p, i) => i === 0 || p[1] > at[i - 1][1]), 'top to bottom, the head first');
  const fits = await page.evaluate(() => {
    const w = document.querySelector('#caWrap'), s = w.querySelector('svg'), r = w.getBoundingClientRect();
    return document.documentElement.scrollWidth <= innerWidth && s.getBoundingClientRect().width <= r.width + 1
      && [...s.querySelectorAll('.ca-node, .ca-chip')].every((g) => { const b = g.getBoundingClientRect(); return b.left >= r.left - 1 && b.right <= r.right + 1; });
  });
  assert.ok(fits, 'nothing sticks out at 390px');
  assert.equal(await page.locator(`#caWrap .ca-node[data-node="${W.gpu.node}"] .ca-gauge`).first().evaluate((c) => getComputedStyle(c).stroke), await resolved(page, '--accent'));
  assert.equal(await resolved(page, '--accent'), 'rgb(217, 119, 87)', 'the dark theme');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('reduced motion: state changes land statically (no travel, no particles)', { skip: noBrowser, timeout: 60000 }, async () => {
  const { ctx, page, errors, push, otask } = await openDiagram({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const id = seed('Quietly placed', W.gpu.node);
  await watchChip(page, id);
  await otask(id);
  await page.locator(`#caWrap .ca-chip[data-task="${id}"]`).waitFor({ state: 'attached', timeout: 10000 });
  await sleep(600);
  const log = await chipLog(page);
  assert.equal(new Set(log.samples.map((s) => `${s.x},${s.y},${s.o}`)).size, 1, 'it appears at its seat, fully drawn');
  await page.evaluate(() => { window.__dots = 0; new MutationObserver((ms) => { for (const m of ms) window.__dots += m.addedNodes.length; }).observe(document.querySelector('#caWrap .ca-dots'), { childList: true }); });
  for (let i = 0; i < 5; i++) push({ t: 'olane', taskId: T.vps, activity: 'Bash · ls' });
  await sleep(400);
  assert.equal(await page.evaluate(() => window.__dots), 0, 'no particles');
  assert.equal(await page.evaluate(() => CA.anims.size + CA.raf), 0, 'no animation loop');
  db().prepare("UPDATE tasks SET status='done' WHERE id=?").run(id);
  await otask(id);
  await waitFor(() => page.locator(`#caWrap .ca-chip[data-task="${id}"]`).count().then((n) => n === 0), { timeout: 10000, message: 'the chip goes' });
  assert.equal(await page.locator('#caWrap .ca-mark').getAttribute('opacity'), '1.000', 'the check still shows, without motion');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('a hidden page pauses the loop: nothing is queued or drawn until it is visible', { skip: noBrowser, timeout: 60000 }, async () => {
  const { ctx, page, errors, push } = await openDiagram({ viewport: { width: 1280, height: 900 } });
  push({ t: 'olane', taskId: T.vps, activity: 'Bash · ls' });
  await waitFor(() => page.evaluate(() => CA.anims.size > 0), { timeout: 5000, message: 'a particle runs' });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await page.evaluate(() => CA.anims.size + CA.raf), 0, 'hidden: the loop stops and what ran is finished');
  for (let i = 0; i < 5; i++) push({ t: 'olane', taskId: T.vps, activity: 'Bash · ls' });
  await sleep(400);
  assert.equal(await page.evaluate(() => CA.anims.size + CA.raf + document.querySelectorAll('#caWrap .ca-dots circle').length), 0, 'nothing queued while hidden');
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(250);
  push({ t: 'olane', taskId: T.vps, activity: 'Bash · ls' });
  await waitFor(() => page.evaluate(() => CA.anims.size > 0), { timeout: 5000, message: 'it moves again once visible' });
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('tapping a node opens its detail: telemetry charts, the phase timeline and the log tail', { skip: noBrowser, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await openDiagram({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.locator(`#caWrap .ca-node[data-node="${W.vps.node}"] .ca-name`).tap();
  await page.locator('#nodeModal:not([hidden])').waitFor();
  assert.equal(await page.locator('#ndTitle').textContent(), 'build-vps');
  assert.match(await page.locator('#ndSub').textContent(), /^Linux · arm64 · Online · seen/);
  // Charts from GET /api/cluster/nodes/:id/metrics (three telemetry frames so far).
  const cpu = page.locator('#ndCharts [data-chart="cpu"]');
  await waitFor(async () => (await cpu.locator('path.line').getAttribute('d'))?.startsWith('M'), { timeout: 10000, message: 'the CPU chart has a line' });
  assert.equal(await cpu.locator('.nd-val').textContent(), '51%');
  assert.match(await cpu.locator('.sline-label').textContent(), /^1 hour agoavg 51% · peak 51%now$/);
  assert.equal(await page.locator('#ndCharts [data-chart="mem"] .nd-val').textContent(), '50%');
  await page.locator('#ndBody .range-picker button[data-range="15m"]').click();
  await waitFor(async () => (await cpu.locator('.sline-label').textContent()).startsWith('15 min ago'), { message: 'the range switches' });
  // What runs there, with its phase timeline.
  const run = page.locator('#ndRun');
  assert.match(await run.locator('.mc-task').textContent(), /Report worker phases/);
  await run.locator('.tl-steps').waitFor({ timeout: 10000 });
  assert.deepEqual(await run.locator('.tl-steps li .n').allTextContents(), ['Queued', 'Fetch', 'Install', 'Agent']);
  // The log tail, fetched over the worker's socket.
  await page.locator('#ndLogs').click();
  await page.locator('#ndLog .nd-log').waitFor({ timeout: 10000 });
  assert.equal(await page.locator('#ndLog .nd-log').textContent(), 'build-vps worker started\njob 1: running agent\njob 1: pushed agent-orch/task-1');
  assert.equal(await page.locator('#ndLogs').textContent(), 'Refresh');
  const fits = await page.evaluate(() => { const p = document.querySelector('#nodeModal .modal-panel'), b = p.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && p.scrollWidth <= p.clientWidth + 1; });
  assert.ok(fits, 'the sheet fits 390px');
  // Escape closes the panel (it covers the sheet on a phone); the head's detail is this server's, whose log lives in the journal.
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#nodeModal').isHidden(), true);
  assert.equal(await page.locator('#mxModal').isVisible(), true);
  await page.locator('#caWrap .ca-node[data-node="controller"] .ca-name').tap();
  await page.locator('#ndBody #serverDetails').waitFor();
  assert.match(await page.locator('#ndLog').textContent(), /journalctl -u agent-orch/);
  assert.match(await page.locator('#ndRun').textContent(), /Plan the next push/);
  await ctx.close();
  assert.deepEqual(errors, []);
});
