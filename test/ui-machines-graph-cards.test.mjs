// The Machines view's cluster diagram on laptop/desktop widths (app.js caCard, caCardLayout): each machine wears a small
// card beside its node (name, status, build; every running task; usage only on the node's rings, #498), placed so no card overlaps another card, a
// machine or a link, re-laid out when a machine joins. An isolated server (CW_NO_ORCHESTRATOR=1, temp data dir) with
// seeded nodes: a VPS and three Macs dial in over the cluster socket, one Mac runs 6 tasks, the head an integrator and
// a work task. A task row opens its drawer, a card's header or gear the machine's side panel (where its settings now
// live); the old list of machine cards is gone from the view. CW_MGC_KEEP=1 keeps the seeded server up for screenshots.
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
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'graph-cards-password';
const CID = 'chat-cards';
const GB = 2 ** 30;
const mac = macChromiumEnv();
let browser, skip = false;
try {
  browser = await chromium.launch(mac.AGENT_ORCH_BROWSER_PATH ? { executablePath: mac.AGENT_ORCH_BROWSER_PATH, env: { ...process.env, ...mac } } : {});
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;
const nodes = {}, ids = {}, busy = [];
const sockets = [];

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const call = async (p, method = 'GET', body, auth = true) => {
  const r = await fetch(base + p, { method, headers: { ...(auth ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
// A fake worker: pairs, dials the hub with its token and reports inventory + resources; heartbeats keep it online.
async function fakeWorker(name, kind, { cores, mem, avail, load }) {
  const { body: { code } } = await call('/api/cluster/pair', 'POST');
  const { body: { node, token } } = await call('/api/cluster/claim', 'POST', { code, name, os: kind, arch: 'arm64' }, false);
  const ws = new WebSocket(base.replace('http', 'ws') + WS_PATH, { headers: { authorization: `Bearer ${token}` } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const sender = createSender('w'), tx = (t, f) => ws.readyState === 1 && ws.send(sender(t, f));
  tx('hello', { node, protocol: PROTOCOL_VERSION, version: 'test', jobs: [] });
  tx('inventory', { node, name, os: kind, arch: 'arm64', cores, mem, versions: { sha: 'abc1234', build: 412 },
    agents: [{ id: 'claude', installed: true, signedIn: true }, { id: 'codex', installed: true, signedIn: true }] });
  tx('resources', { memAvailable: avail, load, running: [] });
  const beat = setInterval(() => tx('heartbeat'), 2000);
  beat.unref();
  sockets.push(ws);
  return node;
}

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mgc-'));
  const project = path.join(dataDir, 'fleet');
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Fleet', cwd: project, mode: 'orchestrator',
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
  nodes.vps = await fakeWorker('build-vps', 'linux', { cores: 4, mem: 24 * GB, avail: 16 * GB, load: [1.5, 1, 1] });
  nodes.studio = await fakeWorker('studio-mac', 'darwin', { cores: 10, mem: 32 * GB, avail: 9 * GB, load: [8.2, 7, 6] });
  nodes.air = await fakeWorker('macbook-air', 'darwin', { cores: 8, mem: 16 * GB, avail: 10 * GB, load: [1, 1, 1] });
  nodes.mini = await fakeWorker('mac-mini', 'darwin', { cores: 8, mem: 16 * GB, avail: 12 * GB, load: [0.4, 0.5, 0.5] });
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,created_at) VALUES(?,?,'active',?,0)").run(project, 'Fleet', CID).lastInsertRowid);
  const now = Math.floor(Date.now() / 1000);
  const run = db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,agent,ran_agent,ran_model,started_at,created_at,node_id,integrates) VALUES(?,'work',?,'seed','running',?,?,?,?,0,?,?)");
  const titles = ['Files ops', 'Queue polish', 'Dark theme toggle', 'Release notes', 'Profile the worker', 'Machine sounds'];
  titles.forEach((t, i) => busy.push(Number(run.run(pid, t, i % 2 ? 'codex' : 'claude', i % 2 ? 'codex' : 'claude', i % 2 ? 'gpt-5.5' : 'opus', now - 60 * (i + 1), nodes.studio, null).lastInsertRowid)));
  ids.build = Number(run.run(pid, 'Build the machines view', 'codex', 'codex', 'gpt-5.5', now - 750, nodes.vps, null).lastInsertRowid);
  ids.air = Number(run.run(pid, 'Tidy the settings sheet', 'claude', 'claude', 'sonnet', now - 200, nodes.air, null).lastInsertRowid);
  ids.tidy = Number(run.run(pid, 'Head work task', 'claude', 'claude', 'opus', now - 90, 'controller', null).lastInsertRowid);
  ids.integ = Number(run.run(pid, `Integrate #${busy[0]}`, 'claude', 'claude', 'opus', now - 30, 'controller', busy[0]).lastInsertRowid);
  db.close();
  if (process.env.CW_MGC_KEEP) console.log(`KEEP ${base}/#${CID} ${cookie}`);
});

after(async () => {
  await browser?.close();
  if (process.env.CW_MGC_KEEP) { await new Promise(() => {}); }
  for (const ws of sockets) ws.terminate();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(viewport, colorScheme = 'light') {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport, colorScheme, reducedMotion: 'reduce' });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${CID}`);
  await page.waitForFunction(() => O.project?.name === 'Fleet');
  await page.locator('#miniStats').dispatchEvent('click');
  await page.locator('#mxModal:not([hidden])').waitFor();
  return { ctx, page, errors };
}
// Every card, machine plate and link in page coordinates (links sampled every 3px along their path).
const geometry = (page) => page.evaluate(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
  const svg = document.querySelector('#caWrap svg').getBoundingClientRect();
  return {
    cards: [...document.querySelectorAll('#caWrap .cc')].map((c) => ({ node: c.dataset.node, ...r(c) })),
    plates: [...document.querySelectorAll('#caWrap .ca-node')].map((g) => ({ node: g.dataset.node, ...r(g.querySelector('.ca-plate')) })),
    links: [...document.querySelectorAll('#caWrap .ca-link')].map((p) => {
      const len = p.getTotalLength(), pts = [];
      for (let s = 0; s <= len; s += 3) { const q = p.getPointAtLength(s); pts.push([svg.left + q.x, svg.top + q.y]); }
      return pts;
    }),
  };
});
const overlap = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
const gapBetween = (a, b) => Math.hypot(Math.max(0, a.l - b.r, b.l - a.r), Math.max(0, a.t - b.b, b.t - a.b));

async function assertLayout(page, count) {
  await page.waitForFunction((n) => document.querySelectorAll('#caWrap .cc').length === n && document.querySelectorAll('#caWrap .ca-node').length === n, count);
  const g = await geometry(page);
  assert.equal(g.cards.length, count);
  assert.deepEqual(new Set(g.cards.map((c) => c.node)), new Set(g.plates.map((p) => p.node)), 'a card for every machine');
  for (const c of g.cards) {
    assert.ok(c.r - c.l <= 301, `at most 300px wide: ${JSON.stringify(c)}`);
    const plate = g.plates.find((p) => p.node === c.node);
    if (c.node !== 'controller') assert.ok(gapBetween(c, plate) <= 90, `anchored beside its machine: ${JSON.stringify({ c, plate })}`); // the head's sits past the star's links
    for (const d of g.cards) if (d !== c) assert.ok(!overlap(c, d), `cards overlap: ${JSON.stringify([c, d])}`);
    for (const p of g.plates) assert.ok(!overlap(c, p), `a card covers a machine: ${JSON.stringify([c, p])}`);
    for (const pts of g.links) assert.ok(!pts.some(([x, y]) => x > c.l && x < c.r && y > c.t && y < c.b), `a card covers a link: ${JSON.stringify(c)}`);
  }
  return g;
}

for (const [width, height] of [[1440, 900], [1280, 800]]) {
  test(`${width}×${height}: a card beside every machine, none overlapping; every running task listed; the old cards gone`, { skip, timeout: 90000 }, async () => {
    const { ctx, page, errors } = await open({ width, height });
    await page.locator(`#caWrap .cc[data-node="${nodes.studio}"] .cc-task`).nth(5).waitFor();
    await assertLayout(page, Object.keys(nodes).length + 1); // the head and the workers (one more once late-mac joined)
    // The busy Mac lists all six, no '+N'.
    const studio = page.locator(`#caWrap .cc[data-node="${nodes.studio}"]`);
    assert.deepEqual((await studio.locator('.cc-task').evaluateAll((els) => els.map((e) => Number(e.dataset.task)))).sort((a, b) => a - b), [...busy].sort((a, b) => a - b));
    assert.doesNotMatch(await studio.textContent(), /\+\s*\d|more/);
    assert.deepEqual(await page.locator('#caWrap .ca-more').evaluateAll((els) => els.map((e) => e.textContent).filter(Boolean)), []);
    assert.equal(await studio.locator(`.cc-task[data-task="${busy[0]}"] .cc-id`).textContent(), `#${busy[0]}`);
    assert.equal(await studio.locator(`.cc-task[data-task="${busy[0]}"] .cc-t`).textContent(), 'Files ops');
    assert.match(await studio.locator(`.cc-task[data-task="${busy[0]}"] .cc-am`).textContent(), /^Claude · /);
    assert.match(await studio.locator(`.cc-task[data-task="${busy[0]}"] .e`).textContent(), /^\d+m$/);
    // Header: status dot, name, build; no CPU/RAM on the card.
    assert.equal(await studio.locator('.cc-open .dot.on').count(), 1);
    assert.equal(await studio.locator('.cc-name').textContent(), 'studio-mac');
    assert.equal(await studio.locator('.cc-build').textContent(), 'v4.12');
    assert.equal(await studio.locator('.cc-m').count(), 0);
    assert.equal(await studio.locator('button.as-btn[data-act="assign"]').textContent(), 'Assign task', 'every machine card keeps Assign task');
    // The head: its integrator in a group of its own, then its work.
    const head = page.locator('#caWrap .cc.head');
    assert.deepEqual(await head.locator('.cc-tasks > *').evaluateAll((els) => els.map((e) => e.dataset.task ? Number(e.dataset.task) : e.textContent.replace(/ .*/, ''))),
      ['Integrating', ids.integ, 'Work', ids.tidy]);
    // The old list of big cards is gone from the view.
    assert.equal(await page.locator('#mxMain #mMachines').count(), 0);
    assert.equal(await page.locator('#mxModal .mc-node:visible').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (width === 1440) {
      // A task row opens its drawer over the view.
      await page.locator(`#caWrap .cc-task[data-task="${ids.build}"]`).click();
      await page.waitForFunction((id) => O.drawer === id, ids.build);
      await page.locator('#drTitle', { hasText: 'Build the machines view' }).waitFor();
      assert.equal(await page.locator('#mxModal').isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#taskDrawer').isHidden(), true);
      // The header opens the machine's side panel; its settings are there (and only there).
      await page.locator(`#caWrap .cc[data-node="${nodes.air}"] .cc-open`).click();
      await page.locator('#ndTitle', { hasText: 'macbook-air' }).waitFor();
      await page.locator(`#ndBody #mMachines .mc-node[data-node="${nodes.air}"] .mc-set`).waitFor();
      assert.equal(await page.locator('#ndBody #mMachines .mc-node').count(), 1);
      assert.equal(await page.locator('#ndBody .mc-node .mc-meter').count(), 0, 'the charts stand in for its meters');
      // The gear opens the same panel for another machine; the layout beside the panel still holds.
      await page.locator(`#caWrap .cc[data-node="${nodes.vps}"] .cc-gear`).click();
      await page.locator('#ndTitle', { hasText: 'build-vps' }).waitFor();
      await page.locator(`#ndBody #mMachines .mc-node[data-node="${nodes.vps}"]`).waitFor();
      await assertLayout(page, 5);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#nodeModal').isHidden(), true);
      assert.equal(await page.locator('#mxModal .mc-node:visible').count(), 0);
      // A machine joins: the cards re-lay out around it and still clear each other.
      nodes.late = await fakeWorker('late-mac', 'darwin', { cores: 8, mem: 16 * GB, avail: 14 * GB, load: [0.2, 0.2, 0.2] });
      await page.locator(`#caWrap .cc[data-node="${nodes.late}"]`).waitFor({ timeout: 15000 });
      await assertLayout(page, 6);
    }
    await ctx.close();
    assert.deepEqual(errors, []);
  });
}

test('dark theme: the cards follow the theme variables', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 1440, height: 900 }, 'dark');
  await page.locator('#caWrap .cc.head').waitFor();
  const [card, panel] = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--panel)';
    document.body.append(probe);
    const want = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return [getComputedStyle(document.querySelector('#caWrap .cc')).backgroundColor, want];
  });
  assert.equal(card, panel);
  await ctx.close();
  assert.deepEqual(errors, []);
});
