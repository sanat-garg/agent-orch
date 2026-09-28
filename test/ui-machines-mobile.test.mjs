// Machines on iPhone (#433): the phone (<768px) design of the Machines view against an isolated server (CW_NO_ORCHESTRATOR=1,
// temp data dir) seeded with four fake workers (a VPS and three Macs, one of them away), running tasks on three machines,
// finished history and an hour of metric samples. At 375, 390 and 430 px wide: nothing overflows horizontally (page,
// view, detail page), the large title and its summary line, a compact card per machine (gauges, one running line), the
// diagram as a vertical strip, text at least 12px (body 16px) and 44pt targets. A card tap pushes the machine's detail
// page (charts, running, recent history, Machine settings) and Back (or a swipe from the left edge) returns to the list.
// CW_MXM_KEEP=1 keeps the seeded server up for screenshots (prints its URL and cookie).
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
const PASSWORD = 'machines-mobile-password';
const CID = 'chat-phone';
const GB = 2 ** 30;
const mac = macChromiumEnv();
let browser, skip = false;
try {
  browser = await chromium.launch(mac.AGENT_ORCH_BROWSER_PATH ? { executablePath: mac.AGENT_ORCH_BROWSER_PATH, env: { ...process.env, ...mac } } : {});
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;
const W = {};
const ids = {};
const workers = [];

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const call = async (p, method = 'GET', body, auth = true) => {
  const r = await fetch(base + p, { method, headers: { ...(auth ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
// A fake worker: pairs, dials the hub with its token and reports inventory + resources (per-core CPU too); heartbeats keep it online.
async function fakeWorker(name, kind, { cores, mem, avail, load, cpu }) {
  const { body: { code } } = await call('/api/cluster/pair', 'POST');
  const { body: { node, token } } = await call('/api/cluster/claim', 'POST', { code, name, os: kind, arch: 'arm64' }, false);
  const ws = new WebSocket(base.replace('http', 'ws') + WS_PATH, { headers: { authorization: `Bearer ${token}` } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const sender = createSender('w'), tx = (t, f) => ws.readyState === 1 && ws.send(sender(t, f));
  tx('hello', { node, protocol: PROTOCOL_VERSION, version: 'test', jobs: [] });
  tx('inventory', { node, name, os: kind, arch: 'arm64', cores, mem, versions: {}, agents: [{ id: 'claude', installed: true, signedIn: true }, { id: 'codex', installed: true, signedIn: true }] });
  tx('resources', { memAvailable: avail, load, cpu: Array(cores).fill(cpu), disk: { free: 120 * GB, total: 250 * GB }, running: [] });
  const beat = setInterval(() => tx('heartbeat'), 2000);
  beat.unref();
  workers.push(ws);
  // An hour of readings for its charts (node-metrics.mjs's file, one sample a minute).
  const now = Date.now(), lines = [];
  for (let i = 60; i >= 1; i--) {
    const c = Math.max(3, Math.min(97, cpu + 25 * Math.sin(i / 6) + ((i * 37) % 11) - 5));
    lines.push(JSON.stringify({ t: now - i * 60e3, cpu: Math.round(c * 10) / 10, load: Math.round((c / 100) * cores * 10) / 10,
      mem: Math.round(avail * (0.9 + 0.1 * Math.cos(i / 9))), disk: 120 * GB, net: 1, netMs: 40 + (i % 7) * 6 }));
  }
  fs.mkdirSync(path.join(dataDir, 'metrics', 'nodes'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'metrics', 'nodes', `${node}.jsonl`), lines.join('\n') + '\n');
  return { node, ws, tx };
}

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mxmobile-'));
  const project = path.join(dataDir, 'fleet');
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Fleet', cwd: project, mode: 'orchestrator',
    agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true, fallbacks: [] }]));
  const port = Number(process.env.CW_MXM_PORT) || await freePort();
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
  W.vps = await fakeWorker('oracle-vps-2', 'linux', { cores: 4, mem: 24 * GB, avail: 9 * GB, load: [2.9, 2.5, 2], cpu: 72 });
  W.studio = await fakeWorker('mac-studio', 'darwin', { cores: 12, mem: 64 * GB, avail: 30 * GB, load: [5.1, 4, 3], cpu: 43 });
  W.air = await fakeWorker('sanats-macbook-air', 'darwin', { cores: 8, mem: 16 * GB, avail: Math.round(2.2 * GB), load: [7.4, 6, 5], cpu: 93 });
  W.mini = await fakeWorker('mac-mini', 'darwin', { cores: 8, mem: 16 * GB, avail: 11 * GB, load: [0.3, 0.2, 0.2], cpu: 4 });
  W.mini.ws.close(); // away: shows as offline
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,created_at) VALUES(?,?,'active',?,0)").run(project, 'Fleet', CID).lastInsertRowid);
  const now = Math.floor(Date.now() / 1000);
  const run = db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,agent,ran_agent,ran_model,started_at,created_at,node_id) VALUES(?,'work',?,'seed','running',?,?,?,?,0,?)");
  ids.build = Number(run.run(pid, 'Build the machines view for phones', 'codex', 'codex', 'gpt-5.5', now - 750, W.vps.node).lastInsertRowid);
  ids.lint = Number(run.run(pid, 'Lint the cluster protocol', 'claude', 'claude', 'sonnet', now - 320, W.vps.node).lastInsertRowid);
  ids.tidy = Number(run.run(pid, 'Tidy the settings sheet', 'claude', 'claude', 'opus', now - 60, 'controller').lastInsertRowid);
  ids.s1 = Number(run.run(pid, 'Profile the worker', 'claude', 'claude', 'opus', now - 1500, W.studio.node).lastInsertRowid);
  ids.s2 = Number(run.run(pid, 'Speed up the test runner with a much longer title that wraps', 'claude', 'claude', 'opus', now - 900, W.studio.node).lastInsertRowid);
  ids.s3 = Number(run.run(pid, 'Write the release notes', 'codex', 'codex', 'gpt-5.5', now - 200, W.studio.node).lastInsertRowid);
  ids.a1 = Number(run.run(pid, 'Fix the flaky ping test', 'claude', 'claude', 'sonnet', now - 2400, W.air.node).lastInsertRowid);
  const done = db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,agent,ran_agent,ran_model,started_at,finished_at,created_at,node_id) VALUES(?,'work',?,'seed',?,'claude','claude','opus',?,?,0,?)");
  const hist = [['Add the version badge', 'done', 3600], ['Sound picker rows', 'done', 7200], ['Retry git lock races', 'failed', 9000], ['Queue header wording', 'done', 20000]];
  for (const n of [W.vps.node, W.studio.node, W.air.node, 'controller']) hist.forEach(([t, s, ago], i) => done.run(pid, t, s, now - ago - 900, now - ago - i * 60, n));
  const queue = db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,agent,created_at,position) VALUES(?,'work',?,'seed','queued','claude',?,?)");
  queue.run(pid, 'Polish the queue cards', now - 290, 1);
  queue.run(pid, 'Add a dark theme toggle', now - 270, 2);
  db.close();
  if (process.env.CW_MXM_KEEP) console.log(`KEEP ${base}/#${CID} ${cookie}`);
});

