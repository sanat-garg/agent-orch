// The Machines window's graph on desktop (#498, app.js caCardLayout/caCard): a star, the head in the centre and every
// machine evenly spaced on a circle around it, each wearing a 260-300px card on its outer side with its full name, build
// and every running task as a mini card with a quiet progress strip; usage shows only as the node's rings (CPU its
// border, RAM a thin inner ring, exact numbers in the tooltip). An isolated server (CW_NO_ORCHESTRATOR=1, temp data
// dir) with four fake workers running 3-6 tasks each and the head an integrator and a work task, at 1440×900.
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
const PASSWORD = 'machines-star-password';
const CID = 'chat-star';
const GB = 2 ** 30;
const mac = macChromiumEnv();
let browser, skip = false;
try {
  browser = await chromium.launch(mac.AGENT_ORCH_BROWSER_PATH ? { executablePath: mac.AGENT_ORCH_BROWSER_PATH, env: { ...process.env, ...mac } } : {});
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;
const nodes = {}, tasks = {};
const LONG = 'sanats-macbook-pro-with-a-rather-long-hostname.local';
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mstar-'));
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
  nodes.studio = await fakeWorker(LONG, 'darwin', { cores: 10, mem: 32 * GB, avail: 9 * GB, load: [8.2, 7, 6] });
  nodes.air = await fakeWorker('macbook-air', 'darwin', { cores: 8, mem: 16 * GB, avail: 10 * GB, load: [1, 1, 1] });
  nodes.mini = await fakeWorker('mac-mini', 'darwin', { cores: 8, mem: 16 * GB, avail: 12 * GB, load: [0.4, 0.5, 0.5] });
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,created_at) VALUES(?,?,'active',?,0)").run(project, 'Fleet', CID).lastInsertRowid);
  const now = Math.floor(Date.now() / 1000);
  const run = db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,agent,ran_agent,ran_model,started_at,created_at,node_id,integrates) VALUES(?,'work',?,'seed','running',?,?,?,?,0,?,?)");
  let k = 0;
  for (const [key, count] of [['vps', 3], ['studio', 6], ['air', 4], ['mini', 5]]) {
    tasks[nodes[key]] = [];
    for (let i = 0; i < count; i++, k++) {
      const codex = k % 2;
      tasks[nodes[key]].push(Number(run.run(pid, `${key} task ${i + 1}`, codex ? 'codex' : 'claude', codex ? 'codex' : 'claude', codex ? 'gpt-5.5' : 'opus', now - 60 * (k + 1), nodes[key], null).lastInsertRowid));
    }
  }
  const work = Number(run.run(pid, 'Head work task', 'claude', 'claude', 'opus', now - 90, 'controller', null).lastInsertRowid);
  const integ = Number(run.run(pid, `Integrate #${tasks[nodes.vps][0]}`, 'claude', 'claude', 'opus', now - 30, 'controller', tasks[nodes.vps][0]).lastInsertRowid);
  tasks.head = [integ, work];
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

async function open(viewport) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' });
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
// Every card, machine plate (and its centre) and link in page coordinates (links sampled every 3px along their path).
const geometry = (page) => page.evaluate(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
  const svg = document.querySelector('#caWrap svg').getBoundingClientRect();
  return {
    cards: [...document.querySelectorAll('#caWrap .cc')].map((c) => ({ node: c.dataset.node, ...r(c) })),
    plates: [...document.querySelectorAll('#caWrap .ca-node')].map((g) => {
      const b = r(g.querySelector('.ca-plate'));
      return { node: g.dataset.node, head: g.classList.contains('head'), cx: (b.l + b.r) / 2, cy: (b.t + b.b) / 2, ...b };
    }),
    links: [...document.querySelectorAll('#caWrap .ca-link')].map((p) => {
      const len = p.getTotalLength(), pts = [];
      for (let s = 0; s <= len; s += 3) { const q = p.getPointAtLength(s); pts.push([svg.left + q.x, svg.top + q.y]); }
      return pts;
    }),
  };
});
const overlap = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

