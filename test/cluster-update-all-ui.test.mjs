// Update all (#458) in the Machines view. The button's label and each machine's update step (app.js updateAllLabel,
// rolloutText, pulled out of the source) are checked without a browser; then in a real browser against server.mjs (no
// orchestrator, temp data dir) with GET /api/cluster/nodes mocked: 'Update all · 2 behind v3.60' in the Machines header,
// its confirm sheet (each machine current → target, the CLI checkbox off, 'Update now' posting {nodes, clis}), the live
// steps and a failure's Retry on the cards, and 'All up to date' (disabled) once none are behind. The browser part skips
// when Chromium can't launch.
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
const ui = new Function([/^const plural = .*$/m, /^const behindNow = .*$/m, /^const rolloutActive = .*$/m, /^function updateAllLabel\(.*?^}$/ms,
  /^const UPDATE_STEPS = .*$/m, /^function rolloutText\(.*?^}$/ms].map(src).join('\n') + '\nreturn { updateAllLabel, rolloutText };')();
const PASSWORD = 'update-all-ui-password';
let browser, noBrowser = false;
try { browser = await chromium.launch(); } catch {
  const mac = macChromiumEnv();
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-update-all-ui-'));
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

const target = { sha: 'f'.repeat(40), build: 360, version: 'v3.60' };
const worker = (id, name, extra = {}) => ({ id, name, local: false, os: 'linux', arch: 'arm64', connected: true, enabled: true, status: 'online', build: 358, version: 'v3.58',
  behind: 2, inventory: { cores: 4, agents: [] }, resources: {}, tasks: [], used: 0, slots: 2, rollout: null, ...extra });

test('the label: how many are behind, all up to date, or the rollout under way; each step of a machine', () => {
  const { updateAllLabel, rolloutText } = ui;
  const nodes = [worker('a', 'A'), worker('b', 'B', { behind: 0 }), worker('c', 'C'), worker('d', 'D', { enabled: false }), { id: 'controller', local: true, enabled: true, headBehind: false }];
  assert.deepEqual([updateAllLabel(nodes, target, null).text, updateAllLabel(nodes, target, null).disabled], ['Update all · 2 behind v3.60', false]);
  const none = updateAllLabel(nodes.map((n) => ({ ...n, behind: 0 })), target, null);
  assert.deepEqual([none.text, none.disabled], ['All up to date', true]);
  assert.equal(updateAllLabel([{ id: 'controller', local: true, enabled: true, headBehind: true }], target, null).text, 'Update all · 1 behind v3.60', 'the head counts when behind');
  const rollout = { doneAt: null, nodes: [{ state: 'done' }, { state: 'updating' }, { state: 'queued' }] };
  assert.deepEqual([updateAllLabel(nodes, target, rollout).text, updateAllLabel(nodes, target, rollout).disabled], ['Updating… 1 of 3', true]);
  const at = rolloutText({ state: 'updating', stage: 'installing', clis: false }, target);
  assert.deepEqual(at.steps.map((s) => [s.label, s.on, s.done]), [['pausing tasks', false, true], ['pulling', false, true], ['installing', true, false], ['restarting', false, false]]);
  assert.ok(rolloutText({ state: 'updating', stage: 'clis', clis: true }, target).steps.some((s) => s.label === 'updating CLIs' && s.on));
  assert.equal(rolloutText({ state: 'done' }, target).text, 'Updated to v3.60 ✓');
  assert.equal(rolloutText({ state: 'failed', error: 'npm ci failed: ERESOLVE' }, target).text, 'Update failed: npm ci failed: ERESOLVE');
  assert.equal(rolloutText({ state: 'offline' }, target).text, 'Offline: will update when back online');
});

test('Machines view: Update all button, its confirm sheet, live progress with Retry, then All up to date', { skip: noBrowser }, async () => {
  const [name, value] = cookie.split('=');
  // Under 768px every machine card is listed at once (wider, each sits in its machine's side panel).
  const ctx = await browser.newContext({ viewport: { width: 760, height: 900 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let state = 'behind', posted = null;
  await page.route('**/api/cluster/nodes', async (route) => {
    const body = await (await route.fetch()).json();
    const local = body.nodes.find((n) => n.local);
    const rollout = state === 'updating' ? { startedAt: 1, doneAt: null, current: 'w1', nodes: [
      { id: 'w1', name: 'studio-mac', state: 'updating', stage: 'pulling', clis: true }, { id: 'w2', name: 'build-vps', state: 'failed', error: 'npm ci failed: ERESOLVE', clis: true }] } : null;
    const ro = (id) => rollout?.nodes.find((e) => e.id === id) || null;
    body.nodes = [{ ...local, headBehind: false },
      worker('w1', 'studio-mac', { os: 'darwin', used: 1, behind: state === 'done' ? 0 : 2, rollout: ro('w1') }),
      worker('w2', 'build-vps', { behind: state === 'done' ? 0 : 5, rollout: ro('w2') }),
      worker('w3', 'fresh-vps', { behind: 0, build: 360, version: 'v3.60' })];
    return route.fulfill({ json: { ...body, target, rollout } });
  });
  await page.route('**/api/cluster/update', async (route) => {
    posted = route.request().postDataJSON();
    state = 'updating';
    return route.fulfill({ json: { rollout: { nodes: [{ id: 'w1', state: 'updating' }, { id: 'w2', state: 'queued' }] } } });
  });
  await page.goto(base + '/');
  await page.evaluate(() => openMachines());
  const btn = page.locator('#updateAll');
  await btn.filter({ hasText: 'Update all · 2 behind v3.60' }).waitFor({ timeout: 10000 });
  assert.equal(await btn.isEnabled(), true);
  // Each outdated machine has its own Update; the up-to-date one doesn't.
  assert.equal(await page.locator('#mMachines .mc-node[data-node="w1"] .ua-btn').count(), 1);
  assert.equal(await page.locator('#mMachines .mc-node[data-node="w3"] .ua-btn').count(), 0);

  await btn.click();
  const sheet = page.locator('.ua-pop[role="dialog"]');
  await sheet.waitFor();
  assert.equal(await sheet.locator('h3').textContent(), 'Update all machines');
  assert.deepEqual(await sheet.locator('.ua-row').evaluateAll((rows) => rows.map((r) => [r.querySelector('.ua-name').textContent, r.querySelector('.ua-ver').textContent])),
    [['studio-mac', 'v3.58 → v3.60'], ['build-vps', 'v3.58 → v3.60']]);
  assert.match(await sheet.locator('.ua-row').first().textContent(), /its task pauses and resumes/);
  const box = sheet.locator('#uaClis');
  assert.equal(await box.isChecked(), false, 'the CLI update is off by default');
  assert.match(await sheet.locator('.ua-cli').textContent(), /Also update Claude Code and Codex CLIs/);
  await box.check();
  await sheet.locator('.ua-go', { hasText: 'Update now' }).click();
  await sheet.waitFor({ state: 'detached' });
  assert.deepEqual(posted, { nodes: ['w1', 'w2'], clis: true });

  // Live: the button counts, a card shows its step, a failed one says why with Retry.
  await btn.filter({ hasText: 'Updating… 1 of 2' }).waitFor({ timeout: 10000 });
  assert.equal(await btn.isDisabled(), true);
  const line = (id) => page.locator(`#mMachines .mc-node[data-node="${id}"] .ua-line`);
  assert.match(await line('w1').textContent(), /^Updating… pausing tasks → pulling → installing → updating CLIs → restarting$/);
  assert.equal(await line('w1').locator('b').textContent(), 'pulling');
  assert.match(await line('w2').textContent(), /Update failed: npm ci failed: ERESOLVE/);
  await line('w2').locator('.ua-retry', { hasText: 'Retry' }).click();
  await page.waitForFunction(() => true);
  assert.deepEqual(posted, { nodes: ['w2'], clis: true }, 'Retry re-sends that machine, with its CLI choice');

  state = 'done';
  await page.evaluate(() => loadMachines());
  await btn.filter({ hasText: 'All up to date' }).waitFor({ timeout: 10000 });
  assert.equal(await btn.isDisabled(), true);
  assert.deepEqual(errors.filter((e) => !/renderMetrics|load/i.test(e)), []);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await ctx.close();
});