after(async () => {
  await browser?.close();
  if (process.env.CW_MXM_KEEP) { await new Promise(() => {}); }
  for (const ws of workers) ws.terminate();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(width, height, opts = {}) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, ...opts });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${CID}`);
  await page.waitForFunction(() => O.project?.name === 'Fleet');
  await page.locator('#machinesBtn').dispatchEvent('click'); // the sidebar is off-canvas on a phone
  await page.locator(opts.isMobile === false ? '#mxModal:not([hidden]) #caWrap .cc[data-node="controller"]' : '#mxModal:not([hidden]) #mMachines .mc-node').nth(opts.isMobile === false ? 0 : 4).waitFor(); // desktop: the diagram's cards
  await page.evaluate(() => Promise.all(document.querySelector('#mxModal .mx-panel').getAnimations().map((a) => a.finished.catch(() => {}))));
  return { ctx, page, errors };
}
// Horizontal overflow in the Machines view: the page and every scroller fit, and no visible element pokes out of the
// viewport unless an ancestor that fits clips it (an ellipsis, a chart's own overflow).
const overflow = (page) => page.evaluate(() => {
  const vw = innerWidth, out = [];
  if (document.documentElement.scrollWidth > vw) out.push(`document ${document.documentElement.scrollWidth}`);
  for (const e of document.querySelectorAll('#mxModal *')) {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height || e.closest('[hidden]')) continue;
    const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden') continue;
    if (/auto|scroll/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 1) out.push(`${e.id || e.className} scrolls sideways (${e.scrollWidth} > ${e.clientWidth})`);
    if (r.right <= vw + 1 && r.left >= -1) continue;
    let a = e.parentElement, clipped = false;
    for (; a && a.id !== 'mxModal'; a = a.parentElement) {
      const ar = a.getBoundingClientRect();
      if (!/visible/.test(getComputedStyle(a).overflowX) && ar.right <= vw + 1 && ar.left >= -1) { clipped = true; break; }
    }
    if (!clipped) out.push(`${e.tagName.toLowerCase()}.${e.getAttribute('class') || ''}#${e.id} ${Math.round(r.left)}–${Math.round(r.right)}`);
  }
  return out;
});
// Every visible text in the view: its font size (px) and the element's selector-ish name; min over all.
const smallText = (page, min) => page.evaluate((min) => {
  const out = [];
  const walk = document.createTreeWalker(document.querySelector('#mxModal'), NodeFilter.SHOW_TEXT);
  for (let t; (t = walk.nextNode());) {
    const e = t.parentElement;
    if (!t.textContent.trim() || !e.getClientRects().length || e.closest('[hidden]')) continue;
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    if (!r.width || cs.visibility === 'hidden' || e.closest('#mxModal [aria-hidden="true"]:not(svg)')) continue;
    const size = parseFloat(cs.fontSize);
    if (size < min) out.push(`${e.getAttribute('class') || e.tagName} "${t.textContent.trim().slice(0, 24)}" ${size}px`);
  }
  return out;
}, min);
const fontSize = (page, sel) => page.locator(sel).first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
// Visible controls under 44×44 (a switch counts its labelled row, which toggles it).
const smallTargets = (page) => page.evaluate(() => [...document.querySelectorAll('#mxModal :is(button, summary, select, [role="tab"], input)')].flatMap((e) => {
  const r = (e.matches('.st-switch') ? e.closest('label') || e : e).getBoundingClientRect();
  if (!r.width || e.closest('[hidden]') || getComputedStyle(e).visibility === 'hidden') return [];
  return r.width < 44 || r.height < 44 ? [`${e.id || e.className || e.tagName} "${e.textContent.trim().slice(0, 20)}" ${Math.round(r.width)}×${Math.round(r.height)}`] : [];
}));