test('1440×900: a star of 4 machines around the head; big cards list every task with its progress strip; usage only on rings', { skip, timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({ width: 1440, height: 900 });
  await page.locator(`#caWrap .cc[data-node="${nodes.studio}"] .cc-task`).nth(5).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('#caWrap .cc').length === 5 && document.querySelectorAll('#caWrap .ca-node').length === 5);
  const g = await geometry(page);
  // Star: the head in the centre, the workers evenly around it on one circle.
  const head = g.plates.find((p) => p.head), workers = g.plates.filter((p) => !p.head);
  assert.equal(workers.length, 4);
  const polar = workers.map((p) => ({ a: (Math.atan2(p.cy - head.cy, p.cx - head.cx) * 180) / Math.PI, d: Math.hypot(p.cx - head.cx, p.cy - head.cy) }));
  const angles = polar.map((p) => (p.a + 360) % 360).sort((a, b) => a - b);
  for (let i = 0; i < angles.length; i++) {
    const step = ((angles[(i + 1) % angles.length] - angles[i]) + 360) % 360;
    assert.ok(Math.abs(step - 90) <= 5, `even angle spacing (±5°): ${JSON.stringify(angles)}`);
  }
  for (const p of polar) assert.ok(Math.abs(p.d - polar[0].d) <= 2, `one circle: ${JSON.stringify(polar)}`);
  assert.ok(polar[0].d > 60, 'workers sit away from the head');
  // Cards: 260-300px wide, outward of their machine, overlapping no card, machine or link.
  for (const c of g.cards) {
    assert.ok(c.r - c.l >= 259 && c.r - c.l <= 301, `260-300px wide: ${JSON.stringify(c)}`);
    for (const d of g.cards) if (d !== c) assert.ok(!overlap(c, d), `cards overlap: ${JSON.stringify([c, d])}`);
    for (const p of g.plates) assert.ok(!overlap(c, p), `a card covers a machine: ${JSON.stringify([c, p])}`);
    for (const pts of g.links) assert.ok(!pts.some(([x, y]) => x > c.l && x < c.r && y > c.t && y < c.b), `a card covers a link: ${JSON.stringify(c)}`);
    const p = g.plates.find((q) => q.node === c.node);
    if (!p.head) {
      const out = [p.cx - head.cx, p.cy - head.cy], mid = [(c.l + c.r) / 2 - p.cx, (c.t + c.b) / 2 - p.cy];
      assert.ok(out[0] * mid[0] + out[1] * mid[1] > 0, `the card sits on its machine's outer side: ${JSON.stringify({ c, p })}`);
    }
  }
  // The window holds the whole star: nothing spills sideways.
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.evaluate(() => { const w = document.getElementById('caWrap'); return w.scrollWidth <= w.clientWidth + 1; }), true);
  const wrap = await page.locator('#caWrap').boundingBox();
  for (const c of g.cards) assert.ok(c.l >= wrap.x - 1 && c.r <= wrap.x + wrap.width + 1, `inside the diagram: ${JSON.stringify([c, wrap])}`);
  // Every card lists every task on its machine, each a mini card with its progress strip; no CPU/RAM text.
  for (const [id, want] of Object.entries(tasks)) {
    const card = page.locator(id === 'head' ? '#caWrap .cc.head' : `#caWrap .cc[data-node="${id}"]`);
    const rows = await card.locator('.cc-task').evaluateAll((els) => els.map((e) => ({
      id: Number(e.dataset.task), strip: !!e.querySelector('.tl-bar.compact i'), text: e.textContent })));
    assert.deepEqual(rows.map((r) => r.id).sort((a, b) => a - b), [...want].sort((a, b) => a - b));
    for (const r of rows) {
      assert.ok(r.strip, `task #${r.id} has a progress strip`);
      assert.match(r.text, new RegExp(`^#${r.id}.+(Claude|Codex) · .+\\d+[smh]$`));
    }
    const text = await card.textContent();
    assert.doesNotMatch(text, /\bCPU\b|\bRAM\b|\d+%/, 'no usage text on the card');
    assert.equal(await card.locator('.cc-bar, .cc-meters, .cc-m').count(), 0);
    assert.equal(await card.locator('button.as-btn[data-act="assign"]').textContent(), 'Assign task', 'every machine card keeps Assign task');
  }
  assert.deepEqual(await page.locator('#caWrap .cc.head .cc-tasks > *').evaluateAll((els) => els.map((e) => e.dataset.task ? Number(e.dataset.task) : e.textContent.replace(/ .*/, ''))),
    ['Integrating', tasks.head[0], 'Work', tasks.head[1]]);
  // The full name: never truncated.
  const name = page.locator(`#caWrap .cc[data-node="${nodes.studio}"] .cc-name`);
  assert.equal(await name.textContent(), LONG);
  assert.equal(await name.evaluate((e) => e.scrollWidth <= e.clientWidth + 1 && getComputedStyle(e).textOverflow !== 'ellipsis'), true);
  // Usage rings: CPU on the node's border, RAM a thin ring inside, exact numbers in the tooltip.
  const rings = await page.evaluate(() => [...document.querySelectorAll('#caWrap .ca-node')].map((g) => {
    const cpu = g.querySelector('.ca-gauge[data-k="cpu"]'), ram = g.querySelector('.ca-gauge[data-k="ram"]'), plate = g.querySelector('.ca-plate');
    return { cpu: !!cpu, ram: !!ram, onBorder: cpu && +cpu.getAttribute('r') === +plate.getAttribute('r'), inner: ram && +ram.getAttribute('r') < +cpu.getAttribute('r'),
      thin: ram && parseFloat(getComputedStyle(ram).strokeWidth) < parseFloat(getComputedStyle(cpu).strokeWidth), tip: g.querySelector('title').textContent };
  }));
  for (const r of rings) {
    assert.deepEqual([r.cpu, r.ram, r.onBorder, r.inner, r.thin], [true, true, true, true, true], JSON.stringify(r));
    assert.match(r.tip, /CPU \d+(\.\d)?% .*\n.*RAM \d+(\.\d)?%/s);
  }
  // A task opens its drawer.
  await page.locator(`#caWrap .cc-task[data-task="${tasks[nodes.air][0]}"]`).click();
  await page.waitForFunction((id) => O.drawer === id, tasks[nodes.air][0]);
  await ctx.close();
  assert.deepEqual(errors, []);
});
