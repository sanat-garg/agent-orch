// The Machines window's fleet list and a machine's tabs (real server, fake workers, CW_NO_ORCHESTRATOR), and the Storage tab
// against a stubbed /api/storage: nothing in this test may touch the real disk. Non-admins get 403 from the real routes.
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
const PASSWORD = 'machines-storage-password', CID = 'chat-fleet', GB = 2 ** 30;
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
const call = async (p, method = 'GET', body, ck = cookie) => {
  const r = await fetch(base + p, { method, headers: { ...(ck ? { cookie: ck } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};
async function fakeWorker(name, kind, cores) {
  const { body: { code } } = await call('/api/cluster/pair', 'POST');
  const { body: { node, token } } = await call('/api/cluster/claim', 'POST', { code, name, os: kind, arch: 'arm64' }, null);
  const ws = new WebSocket(base.replace('http', 'ws') + WS_PATH, { headers: { authorization: `Bearer ${token}` } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const sender = createSender('w'), tx = (t, f) => ws.readyState === 1 && ws.send(sender(t, f));
  tx('hello', { node, protocol: PROTOCOL_VERSION, version: 'test', jobs: [] });
  tx('inventory', { node, name, os: kind, arch: 'arm64', cores, mem: 16 * GB, versions: {}, agents: [{ id: 'claude', installed: true, signedIn: true }] });
  tx('resources', { memAvailable: 8 * GB, load: [1, 1, 1], running: [], disk: { path: '/x', free: 40 * GB, total: 400 * GB } });
  const beat = setInterval(() => tx('heartbeat'), 2000);
  beat.unref();
  workers.push(ws);
  return node;
}
const P = '/home/me/workspace';
const STORAGE = {
  at: Date.now() - 120e3, ms: 900, disk: { total: 45 * GB, used: 42 * GB, free: 3.5 * GB }, reclaimable: 3 * GB,
  categories: [
    { id: 'projects', label: 'Projects', hint: 'Your project folders', bytes: 20 * GB, more: 0, items: [
      { path: `${P}/big`, name: 'big', bytes: 7 * GB, dir: true, why: 'In use by npm start' },
      { path: `${P}/old`, name: 'old', bytes: 2 * GB, dir: true, why: null },
    ] },
    { id: 'system', label: 'System', hint: 'Ubuntu', bytes: 6 * GB, more: 0, items: [{ path: '/usr', name: 'usr', bytes: 6 * GB, dir: true, why: 'Part of the system' }] },
    { id: 'other', label: 'Not counted', hint: 'Overhead', bytes: GB, more: 0, items: [] },
  ],
  cleanups: [
    { id: 'deps', title: 'Dependencies of idle projects', why: 'Reinstall from the lockfile.', bytes: 2 * GB, items: [
      { path: `${P}/a/node_modules`, label: 'workspace/a/node_modules', bytes: 1.5 * GB, touched: Date.now() - 40 * 864e5, restore: 'npm ci in ~/workspace/a' },
      { path: `${P}/b/node_modules`, label: 'workspace/b/node_modules', bytes: 0.5 * GB, touched: Date.now() - 40 * 864e5, restore: 'npm ci in ~/workspace/b' },
    ] },
    { id: 'transcripts', title: 'Transcripts of finished tasks', why: 'Worktrees that are gone.', bytes: GB, items: [{ clean: 'transcripts', label: '588 finished tasks', bytes: GB }] },
    { id: 'ram', memory: true, title: 'Old temporary files in memory', why: '/tmp lives in RAM.', bytes: GB, items: [{ path: '/tmp/scan', label: '/tmp/scan', bytes: GB, touched: Date.now() - 5 * 864e5 }] },
  ],
};

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mxstorage-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Fleet', cwd: path.join(dataDir, 'fleet'), mode: 'orchestrator', agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true, fallbacks: [] }]));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  await fakeWorker('studio-mac', 'darwin', 10);
  await fakeWorker('air-mac', 'darwin', 8);
});
after(async () => {
  await browser?.close();
  for (const ws of workers) ws.terminate();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(opts = {}) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [], sent = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Storage never reaches the real routes here: a scan or a removal on this machine's disk has no place in a test.
  await page.route('**/api/storage**', (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname === '/api/storage') return route.fulfill({ json: STORAGE });
    if (url.pathname === '/api/storage/dir') return route.fulfill({ json: { path: url.searchParams.get('path'), bytes: 2 * GB, more: 0, entries: [{ path: `${url.searchParams.get('path')}/data`, name: 'data', bytes: GB, dir: true, why: null }] } });
    sent.push([url.pathname, req.postDataJSON()]);
    return route.fulfill({ json: { removed: (req.postDataJSON().paths || []).map((p) => ({ path: p, bytes: GB })), skipped: [], freed: GB, disk: STORAGE.disk } });
  });
  await page.goto(`${base}/#${CID}`);
  await page.waitForFunction(() => !document.getElementById('app').inert);
  await page.evaluate(() => openMachines());
  await page.locator('#mxFleet .fl-row').nth(2).waitFor();
  return { ctx, page, errors, sent };
}
const toStorage = async (page) => {
  await page.locator('#mxFleet .fl-row', { hasText: 'This server' }).locator('.fl-open').click();
  await page.locator('#ndTabs [data-tab="storage"]').click();
  await page.locator('#ndStorage .st-sum').waitFor();
};

test('the view opens on a list: every machine on one row, its numbers lined up, Assign task kept, the diagram one tap away', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  assert.equal(await page.locator('#caWrap').isVisible(), false);
  const cols = await page.locator('#mxFleet .fl-row').evaluateAll((rows) => rows.map((r) => [...r.querySelectorAll('.fl-cell')].map((c) => Math.round(c.getBoundingClientRect().left))));
  assert.equal(cols.length, 3);
  assert.ok(cols.every((c) => c.length === 4 && c.join() === cols[0].join()), `columns line up: ${JSON.stringify(cols)}`);
  const head = await page.locator('#mxFleet .fl-head span').evaluateAll((s) => s.map((x) => [x.textContent, Math.round(x.getBoundingClientRect().left)]));
  assert.deepEqual(head.map((h) => h[0]), ['Machine', 'CPU', 'Memory', 'Disk free', 'Slots']);
  assert.deepEqual(head.slice(1).map((h) => h[1]), cols[0], 'the headers sit over their columns');
  const mac = page.locator('#mxFleet .fl-row', { hasText: 'studio-mac' });
  assert.match(await mac.textContent(), /40\.0 GB/);
  assert.match(await mac.textContent(), /0 of \d+/);
  assert.equal(await mac.getByRole('button', { name: /Assign task/ }).count(), 1, "the owner's rule: every machine keeps Assign task");
  assert.equal(await page.locator('#mxLanes').isVisible().catch(() => false), false, 'the queue does not repeat the machine list');
  await page.locator('#mxDiagBtn').click();
  await page.locator('#caWrap .cc').nth(2).waitFor();
  assert.equal(await page.locator('#mxFleet').isVisible(), false);
  assert.equal(await page.evaluate(() => localStorage.getItem('cw.mx.diagram')), '1');
  await page.locator('#mxDiagBtn').click();
  await page.locator('#mxFleet .fl-row').nth(2).waitFor();
  assert.equal(await page.locator('#caWrap').isVisible(), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a machine opens beside a rail of the others, one subject per tab, one close button', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  await page.locator('#mxFleet .fl-row', { hasText: 'studio-mac' }).click({ position: { x: 500, y: 20 } });
  await page.locator('#ndTabs').waitFor();
  const rail = await page.locator('#mxMain').evaluate((e) => e.getBoundingClientRect().width), side = await page.locator('#nodeModal').evaluate((e) => e.getBoundingClientRect().width);
  assert.ok(rail <= 281 && side > 800, `rail ${rail}, detail ${side}`);
  assert.equal(await page.locator('#mxFleet .fl-cell').first().isVisible(), false, 'the rail is names only');
  assert.equal(await page.locator('#mxFleet [aria-current]').textContent().then((t) => t.includes('studio-mac')), true);
  assert.deepEqual(await page.locator('#ndTabs button').allTextContents(), ['Activity', 'Settings', 'Log'], 'no Storage on a worker');
  assert.equal(await page.locator('#nodeModal [data-close].icon-btn').isVisible(), false);
  assert.equal((await page.locator('#ndBack').textContent()).trim(), 'All machines');
  assert.equal(await page.locator('#ndMachine').isVisible(), false);
  await page.locator('#ndTabs [data-tab="settings"]').click();
  assert.equal(await page.locator('#ndMachine .mc-set').isVisible(), true);
  assert.equal(await page.locator('#ndCharts').isVisible(), false);
  assert.equal(await page.locator('#ndMachine .mc-set > summary').isVisible(), false, 'always open here');
  // The rail switches machines and keeps the tab; Back shows the whole list.
  await page.locator('#mxFleet .fl-row', { hasText: 'air-mac' }).locator('.fl-open').click();
  await page.locator('#ndTitle', { hasText: 'air-mac' }).waitFor();
  assert.equal(await page.locator('#ndTabs [aria-selected="true"]').textContent(), 'Settings');
  await page.locator('#ndBack').click();
  assert.equal(await page.locator('#nodeModal').isVisible(), false);
  assert.equal(await page.locator('#mxFleet .fl-cell').first().isVisible(), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Storage: the split, what can go, a look inside, and nothing removed without a yes', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, sent } = await open();
  await toStorage(page);
  assert.match(await page.locator('.st-free').textContent(), /3\.5 GB free of 45 GB/);
  assert.equal(await page.locator('.st-head .status').textContent(), 'Nearly full');
  // One bar: a segment per category in the list's order, then free space, widths in proportion.
  const segs = await page.locator('.st-bar i').evaluateAll((s) => s.map((x) => [x.dataset.cat || 'free', x.getBoundingClientRect().width]));
  assert.deepEqual(segs.map((s) => s[0]), ['projects', 'system', 'other', 'free']);
  assert.ok(segs[0][1] > segs[1][1] * 2.5, `in proportion: ${JSON.stringify(segs)}`);
  assert.deepEqual(await page.locator('.st-list > .st-row .st-rl').allTextContents(), ['Projects', 'System', 'Not counted']);
  await page.locator('.st-list > .st-row[data-cat="system"]').hover();
  assert.match(await page.locator('.st-read').textContent(), /System · 6\.0 GB · 13% of the disk/);
  // Suggestions: RAM doesn't count as disk to win back.
  assert.match(await page.locator('.st-total').textContent(), /up to 3\.0 GB/);
  // A no changes nothing.
  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('button', { name: 'Remove workspace/a/node_modules' }).click();
  await page.waitForTimeout(150);
  assert.deepEqual(sent, []);
  // A yes says what it costs and how to restore it, and the row goes.
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); d.accept(); });
  await page.getByRole('button', { name: 'Remove workspace/a/node_modules' }).click();
  await page.getByRole('button', { name: 'Remove workspace/a/node_modules' }).waitFor({ state: 'detached' }).catch(() => {});
  assert.match(asked, /1\.5 GB/);
  assert.match(asked, /npm ci in ~\/workspace\/a/);
  assert.deepEqual(sent.shift(), ['/api/storage/remove', { paths: [`${P}/a/node_modules`] }]);
  // No path of its own: it goes by id.
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Remove 588 finished tasks' }).click();
  await page.waitForTimeout(150);
  assert.deepEqual(sent.shift(), ['/api/storage/clean', { id: 'transcripts' }]);
  // A category: the reason instead of Remove where it can't go; a folder measured on open, with crumbs back.
  await page.locator('.st-list > .st-row[data-cat="projects"]').click();
  await page.locator('.st-lhead', { hasText: 'Projects' }).waitFor();
  const big = page.locator('.st-item', { hasText: 'big' }), old = page.locator('.st-item', { hasText: 'old' });
  assert.match(await big.textContent(), /In use by npm start/);
  assert.equal(await big.getByRole('button', { name: /^Remove/ }).count(), 0);
  assert.equal(await old.getByRole('button', { name: /^Remove/ }).count(), 1);
  const sizes = await page.locator('.st-item .st-size').evaluateAll((s) => s.map((x) => Math.round(x.getBoundingClientRect().right)));
  assert.equal(new Set(sizes).size, 1, `sizes line up with or without a Remove: ${sizes}`);
  await old.locator('button.st-rt').click();
  await page.locator('.st-pathline', { hasText: `${P}/old` }).waitFor();
  await page.locator('.st-item', { hasText: 'data' }).waitFor();
  assert.deepEqual(await page.locator('.st-crumbs > :not(.st-sep)').allTextContents(), ['Storage', 'Projects', 'old']);
  await page.locator('.st-crumbs button', { hasText: 'Storage' }).click();
  await page.locator('.st-sum').waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phones get Storage too; their long machine page stays one page', { skip, timeout: 60000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  await page.route('**/api/storage**', (route) => route.fulfill({ json: STORAGE }));
  await page.goto(`${base}/#${CID}`);
  await page.waitForFunction(() => !document.getElementById('app').inert);
  await page.evaluate(() => openMachines());
  await page.locator('#mMachines .mc-open').first().waitFor();
  assert.equal(await page.locator('#mxFleet').isVisible(), false, 'phones keep their cards');
  await page.locator('#mMachines .mc-open', { hasText: 'This server' }).click();
  assert.deepEqual(await page.locator('#ndTabs button').allTextContents(), ['Overview', 'Storage']);
  assert.equal(await page.locator('#ndSet').count(), 1);
  await page.locator('#ndTabs [data-tab="storage"]').click();
  await page.locator('.st-sum').waitFor();
  assert.equal(await page.locator('#ndHist').isVisible(), false);
  const small = await page.locator('.st-rm').evaluateAll((b) => b.map((x) => x.getBoundingClientRect().height).filter((h) => h < 44));
  assert.deepEqual(small, [], '44pt targets');
  const over = await page.locator('#ndBody').evaluate((e) => e.scrollWidth - e.clientWidth);
  assert.ok(over <= 0, `no sideways scroll: ${over}`);
  await ctx.close();
});

test('the storage routes are for signed-in admins only', { skip, timeout: 30000 }, async () => {
  for (const [p, m, b] of [['/api/storage/dir?path=/', 'GET'], ['/api/storage/remove', 'POST', { paths: ['/nope'] }], ['/api/storage/clean', 'POST', { id: 'apt' }]]) {
    const r = await call(p, m, b, null);
    assert.equal(r.status, 401, `${p} without a session`);
  }
  const made = await call('/api/users', 'POST', { username: 'nia', name: 'Nia', password: 'nia-password-123' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'nia', password: 'nia-password-123' }) });
  const ck = login.headers.get('set-cookie').split(';')[0];
  for (const [p, m, b] of [['/api/storage', 'GET'], ['/api/storage/dir?path=/', 'GET'], ['/api/storage/remove', 'POST', { paths: ['/nope'] }], ['/api/storage/clean', 'POST', { id: 'apt' }]]) {
    const r = await call(p, m, b, ck);
    assert.equal(r.status, 403, `${p} as a user: ${JSON.stringify(r.body)}`);
  }
});