for (const [width, height] of [[375, 667], [390, 844], [430, 932]]) {
  test(`${width}px: a large title and summary, one compact card per machine, no horizontal overflow, readable text, 44pt targets`, { skip, timeout: 60000 }, async () => {
    const { ctx, page, errors } = await open(width, height);
    assert.equal(await page.locator('#mxTitle').textContent(), 'Machines');
    assert.ok(await fontSize(page, '#mxTitle') >= 28, 'a large title');
    assert.match(await page.locator('#mxSum').textContent(), /^4 of 5 machines online · 7 running · \d+ free slots?$/);
    assert.equal(await page.locator('#mcSum').isVisible(), false, "the desktop's long summary is hidden");
    assert.deepEqual(await page.locator('.mx-tabs [role="tab"]').allTextContents(), ['Machines', 'Queue 2']);
    // The first card is on the first screen, under the title and the segment.
    const first = await page.locator('#mMachines .mc-open').first().boundingBox();
    assert.ok(first.y + 120 < height, `the first machine shows without scrolling (top ${first.y})`);
    // A compact card: name, status, two gauges and one running line; the long parts are on the detail page.
    const studio = page.locator(`#mMachines .mc-node[data-node="${W.studio.node}"]`);
    assert.equal(await studio.locator('.mo-name').textContent(), 'mac-studio');
    assert.equal(await studio.locator('.mc-open .mc-st').textContent(), 'Online');
    assert.deepEqual(await studio.locator('.mo-gauge .mo-gl:not(.mo-gs)').allTextContents(), ['CPU', 'Memory']);
    assert.equal(await studio.locator('.mo-gauge').first().getAttribute('aria-label'), 'CPU 43%');
    assert.equal(await studio.locator('.mo-run').textContent(), `3 running · #${ids.s1}, #${ids.s2}…`);
    assert.equal(await page.locator(`#mMachines .mc-node[data-node="${W.air.node}"] .mo-arc.crit`).count(), 1, 'a 93% CPU reads as critical');
    assert.equal(await page.locator(`#mMachines .mc-node[data-node="${W.mini.node}"] .mc-open .mc-st`).textContent(), 'Connection lost');
    assert.equal(await page.locator(`#mMachines .mc-node[data-node="${W.mini.node}"] .mo-run`).textContent(), 'Nothing running');
    for (const sel of ['.mc-top', '.mc-meter', '.mc-run', '.mc-set']) assert.equal(await studio.locator(sel).first().isVisible(), false, `${sel} is on the detail page`);
    const cardBox = await studio.boundingBox();
    assert.ok(cardBox.height < 240, `a compact card (${cardBox.height}px)`);
    // The diagram hides behind 'Show diagram'; the actions sit under the list.
    assert.equal(await page.locator('#caWrap').isVisible(), false);
    assert.equal(await page.locator('#mxMore #addMachine').isVisible(), true);
    assert.deepEqual(await overflow(page), []);
    assert.deepEqual(await smallText(page, 12), []);
    assert.ok(await fontSize(page, '.mo-run') >= 16 && await fontSize(page, '.mo-name') >= 16, '16px body text');
    assert.deepEqual(await smallTargets(page), []);
    // Show diagram: still fits, labels ≥ 12px.
    await page.locator('#mxDiagBtn').tap();
    await page.locator('#caWrap .ca-node').nth(4).waitFor();
    assert.equal(await page.locator('#mxDiagBtn').getAttribute('aria-expanded'), 'true');
    await page.waitForFunction(() => document.querySelector('#caWrap > svg').getBoundingClientRect().height > 300); // laid out as a list of 5
    const wrap = await page.locator('#caWrap').boundingBox(), svg = await page.locator('#caWrap > svg').boundingBox();
    assert.ok(wrap.height >= svg.height, `the whole diagram shows (${wrap.height} ≥ ${svg.height})`);
    assert.deepEqual(await overflow(page), []);
    const svgText = await page.locator('#caWrap text').evaluateAll((ts) => ts.filter((t) => t.getBBox().width).map((t) => parseFloat(getComputedStyle(t).fontSize) * (t.ownerSVGElement.getBoundingClientRect().width / t.ownerSVGElement.viewBox.baseVal.width || 1)));
    assert.ok(svgText.length && Math.min(...svgText) >= 12, `diagram labels ≥ 12px: ${Math.min(...svgText)}`);
    await page.locator('#mxDiagBtn').tap();
    assert.equal(await page.locator('#caWrap').isVisible(), false);
    await page.evaluate(() => localStorage.removeItem('cw.mx.diagram'));
    // The detail page fits too, all the way down.
    await studio.locator('.mc-open').tap();
    await page.locator('#nodeModal:not([hidden]) #ndSet .mc-row').first().waitFor();
    await page.locator('#ndCharts .nd-chart .sline path.line[d^="M"]').first().waitFor();
    await page.evaluate(() => Promise.all(document.querySelector('#nodeModal .nd').getAnimations().map((a) => a.finished.catch(() => {}))));
    for (const top of [0, 800, 1600, 99999]) {
      await page.evaluate((y) => { document.querySelector('#ndBody').scrollTop = y; }, top);
      assert.deepEqual(await overflow(page), [], `detail scrolled to ${top}`);
    }
    assert.deepEqual(await smallText(page, 12), []);
    assert.ok(await fontSize(page, '#ndRun .mc-task .t') >= 16 && await fontSize(page, '#ndSet .mc-rl') >= 16, '16px rows');
    assert.deepEqual(await smallTargets(page), []);
    await ctx.close();
    assert.deepEqual(errors, []);
  });
}

