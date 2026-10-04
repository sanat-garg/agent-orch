// Schedules UI (public/schedules.js): boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir, so a queued task never runs)
// with one project, then drives the sidebar's Schedules sheet against the real API: the empty list, the editor (required
// fields, a preset → cron with its live preview), on/off, Run now, Delete and Escape, on desktop and a 390px phone.
// Skips when Playwright's Chromium can't launch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'schedules-ui-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const getJson = async (p) => (await fetch(base + p, { headers: { cookie } })).json();

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-scui-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const proj = path.join(dataDir, 'p', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([
    { id: 'c0', title: 'Demo', cwd: proj, mode: 'bypassPermissions', model: '', createdAt: 1, updatedAt: 2 },
  ]));
  const port = await freePort();
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
  // The chat's project row, as its first planner turn would make it (the server has already created the schema).
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.prepare('INSERT INTO projects (path, name, convo_id, created_at) VALUES (?, ?, ?, ?)').run(proj, 'demo', 'c0', Date.now() / 1000);
  db.close();
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(mobile = false) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => { if (r.status() === 404 && /\.(js|css)$/.test(new URL(r.url()).pathname)) errors.push(`404 ${r.url()}`); });
  await page.goto(`${base}/`);
  await page.locator('#app:not([inert])').waitFor();
  return { ctx, page, errors };
}

test('desktop: add a weekday schedule, switch it off, run it now, delete it', { skip }, async () => {
  const { ctx, page, errors } = await open();
  try {
    const sheet = page.locator('#schedModal');
    await page.locator('#schedBtn').click();
    await sheet.getByText('No schedules yet.').waitFor();

    await sheet.getByRole('button', { name: 'New schedule' }).click();
    const form = sheet.locator('.sc-form');
    await form.getByRole('button', { name: 'Add schedule' }).click();
    await form.locator('.sc-err', { hasText: 'Give it a title' }).waitFor();
    await form.getByPlaceholder('e.g. Morning inbox triage').fill('Morning triage');
    await form.getByPlaceholder(/What the task should do/).fill('List new issues.');
    await form.locator('select').nth(1).selectOption('weekdays');
    await form.locator('.sc-preview', { hasText: /Weekdays at 09:00/ }).waitFor();
    await form.getByPlaceholder('e.g. Morning inbox triage').press('Enter'); // Enter in a field saves and shows the list

    const row = sheet.locator('.sc-row', { hasText: 'Morning triage' });
    await row.locator('.sc-cron', { hasText: 'Weekdays at 09:00' }).waitFor();
    await row.getByText('Not run yet').waitFor();
    let [s] = (await getJson('/api/orch/schedules')).schedules;
    assert.equal(s.cron, '0 9 * * 1-5');
    assert.equal(s.enabled, true);

    await row.getByRole('switch').uncheck();
    await sheet.locator('.sc-row.off', { hasText: 'Morning triage' }).waitFor();
    [s] = (await getJson('/api/orch/schedules')).schedules;
    assert.equal(s.enabled, false);

    await row.getByRole('button', { name: 'Run now' }).click();
    await page.getByText(/Queued #\d+: Morning triage/).first().waitFor();
    await row.locator('.sc-meta', { hasText: /Last run #\d+/ }).waitFor();

    // Escape (even from a field) leaves the editor first, then closes the sheet.
    await row.getByRole('button', { name: 'Edit' }).click();
    await form.getByPlaceholder('e.g. Morning inbox triage').focus();
    await page.keyboard.press('Escape');
    await row.waitFor();
    assert.equal(await sheet.isHidden(), false);

    page.once('dialog', (d) => d.accept());
    await row.getByRole('button', { name: 'Delete' }).click();
    await sheet.getByText('No schedules yet.').waitFor();
    assert.deepEqual((await getJson('/api/orch/schedules')).schedules, []);
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('phone: the sidebar link opens the sheet; its buttons are 44pt touch targets', { skip }, async () => {
  const r = await fetch(base + '/api/orch/schedules', { headers: { cookie } });
  const { projects } = await r.json();
  const add = await fetch(`${base}/api/orch/projects/${projects[0].id}/schedules`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Nightly backup', prompt: 'Back up the DB.', cron: '30 2 * * *', tz: 'UTC' }) });
  assert.equal(add.status, 200);
  const { ctx, page, errors } = await open(true);
  try {
    await page.locator('#openSidebar').click();
    await page.locator('#schedBtn').click();
    const row = page.locator('#schedModal .sc-row', { hasText: 'Nightly backup' });
    await row.waitFor();
    for (const name of ['Run now', 'Edit', 'Delete']) {
      const box = await row.getByRole('button', { name }).boundingBox();
      assert.ok(box.height >= 44, `${name} is ${box.height}px tall`);
    }
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
