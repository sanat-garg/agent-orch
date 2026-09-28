// Settings → About in a real browser: server.mjs (no orchestrator, temp data dir) serves the app, GET /api/version is
// mocked and the ws 'version' frame is rewritten to build 419 (v4.19). Checks the About lines (running build, restart time and
// uptime, the build waiting on disk and its Restart button or "restarts when idle"), the sidebar's version label opening
// About, the "Updated to v4.19" toast for a browser that last saw an older build, and a worker's build and
// 'outdated' tag in the Machines view. The About text (aboutLines, pulled out of app.js's source like model-status.test)
// is also checked without a browser; the browser part skips when Playwright's Chromium can't launch.
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
import { findBrowser } from '../browser.mjs';
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const src = (re) => { const m = appJs.match(re); assert.ok(m, `app.js: ${re}`); return m[0]; };
const aboutLines = new Function([/^function aboutLines\(.*?^}$/ms, /^function relTime\(.*?^}$/ms, /^function fmtWhen\(.*?^}$/ms, /^function fmtDur\(.*?^}$/ms,
  /^function fmtVersion\(.*$/m].map(src).join('\n') + '\nreturn aboutLines;')();
const PASSWORD = 'version-ui-password';
let browser, noBrowser = false;
try { browser = await chromium.launch(); } catch {
  const mac = macChromiumEnv(); // the MacBook worker: Playwright's headless shell with the WindowManagement shim
  try { browser = await chromium.launch(mac.AGENT_ORCH_BROWSER_PATH ? { executablePath: mac.AGENT_ORCH_BROWSER_PATH, env: { ...process.env, DYLD_INSERT_LIBRARIES: mac.DYLD_INSERT_LIBRARIES } }
    : { executablePath: findBrowser() || undefined }); } catch (e) { noBrowser = `no Chromium: ${e.message.split('\n')[0]}`; }
}
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (noBrowser) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-version-ui-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await freePort();
  assert.notEqual(port, 3000);
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
});
after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('About lines from a mocked GET /api/version', () => {
  const now = Date.UTC(2026, 8, 28, 12, 0), startedAt = now - (2 * 3600 + 14 * 60) * 1000;
  const running = { build: 412, sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', subject: 'Show the running build', committedAt: startedAt - 60e3, startedAt, serviceStartedAt: null };
  const d = (disk, restart = { pending: false, reason: null, auto: false }) => aboutLines({ running, disk, restart }, now);
  const clock = new Date(startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const a = d({ build: 419, sha: 'f'.repeat(40), subject: 'Newer', ahead: 7 });
  assert.equal(a.running, 'Running v4.12 (a1b2c3d) · "Show the running build"');
  assert.equal(a.restarted, `Restarted 2h ago (${clock}) · up 2h 14m`);
  assert.match(a.runningTip, /^Committed /);
  assert.equal(a.pending, 'v4.19 ready (7 newer)');
  assert.equal(a.restartButton, true);
  // A restart on its way (asked for, or the owner's automatic restart): no button.
  for (const restart of [{ pending: true, reason: 'draining', auto: false }, { pending: false, reason: null, auto: true }]) {
    const b = d({ build: 413, sha: 'f'.repeat(40), subject: 'Newer', ahead: 1 }, restart);
    assert.equal(b.pending, 'v4.13 ready (1 newer) · restarts when idle');
    assert.equal(b.restartButton, false);
  }
  const same = d({ build: 412, sha: running.sha, subject: running.subject, ahead: 0 });
  assert.equal(same.pending, null);
  assert.equal(same.restartButton, false);
  assert.equal(aboutLines({ running: { startedAt }, disk: null, restart: {} }, now).running, 'Running version unknown (not a git checkout)');
  assert.equal(aboutLines({ running: { ...running, build: 709 }, disk: null }, now).running, 'Running v7.09 (a1b2c3d) · "Show the running build"');
  // Days later: the date is part of it, in this timezone.
  assert.match(aboutLines({ running, disk: null }, now + 3 * 86400e3).restarted, /^Restarted 3d ago \(\w{3} .+\) · up 74h 14m$/);
});

test('Settings → About renders the running build, restart time and the pending build', { skip: noBrowser }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('cw.build', '412'); sessionStorage.setItem('seeded', '1'); } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const startedAt = Date.now() - (2 * 3600 + 14 * 60) * 1000;
  const running = { build: 419, sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', subject: 'Show the running build', committedAt: startedAt - 60e3, startedAt, serviceStartedAt: null };
  let restart = { pending: false, reason: null, auto: false };
  let restartCalls = 0;
  await page.route('**/api/version', (route) => route.fulfill({ json: { running, disk: { build: 426, sha: 'f'.repeat(40), subject: 'Newer', ahead: 7 }, restart } }));
  await page.route('**/api/restart-when-idle', (route) => { restartCalls++; restart = { pending: true, reason: 'draining', auto: false }; return route.fulfill({ status: 202, json: { draining: true } }); });
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => { try { const f = JSON.parse(m); if (f.t === 'version') return ws.send(JSON.stringify({ t: 'version', running })); } catch {} ws.send(m); });
  });
  await page.goto(base + '/');

  // A browser that last saw build 412 is told about the update; the sidebar shows the build.
  await page.locator('.toast', { hasText: 'Updated to v4.19' }).waitFor({ timeout: 10000 });
  await page.locator('#buildFoot', { hasText: 'v4.19' }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('cw.build')), '419');

  await page.click('#buildFoot');
  await page.locator('#settingsModal:not([hidden])').waitFor();
  await page.locator('#abRunning', { hasText: 'Running v4.19' }).waitFor();
  assert.equal(await page.textContent('#abRunning'), 'Running v4.19 (a1b2c3d) · "Show the running build"');
  const restarted = await page.textContent('#abRestarted');
  const local = await page.evaluate((t) => fmtWhen(t), startedAt);
  assert.equal(restarted, `Restarted 2h ago (${local}) · up 2h 14m`);
  assert.equal(await page.textContent('#abPendingText'), 'v4.26 ready (7 newer)');
  assert.ok(await page.isVisible('#abRestart'));
  assert.ok(await page.evaluate(() => { const r = document.getElementById('stAboutTitle').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'About scrolled into view');

  await page.click('#abRestart');
  await page.locator('#abPendingText', { hasText: 'v4.26 ready (7 newer) · restarts when idle' }).waitFor();
  assert.equal(restartCalls, 1);
  assert.ok(await page.isHidden('#abRestart'));

  // Nothing newer on disk: no pending line. A reload with the same build doesn't toast again.
  await page.unroute('**/api/version');
  await page.route('**/api/version', (route) => route.fulfill({ json: { running, disk: { build: 419, sha: running.sha, subject: running.subject, ahead: 0 }, restart: { pending: false, reason: null, auto: false } } }));
  await page.reload();
  await page.locator('#buildFoot', { hasText: 'v4.19' }).waitFor();
  await page.click('#settingsBtn');
  await page.locator('#abRunning', { hasText: 'Running v4.19' }).waitFor();
  assert.ok(await page.isHidden('#abPending'));
  assert.equal(await page.locator('.toast', { hasText: 'Updated to v' }).count(), 0);
  assert.deepEqual(errors.filter((e) => !/renderMetrics|load/i.test(e)), []);
  await ctx.close();
});

test('the Machines view shows each machine\'s build and tags an outdated worker', { skip: noBrowser }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  await page.route('**/api/cluster/nodes', async (route) => {
    const body = await (await route.fetch()).json();
    const local = body.nodes.find((n) => n.local);
    body.nodes.push({ ...local, id: 'w1', name: 'studio-mac', local: false, os: 'darwin', build: 410, behind: 9, sha: 'e'.repeat(40), tasks: [], used: 0 },
      { ...local, id: 'w2', name: 'build-vps', local: false, build: local.build, behind: 0, sha: local.sha, tasks: [], used: 0 });
    return route.fulfill({ json: body });
  });
  await page.goto(base + '/');
  await page.locator('#miniStats').click();
  const card = (id) => page.locator(`#mMachines .mc-node[data-node="${id}"] .mc-name`);
  await card('w1').waitFor({ timeout: 10000 });
  assert.match(await card('w1').textContent(), /studio-mac.*v4\.10.*outdated/);
  assert.doesNotMatch(await card('w2').textContent(), /outdated/);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await ctx.close();
});