test('390px: a card pushes its detail page (charts, running, recent history, settings); Back and an edge swipe return', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open(390, 844);
  const card = page.locator(`#mMachines .mc-node[data-node="${W.studio.node}"] .mc-open`);
  await card.tap();
  await page.locator('#nodeModal:not([hidden])').waitFor();
  assert.equal(await page.locator('#ndTitle').textContent(), 'mac-studio');
  const side = await page.locator('#nodeModal').boundingBox();
  assert.deepEqual([side.x, side.y, side.width, side.height], [0, 0, 390, 844], 'a full-screen page');
  assert.equal(await page.locator('#ndBack').isVisible(), true);
  assert.equal(await page.locator('#ndBackT').textContent(), 'Machines');
  assert.equal(await page.locator('#nodeModal [data-close]').isVisible(), false, 'Back, not a close button');
  // Charts sized for the phone, running tasks, recent history, the settings open inline.
  await page.locator('#ndCharts .nd-chart .sline path.line[d^="M"]').first().waitFor();
  const chart = await page.locator('#ndCharts .nd-chart[data-chart="cpu"] .sline').boundingBox();
  assert.ok(chart.width >= 300 && chart.height >= 100, `a phone-sized chart ${JSON.stringify(chart)}`);
  assert.equal(await page.locator('#ndCharts .nd-chart[data-chart="cpu"] .sline-y').textContent(), '100%', 'the top of its scale');
  assert.deepEqual(await page.locator('#ndRun .mc-task .t').allTextContents(), ['Profile the worker', 'Speed up the test runner with a much longer title that wraps', 'Write the release notes']);
  assert.deepEqual(await page.locator('#ndHist .nd-hrow .t').allTextContents(), ['Add the version badge', 'Sound picker rows', 'Retry git lock races', 'Queue header wording']);
  assert.match(await page.locator('#ndHist .nd-hrow.failed .s').textContent(), /· Failed$/);
  assert.ok(await page.locator('#ndSet .mc-row').count() >= 3, 'Machine settings rows');
  assert.equal(await page.locator('#ndSet .mc-set > summary').isVisible(), false, 'open, under its own heading');
  assert.equal(await page.locator('#nodeModal .as-btn[data-act="assign"]').count(), 1, 'Assign task stays');
  // Tap a chart for its value: the tooltip stays after the finger lifts, a tap elsewhere hides it.
  const cpu = page.locator('#ndCharts .nd-chart[data-chart="cpu"] .sline');
  await cpu.scrollIntoViewIfNeeded();
  const cb = await cpu.boundingBox();
  await page.touchscreen.tap(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.waitForTimeout(300);
  assert.equal(await cpu.locator('.tip').isVisible(), true);
  assert.match(await cpu.locator('.tip').textContent(), /^\d+(\.\d)?% · \d/);
  await page.locator('#ndTitle').tap();
  assert.equal(await cpu.locator('.tip').isVisible(), false);
  // Back returns to the list, where it was.
  await page.locator('#ndBack').tap();
  assert.equal(await page.locator('#nodeModal').isHidden(), true);
  assert.equal(await page.locator('#mxModal').isVisible(), true);
  assert.equal(await card.isVisible(), true);
  // A swipe from the left edge goes back too; a short one springs back.
  const swipe = async (to) => {
    const cdp = await ctx.newCDPSession(page);
    const pt = (x) => ({ touchPoints: [{ x, y: 500 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', ...pt(4) });
    for (let x = 20; x <= to; x += 20) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', ...pt(x) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(400);
  };
  await card.tap();
  await page.locator('#nodeModal:not([hidden])').waitFor();
  await page.evaluate(() => Promise.all(document.querySelector('#nodeModal .nd').getAnimations().map((a) => a.finished.catch(() => {}))));
  await swipe(40); // 36px: under the 40px fling threshold, however fast CDP delivers it
  assert.equal(await page.locator('#nodeModal').isVisible(), true, 'a short swipe springs back');
  assert.equal(await page.locator('#nodeModal .nd').evaluate((e) => e.style.transform), '');
  await swipe(260);
  assert.equal(await page.locator('#nodeModal').isHidden(), true, 'a long swipe goes back');
  assert.equal(await page.locator('#mxModal').isVisible(), true);
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('live readings repaint only the machine that changed (one frame per burst), and desktop keeps its layout', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open(390, 844);
  // The update target's build lands a poll later (version.mjs buildOf counts it in the background) and rightly rebuilds
  // every card once: let it settle first (it stays null when this checkout lacks that sha).
  await page.waitForFunction(async () => { await loadMachines(); return !MC.target || MC.target.build != null; }, null, { timeout: 10000, polling: 250 }).catch(() => {});
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // Relative times ('seen 2m ago') refresh every card once a minute: stay clear of a minute boundary.
  while (new Date().getSeconds() > 45) await new Promise((r) => setTimeout(r, 1000));
  await page.evaluate(() => { for (const li of document.querySelectorAll('#mMachines .mc-node')) li.dataset.mark = li.dataset.node; });
  W.vps.tx('resources', { memAvailable: 3 * GB, load: [3.9, 3, 2], cpu: Array(4).fill(97), disk: { free: 120 * GB, total: 250 * GB }, running: [] });
  await page.locator(`#mMachines .mc-node[data-node="${W.vps.node}"] .mo-arc.crit`).waitFor({ timeout: 15000 });
  const kept = await page.locator('#mMachines .mc-node').evaluateAll((els) => els.filter((e) => e.dataset.mark).map((e) => e.dataset.node));
  assert.ok(!kept.includes(W.vps.node), 'the changed machine is rebuilt');
  assert.ok(kept.includes(W.studio.node) && kept.includes(W.mini.node), `unchanged cards stay: ${kept}`);
  await ctx.close();
  // Desktop: none of the phone parts show.
  const d = await open(1280, 800, { isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
  for (const sel of ['#mMachines .mc-open', '#mxSum', '#mxDiagBtn', '#mxMore']) assert.equal(await d.page.locator(sel).first().isVisible(), false, sel);
  assert.equal(await d.page.locator('#mcSum').isVisible(), true);
  assert.equal(await d.page.locator('.mx-head #addMachine').isVisible(), true);
  assert.equal(await d.page.locator('#caWrap').isVisible(), true);
  assert.equal(await d.page.locator('#caWrap .cc').count(), 5, "the diagram's machine cards (the card list lives in the side panel from 768px)");
  await d.ctx.close();
  assert.deepEqual([...errors, ...d.errors], []);
});
