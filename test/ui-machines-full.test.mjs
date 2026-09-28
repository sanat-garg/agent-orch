// The full-screen Machines view (app.js MX) against an isolated server (CW_NO_ORCHESTRATOR=1, temp data dir) with seeded
// nodes and tasks: two fake workers dial in over the cluster socket, the DB holds running tasks on them and the head and a
// queue for the open project. Desktop: the cluster diagram and the queue side by side (count header, running lanes per
// machine, queued cards in order with 'after #N'), live lanes from the worker's pushes, Alt+↑ reorders, a queued card opens
// its drawer over the view, and the sidebar machine card opens the view on that machine's side panel. Phone (390px): a
// full-height sheet with Machines and Queue tabs (the phone cards themselves: ui-machines-mobile.test.mjs). CW_MXF_KEEP=1 keeps the seeded server up for screenshots.
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
const PASSWORD = 'machines-full-password';
const CID = 'chat-fleet';
const GB = 2 ** 30;
const mac = macChromiumEnv();
let browser, skip = false;
try {
  browser = await chromium.launch(mac.AGENT_ORCH_BROWSER_PATH ? { executablePath: mac.AGENT_ORCH_BROWSER_PATH, env: { ...process.env, ...mac } } : {});
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, vps, studio;
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
// A fake worker: pairs, dials the hub with its token and reports inventory + resources; heartbeats keep it online.
async function fakeWorker(name, kind, { cores, mem, avail, load }) {
  const { body: { code } } = await call('/api/cluster/pair', 'POST');
  const { body: { node, token } } = await call('/api/cluster/claim', 'POST', { code, name, os: kind, arch: 'arm64' }, false);
  const ws = new WebSocket(base.replace('http', 'ws') + WS_PATH, { headers: { authorization: `Bearer ${token}` } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const sender = createSender('w'), tx = (t, f) => ws.readyState === 1 && ws.send(sender(t, f));
  tx('hello', { node, protocol: PROTOCOL_VERSION, version: 'test', jobs: [] });
  tx('inventory', { node, name, os: kind, arch: 'arm64', cores, mem, versions: {}, agents: [{ id: 'claude', installed: true, signedIn: true }, { id: 'codex', installed: true, signedIn: true }] });
  tx('resources', { memAvailable: avail, load, running: [] });
  const beat = setInterval(() => tx('heartbeat'), 2000);
  beat.unref();
  workers.push(ws);
  return { node, ws, tx };
}

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mxfull-'));
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
  vps = await fakeWorker('build-vps', 'linux', { cores: 4, mem: 24 * GB, avail: 16 * GB, load: [1.5, 1, 1] });
  studio = await fakeWorker('studio-mac', 'darwin', { cores: 10, mem: 32 * GB, avail: 20 * GB, load: [2, 2, 2] });
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const pid = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,created_at) VALUES(?,?,'active',?,0)").run(project, 'Fleet', CID).lastInsertRowid);
  const now = Math.floor(Date.now() / 1000);
  const run = db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,agent,ran_agent,ran_model,started_at,created_at,node_id) VALUES(?,'work',?,'seed','running',?,?,?,?,0,?)");
  ids.build = Number(run.run(pid, 'Build the machines view', 'codex', 'codex', 'gpt-5.5', now - 750, vps.node).lastInsertRowid);
  ids.tidy = Number(run.run(pid, 'Tidy the settings sheet', 'claude', 'claude', 'opus', now - 60, 'controller').lastInsertRowid);
  const queue = db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,agent,created_at,position,depends_on) VALUES(?,'work',?,'seed','queued','claude',?,?,?)");
  ids.notes = Number(queue.run(pid, 'Write the release notes', now - 300, 1, null).lastInsertRowid);
  ids.polish = Number(queue.run(pid, 'Polish the queue cards', now - 290, 2, null).lastInsertRowid);
  ids.ship = Number(queue.run(pid, 'Ship the queue polish', now - 280, 3, ids.polish).lastInsertRowid);
  ids.dark = Number(queue.run(pid, 'Add a dark theme toggle', now - 270, 4, null).lastInsertRowid);
  db.close();
  if (process.env.CW_MXF_KEEP) console.log(`KEEP ${base}/#${CID} ${cookie}`);
});

