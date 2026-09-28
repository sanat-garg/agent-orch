// Sidebar in a real browser (#456): server.mjs (no orchestrator, temp data dir) serves the app with GET /api/version mocked
// and the ws 'version' hello held back, so the version under the logo comes from /api/version; a later hello (a restart)
// updates it. The footer has no Sign out and no version label; the Connections window's 'agent-orch account' row has
// #logout, which asks first and only then POSTs /api/logout. The tooltip text (sideVerTip, pulled out of app.js's source)
// is also checked without a browser; the browser part skips when no Chromium can launch.
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
const sideVerTip = new Function([/^function sideVerTip\(.*$/m, /^function fmtWhen\(.*?^}$/ms, /^function fmtVersion\(.*$/m].map(src).join('\n') + '\nreturn sideVerTip;')();
const PASSWORD = 'signout-version-password';
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-signout-ver-'));
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

test('the version tooltip: version · short sha · restart time', () => {
  const startedAt = Date.now() - 3600e3;
  const clock = new Date(startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  assert.equal(sideVerTip({ build: 352, sha: 'a1b2c3d4e5f6', startedAt }), `v3.52 · a1b2c3d · restarted ${clock}`);
  assert.equal(sideVerTip({ build: 352 }), 'v3.52');
});

test('version under the logo, none in the footer; Sign out in Connections asks first', { skip: noBrowser, timeout: 60000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const startedAt = Date.now() - 3600e3;
  const running = { build: 352, sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', subject: 'Sidebar', committedAt: startedAt - 60e3, startedAt, serviceStartedAt: null };
  await page.route('**/api/version', (route) => route.fulfill({ json: { running, disk: { build: 352, sha: running.sha, subject: running.subject, ahead: 0 }, restart: { pending: false, reason: null, auto: false } } }));
  let logouts = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/logout') logouts++; }); // the real endpoint (temp server)
  let client;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    client = ws;
    const server = ws.connectToServer();
    server.onMessage((m) => { try { if (JSON.parse(m).t === 'version') return; } catch {} ws.send(m); }); // no hello: /api/version alone
  });
  await page.goto(base + '/');

  // The version sits under the title in .side-head, from GET /api/version.
  const ver = page.locator('.side-head #sideVer');
  await page.locator('.side-head #sideVer', { hasText: 'v3.52' }).waitFor({ timeout: 10000 });
  assert.equal((await ver.textContent()).trim(), 'v3.52');
  const clock = await page.evaluate((t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), startedAt);
  // Its tooltip holds what Settings → About used to show (#481).
  assert.match(await ver.getAttribute('title'), new RegExp(`^Running v3\\.52 \\(a1b2c3d\\) · "Sidebar"\\nRestarted .+ \\(${clock}\\) · up `));
  const m = await page.evaluate(() => {
    const t = document.querySelector('.side-title').getBoundingClientRect(), v = document.querySelector('#sideVer').getBoundingClientRect(), cs = getComputedStyle(document.querySelector('#sideVer'));
    return { below: v.top >= t.bottom - 1, size: parseFloat(cs.fontSize), nums: cs.fontVariantNumeric, head: document.querySelector('.side-head').getBoundingClientRect().height };
  });
  assert.ok(m.below, 'the version is a second line under the title');
  assert.ok(m.size >= 11 && m.size <= 12, `11–12px: ${m.size}`);
  assert.match(m.nums, /tabular-nums/);
  assert.ok(m.head <= 52, `the header stays compact: ${m.head}px`);

  // The footer: no Sign out, no version label.
  const foot = page.locator('.side-foot-row');
  assert.equal(await foot.locator('#logout').count(), 0);
  assert.equal(await page.locator('#buildFoot').count(), 0);
  assert.doesNotMatch(await foot.innerText(), /v\d+\.\d{2}|build|Sign out/i);

  // A restart: the ws hello carries the new build.
  client.send(JSON.stringify({ t: 'version', running: { ...running, build: 353 } }));
  await page.locator('#sideVer', { hasText: 'v3.53' }).waitFor();

  // Tapping it shows its details (the old About lines) as a toast; Settings has no About section (#481).
  await ver.click();
  await page.locator('.toast', { hasText: /^Running v3\.5\d|Running version unknown/ }).waitFor();
  assert.ok(await page.locator('#settingsModal').isHidden());

  // Connections: the agent-orch account row with Sign out, below the agents.
  await page.click('#connFoot');
  await page.locator('#connsModal:not([hidden])').waitFor();
  const btn = page.locator('#connsModal #logout');
  await btn.waitFor();
  assert.equal((await btn.textContent()).trim(), 'Sign out');
  assert.match(await btn.getAttribute('class'), /\bdanger\b/);
  assert.match(await page.locator('#connsModal .cn-account').innerText(), /agent-orch account[\s\S]*Signed in to agent-orch on this device/);
  assert.ok(await page.evaluate(() => {
    const list = document.querySelector('#connsList'), acct = document.querySelector('.cn-account');
    return list.compareDocumentPosition(acct) & Node.DOCUMENT_POSITION_FOLLOWING;
  }), 'the account row comes after the agent rows');

  // Cancel: nothing happens. OK: POST /api/logout, then the login page.
  const asked = [];
  page.once('dialog', (d) => { asked.push(d.message()); d.dismiss(); });
  await btn.click();
  await page.waitForTimeout(300);
  assert.deepEqual(asked, ['Sign out of agent-orch on this device?']);
  assert.equal(logouts, 0);
  page.once('dialog', (d) => { asked.push(d.message()); d.accept(); });
  await Promise.all([page.waitForURL(/\/login$/), btn.click()]);
  assert.equal(asked.length, 2);
  assert.equal(logouts, 1);
  assert.deepEqual(errors.filter((e) => !/renderMetrics|load/i.test(e)), []);
  await ctx.close();
});
