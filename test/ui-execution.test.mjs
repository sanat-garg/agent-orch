// Execution Mode's full page (execution.js): the sidebar button plays the transition and turns the page into
// Execution Mode (the app goes inert under it), its own sidebar lists New execution, the executions (each with its own
// page) and Connections, a reload comes back on the same page, and "Exit to Orchestrator" plays it back to the app. Boots
// server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir). Skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'exec-ui-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-execui-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  // One execution already started, so the sidebar has a project to open.
  const cwd = path.join(dataDir, 'ws', 'glow-dating'), cid = '11111111-1111-4111-8111-111111111111';
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: cid, title: 'glow-dating', cwd, mode: 'orchestrator', model: '', execution: true, createdAt: Date.now(), updatedAt: Date.now() }]));
  fs.writeFileSync(path.join(dataDir, 'executions.json'), JSON.stringify([{ id: 'e1', cid, cwd, name: 'glow-dating', createdAt: Date.now(), keys: [],
    intake: { idea: 'A dating app with one match a day.', products: { web: true, ios: true }, appTech: 'native', domain: { mode: 'none' }, services: [] } }]));
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
});

after(async () => {
  await browser?.close();
  child?.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('Execution Mode: the button turns the page into it, a reload stays, Exit returns to the app', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/`);
  await page.waitForFunction(() => !document.getElementById('app').inert);

  await page.click('#execBtn');
  await page.waitForSelector('#exSuit:not([hidden])', { timeout: 1000 }); // the veil plays
  await page.waitForSelector('#execView:not([hidden])', { timeout: 3000 });
  await page.waitForSelector('#exSuit', { state: 'hidden', timeout: 3000 });
  assert.equal(await page.evaluate(() => document.getElementById('app').inert), true);
  await page.waitForSelector('#exIdea');
  await page.waitForSelector('#exNav .exv-new[aria-current="page"]');
  await page.fill('#exIdea', 'A dating app with a paywall');
  // Choices are chips: a real checkbox under each pill.
  assert.equal(await page.isChecked('[data-k="p-ios"]'), false);
  await page.click('[data-k="p-ios"]');
  await page.waitForSelector('.ex-seg [data-k="t-react-native"]'); // the app technology appears once an app is chosen
  assert.equal(await page.isChecked('[data-k="p-ios"]'), true);

  // The project has its own page in the sidebar, with the brief.
  await page.click('#exNav .exv-item:has-text("glow-dating")');
  await page.waitForSelector('.exv-ptitle h1:has-text("glow-dating")');
  assert.match(await page.textContent('.exv-brief'), /one match a day[\s\S]*Website \/ web app, iOS app[\s\S]*Native/);
  // Connections lists the services.
  await page.click('#exNav .exv-conn');
  await page.waitForSelector('.exv-conns li');
  assert.match(await page.textContent('.exv-conns'), /GoDaddy/);

  await page.reload();
  await page.waitForSelector('#execView:not([hidden])', { timeout: 5000 });
  await page.waitForSelector('#exNav .exv-conn[aria-current="page"]'); // back on the same page
  await page.click('#exNav .exv-new');
  assert.equal(await page.inputValue('#exIdea'), 'A dating app with a paywall', 'the draft survives');
  assert.equal(await page.isChecked('[data-k="p-ios"]'), true);
  await page.waitForFunction(() => document.getElementById('splash') == null || document.getElementById('splash').classList.contains('done'));
  assert.equal(await page.evaluate(() => document.getElementById('app').inert), true, 'the splash leaves the app inert under the mode');

  await page.click('#exExit');
  await page.waitForSelector('#execView', { state: 'hidden', timeout: 3000 });
  await page.waitForSelector('#exSuit', { state: 'hidden', timeout: 3000 });
  assert.equal(await page.evaluate(() => document.getElementById('app').inert), false);
  assert.equal(await page.evaluate(() => localStorage.getItem('cw.exec.on')), null);
  assert.deepEqual(errors, []);
  await ctx.close();
});