after(async () => {
  await browser?.close();
  if (process.env.CW_MXF_KEEP) { await new Promise(() => {}); }
  for (const ws of workers) ws.terminate();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(opts) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(opts);
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${CID}`);
  await page.waitForFunction(() => O.project?.name === 'Fleet');
  return { ctx, page, errors };
}
const settle = (page) => page.evaluate(() => Promise.all(document.querySelector('#mxModal .mx-panel').getAnimations().map((a) => a.finished.catch(() => {}))));
const box = (page, sel) => page.locator(sel).evaluate((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; });

test('desktop: the diagram and the queue side by side, lanes per machine, live updates, reorder, a queued card opens its drawer', { skip, timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1440, height: 900 } });
  await page.locator('#machinesBtn').click();
  await page.locator('#mxModal:not([hidden])').waitFor();
  await settle(page);
  // Full screen, over the app.
  const panel = await box(page, '#mxModal .mx-panel');
  assert.deepEqual([panel.l, panel.t, panel.w, panel.h], [0, 0, 1440, 900]);
  assert.equal(await page.locator('.mx-tabs').isVisible(), false, 'no tabs on a desktop: both sides show');
  // The summary line and the diagram: the head and both workers, each with a card listing its running tasks.
  await page.locator('#caWrap:not([hidden]) .ca-node[data-node]').nth(2).waitFor();
  assert.equal(await page.locator('#caWrap .ca-node').count(), 3);
  await page.locator(`#caWrap .cc[data-node="${vps.node}"] .cc-task[data-task="${ids.build}"]`).waitFor();
  assert.match(await page.locator('#mcSum').textContent(), /^Cluster: 3 machines · \d+ cores · [\d.]+ GB free · 2 of \d+ slots running$/);
  // The queue: counts, a lane per machine, then the queued cards in scheduler order ('after #N' on the dependent).
  await page.locator('#mxQueue #qList .tcard').nth(3).waitFor();
  assert.match(await page.locator('#mxCounts').textContent(), /^Running 2 · Queued 4 · \d+ free slots?$/);
  const lanes = await page.locator('#mxLanes .mx-lane').evaluateAll((els) => els.map((e) => [e.querySelector('.mx-lane-n').textContent, [...e.querySelectorAll('.mc-task .t')].map((t) => t.textContent)]));
  const head = (await call('/api/cluster/nodes')).body.nodes.find((n) => n.local).name;
  assert.deepEqual(lanes, [[head, ['Tidy the settings sheet']], ['build-vps', ['Build the machines view']], ['studio-mac', []]]);
  const vpsLane = page.locator('#mxLanes .mx-lane', { hasText: 'build-vps' });
  assert.match(await vpsLane.locator('.mc-task .s').textContent(), new RegExp(`^#${ids.build} · Fleet · Codex · `));
  assert.match(await vpsLane.locator('.mc-task .e').textContent(), /^1[23]m$/);
  const order = () => page.locator('#mxQueue #qList .tcard').evaluateAll((els) => els.map((e) => Number(e.dataset.task)));
  assert.deepEqual(await order(), [ids.notes, ids.polish, ids.ship, ids.dark]);
  assert.match(await page.locator(`#qList .tcard[data-task="${ids.ship}"] .tc-after`).textContent(), new RegExp(`after #${ids.polish}`));
  assert.equal(await page.locator('#qList .q-card .q-grip').count(), 4, 'every queued card drags');
  // Side by side: the machines on the left, the queue in a column on the right.
  const [main, queue] = [await box(page, '#mxMain'), await box(page, '#mxQueue')];
  assert.ok(main.r <= queue.l + 1 && queue.r >= 1439 && queue.w >= 340 && main.w > queue.w, JSON.stringify({ main, queue }));
  assert.equal(await page.evaluate(() => document.querySelector('#queueModal').hidden), true);

  // Live: a task starts on the Mac; the worker's next reading ('cluster' push) brings it into its lane and the counts.
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const pid = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(ids.build).project_id;
  ids.profile = Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,status,agent,ran_agent,ran_model,started_at,created_at,node_id) VALUES(?,'work','Profile the worker','seed','running','claude','claude','sonnet',?,0,?)")
    .run(pid, Math.floor(Date.now() / 1000) - 5, studio.node).lastInsertRowid);
  studio.tx('resources', { memAvailable: 18 * GB, load: [2.5, 2, 2], running: [] });
  await page.locator('#mxLanes .mx-lane', { hasText: 'studio-mac' }).locator('.mc-task', { hasText: 'Profile the worker' }).waitFor({ timeout: 15000 });
  await page.locator('#mxCounts', { hasText: /^Running 3 · Queued 4/ }).waitFor();
  await page.locator(`#caWrap .cc[data-node="${studio.node}"] .cc-task[data-task="${ids.profile}"]`).waitFor();

  // Reorder from the keyboard (the same move as a drag): the dark theme goes above the polish block.
  await page.locator(`#qList .tcard[data-task="${ids.dark}"]`).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await page.waitForFunction((want) => JSON.stringify([...document.querySelectorAll('#qList .tcard')].map((e) => Number(e.dataset.task))) === want,
    JSON.stringify([ids.notes, ids.dark, ids.polish, ids.ship]));
  await page.waitForFunction(() => !Q.busy);
  const pos = Object.fromEntries(db.prepare('SELECT id, position FROM tasks WHERE status=\'queued\'').all().map((r) => [r.id, r.position]));
  db.close();
  assert.ok(pos[ids.dark] < pos[ids.polish] && pos[ids.polish] < pos[ids.ship] && pos[ids.notes] < pos[ids.dark], JSON.stringify(pos));
  // A mouse drag moves it back down under the polish block (once the reorder's slide has settled).
  await page.waitForFunction(() => [...document.querySelectorAll('#qList .tcard')].every((c) => !c.getAnimations().length && !c.style.transform));
  const from = await box(page, `#qList .tcard[data-task="${ids.dark}"]`), to = await box(page, `#qList .tcard[data-task="${ids.ship}"]`);
  await page.mouse.move(from.l + 40, from.t + from.h / 2);
  await page.mouse.down();
  await page.mouse.move(from.l + 40, from.t + from.h / 2 + 12, { steps: 3 });
  await page.mouse.move(from.l + 40, to.b + 6, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction((want) => JSON.stringify([...document.querySelectorAll('#qList .tcard')].map((e) => Number(e.dataset.task))) === want && !Q.busy,
    JSON.stringify([ids.notes, ids.polish, ids.ship, ids.dark]));

  // A queued card opens its drawer over the view (the view stays); Escape closes the drawer, then the view.
  await page.locator(`#qList .tcard[data-task="${ids.notes}"] .tc-title`).click();
  await page.locator('#taskDrawer:not([hidden])').waitFor();
  assert.equal(await page.evaluate(() => O.drawer), ids.notes);
  assert.equal(await page.locator('#mxModal').isVisible(), true);
  const onTop = await page.evaluate(() => { const d = document.querySelector('#taskDrawer').getBoundingClientRect(); return document.elementFromPoint(d.left + d.width / 2, d.top + 80)?.closest('#taskDrawer') != null; });
  assert.equal(onTop, true, 'the drawer sits above the Machines view');
  await page.locator('#drTitle', { hasText: 'Write the release notes' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#taskDrawer').isHidden(), true);
  assert.equal(await page.locator('#mxModal').isVisible(), true);
  // A running task in a lane opens its drawer too.
  await vpsLane.locator('.mc-task').click();
  await page.waitForFunction((id) => O.drawer === id, ids.build);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#mxModal').isHidden(), true);
  assert.equal(await page.evaluate(() => document.querySelector('#queueModal .modal-panel').contains(document.querySelector('#qBody'))), true, 'the Queue sheet gets its list back');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test("the sidebar machine card opens the whole view; a diagram machine opens its side panel and swaps it", { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1280, height: 800 } });
  await page.locator('#miniStats').click(); // every machine (#447), not the one the card shows
  await page.locator('#mxModal:not([hidden]) #caWrap:not([hidden]) .cc.head').waitFor();
  assert.equal(await page.locator('#nodeModal').isHidden(), true);
  await page.locator('#caWrap .cc.head .cc-open').click();
  await page.locator('#mxModal:not([hidden]) #nodeModal:not([hidden]) #ndBody #serverDetails').waitFor();
  assert.match(await page.locator('#ndSub').textContent(), /^This server · the head/);
  assert.equal(await page.locator('.modal:not([hidden])').count(), 1, 'one window: the detail is a side panel inside it');
  const side = await box(page, '#nodeModal'), view = await box(page, '#mxModal .mx-panel');
  assert.ok(side.r >= view.r - 1 && side.l > view.l + 200, `a panel on the right: ${JSON.stringify(side)}`);
  assert.equal(await page.locator('#caWrap .ca-node').first().isVisible(), true, 'the diagram stays in view beside it');
  await page.locator(`#caWrap .cc[data-node="${vps.node}"] .cc-open`).click();
  await page.locator('#ndTitle', { hasText: 'build-vps' }).waitFor();
  assert.equal(await page.locator('#ndBack').isVisible(), true);
  await page.keyboard.press('Escape');
  await page.locator('#ndBody #serverDetails').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#nodeModal').isHidden(), true);
  assert.equal(await page.locator('#mxModal').isVisible(), true, 'Escape closes the panel first');
  assert.equal(await page.evaluate(() => document.querySelector('#sdStash').contains(document.querySelector('#serverDetails'))), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#mxModal').isHidden(), true);
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('phone (390px): a full-height sheet with Machines and Queue tabs; a queued card opens its drawer', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.locator('#machinesBtn').dispatchEvent('click'); // the sidebar is off-canvas on a phone
  await page.locator('#mxModal:not([hidden])').waitFor();
  await settle(page); // the sheet's slide-up
  const panel = await box(page, '#mxModal .mx-panel');
  assert.deepEqual([panel.l, panel.t, panel.w, panel.h], [0, 0, 390, 844], 'full height');
  const tabs = page.locator('.mx-tabs [role="tab"]');
  assert.deepEqual(await tabs.allTextContents(), ['Machines', 'Queue 4']);
  assert.equal(await page.locator('#mxTabMachines').getAttribute('aria-selected'), 'true');
  await page.locator('#mMachines .mc-node .mc-open').nth(2).waitFor(); // a compact card per machine; the diagram behind 'Show diagram' (#433)
  assert.equal(await page.locator('#mxQueue').isVisible(), false);
  assert.equal(await page.locator('#caWrap').isVisible(), false);
  const fits = () => page.evaluate(() => { const p = document.querySelector('#mxModal .mx-panel'); return document.documentElement.scrollWidth <= innerWidth && p.scrollWidth <= p.clientWidth + 1; });
  assert.equal(await fits(), true, 'the machines fit 390px');
  const tabBox = await box(page, '#mxTabQueue');
  assert.ok(tabBox.h >= 44, 'a 44pt tab');

  await page.locator('#mxTabQueue').tap();
  assert.equal(await page.locator('#mxTabQueue').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#mxTabMachines').getAttribute('aria-selected'), 'false');
  assert.equal(await page.locator('#mxMain').isVisible(), false);
  await page.locator('#mxQueue #qList .tcard').nth(3).waitFor();
  assert.match(await page.locator('#mxCounts').textContent(), /^Running \d+ · Queued 4 · \d+ free slots?$/);
  assert.equal(await page.locator('#mxLanes .mx-lane', { hasText: 'build-vps' }).isVisible(), true);
  assert.equal(await fits(), true, 'the queue fits 390px');
  const card = page.locator(`#qList .tcard[data-task="${ids.polish}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.locator('.tc-title').tap();
  await page.locator('#taskDrawer:not([hidden])').waitFor();
  assert.equal(await page.evaluate(() => O.drawer), ids.polish);
  await page.locator('#drClose').tap();
  assert.equal(await page.locator('#taskDrawer').isHidden(), true);
  await page.locator('#mxTabMachines').tap();
  assert.equal(await page.locator('#mxMain').isVisible(), true);
  assert.equal(await page.locator('#mxQueue').isVisible(), false);
  // A machine's detail is a page over the sheet; its back button goes back to the view.
  await page.locator(`#mMachines .mc-node[data-node="${studio.node}"] .mc-open`).tap();
  await page.locator('#ndTitle', { hasText: 'studio-mac' }).waitFor();
  const side = await box(page, '#nodeModal');
  assert.deepEqual([side.l, side.t, side.w], [0, 0, 390]);
  await page.locator('#ndBack').tap();
  assert.equal(await page.locator('#nodeModal').isHidden(), true);
  assert.equal(await page.locator('#mxModal').isVisible(), true);
  await ctx.close();
  assert.deepEqual(errors, []);
});
