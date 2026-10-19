// Copy a persona (ext.js) in a real browser against server.mjs (temporary HOME, data and port; no orchestrator). A
// persona row's Copy opens the normal editor prefilled from it with a distinct name and no id: saving adds a new
// persona through POST /api/ext/personas, the original and every chat's persona stay put, Cancel adds nothing (asking
// first once something was typed), the server's validation still applies, a failed save keeps the draft, and on a
// phone the row's Copy is a 44px target and the editor fits the screen.
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
const PASSWORD = 'persona-copy-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, root, home, dataDir, cookie;

const TEACHER = { id: 'a1b2c3d4e5', name: 'Teacher', description: 'Explains what and why, plainly', prompt: 'You are a patient teacher. Explain plainly.', createdAt: 1, updatedAt: 1 };
const STAFF = { id: 'f6a7b8c9d0', name: 'Staff engineer', description: 'Pragmatic, simple designs, tested', prompt: 'You are a staff engineer.', createdAt: 2, updatedAt: 2 };
// "Teacher (copy)" is taken, so a copy of Teacher suggests "Teacher (copy 2)".
const TAKEN = { id: '0011223344', name: 'Teacher (copy)', description: '', prompt: 'An older copy.', createdAt: 3, updatedAt: 3 };
const ASSIGNED = { c0: TEACHER.id, c1: STAFF.id, c2: null };

before(async () => {
  if (skip) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-personacopy-'));
  home = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  for (const d of [home, path.join(dataDir, 'extensions'), path.join(root, 'proj')]) fs.mkdirSync(d, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'extensions', 'personas.json'), JSON.stringify({ personas: [TEACHER, STAFF, TAKEN] }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify(Object.entries(ASSIGNED).map(([id, persona], i) =>
    ({ id, title: `Chat ${i}`, cwd: path.join(root, 'proj'), mode: 'default', model: '', persona, createdAt: 1 + i, updatedAt: 1 + i }))));
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
});
after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function open(viewport, mobile = false) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript(() => localStorage.setItem('cw.lastSeen', String(Date.now())));
  const page = await ctx.newPage();
  const errors = [], dialogs = [], posts = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/ext/personas') posts.push(r.postDataJSON()); });
  await page.goto(`${base}/#c0`);
  await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
  await page.evaluate(() => window.Ext.open('personas'));
  await page.locator('#extBody .ext-list').waitFor();
  return { page, errors, dialogs, posts, ctx };
}
const api = async (url) => (await fetch(`${base}${url}`, { headers: { cookie } })).json();
const personas = async () => (await api('/api/ext/personas')).personas;
const assignments = async () => Object.fromEntries((await api('/api/convos')).filter((c) => c.id in ASSIGNED).map((c) => [c.id, c.persona ?? null]));
const names = (page) => page.$$eval('#extBody .ext-list .ext-open strong', (els) => els.map((e) => e.textContent));
const copyOf = async (page, name) => {
  await page.click(`#extBody .ext-copy[aria-label="Copy ${name}"]`);
  await page.locator('.ext-form').waitFor();
};

test('copy a persona, edit the draft and save it as a new persona; the original and the chats keep theirs', { skip, timeout: 90000 }, async () => {
  const { page, errors, dialogs, posts, ctx } = await open({ width: 1280, height: 860 });
  assert.equal(await page.locator('#extBody .ext-copy').count(), 3, 'every persona row has Copy');
  await copyOf(page, 'Teacher');
  assert.equal(await page.textContent('.ext-edit-head h3'), 'Copy of Teacher');
  assert.equal(await page.inputValue('input[name="name"]'), 'Teacher (copy 2)', 'a name no persona has');
  assert.equal(await page.inputValue('input[name="description"]'), TEACHER.description);
  assert.equal(await page.inputValue('textarea[name="prompt"]'), TEACHER.prompt);
  assert.equal(await page.evaluate(() => document.activeElement?.name), 'name', 'the name field has focus');
  assert.equal(await page.locator('.ext-starters').count(), 0, 'no starters: it already starts from Teacher');
  assert.equal(await page.locator('.ext-form-acts .danger').count(), 0, 'no Delete on a copy');
  assert.equal(await page.textContent('.ext-form-acts button[type="submit"]'), 'Add');
  assert.doesNotMatch(await page.textContent('.ext-form'), /Used by/);

  await page.fill('input[name="name"]', 'Strict teacher');
  await page.fill('input[name="description"]', 'Explains, then quizzes');
  await page.fill('textarea[name="prompt"]', `${TEACHER.prompt} End with a short quiz.`);
  await page.click('.ext-form-acts button[type="submit"]');
  await page.locator('#extBody .ext-list').waitFor();
  assert.equal(posts.length, 1);
  assert.equal('id' in posts[0], false, 'the copy is posted without the original id');
  assert.equal('prev' in posts[0], false);

  const list = await personas();
  assert.equal(list.length, 4);
  const made = list.find((p) => p.name === 'Strict teacher');
  assert.ok(made, 'a new persona exists');
  assert.notEqual(made.id, TEACHER.id);
  assert.match(made.id, /^[0-9a-f]{10}$/);
  assert.equal(made.description, 'Explains, then quizzes');
  assert.equal(made.prompt, `${TEACHER.prompt} End with a short quiz.`);
  const orig = list.find((p) => p.id === TEACHER.id);
  assert.deepEqual([orig.name, orig.description, orig.prompt, orig.updatedAt], [TEACHER.name, TEACHER.description, TEACHER.prompt, TEACHER.updatedAt], 'the original is untouched');
  assert.deepEqual(await assignments(), ASSIGNED, 'no chat changed persona');
  assert.equal(await page.evaluate(() => state.convos.find((c) => c.id === 'c0').persona), TEACHER.id);
  assert.ok((await names(page)).includes('Strict teacher'));
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.key), made.id, 'focus lands on the new row');
  assert.equal(await page.locator(`#extBody .ext-open[data-key="${TEACHER.id}"] .ext-tag`).textContent(), '1 chat');
  assert.equal(await page.locator(`#extBody .ext-open[data-key="${made.id}"] .ext-tag`).count(), 0, 'the copy has no chats');

  // The search finds the copy, and Copy works on a filtered row; a copy of a copy drops the old "(copy)".
  await page.locator('#extBody .ext-q').fill('quizzes');
  assert.deepEqual(await names(page), ['Strict teacher']);
  await copyOf(page, 'Strict teacher');
  assert.equal(await page.inputValue('input[name="name"]'), 'Strict teacher (copy)');
  await page.click('.ext-form-acts button >> text=Cancel');
  await page.locator('#extBody .ext-list').waitFor();
  await copyOf(page, 'Strict teacher');
  await page.click('.ext-form-acts button[type="submit"]');
  await page.locator('#extBody .ext-list').waitFor();
  await copyOf(page, 'Strict teacher (copy)');
  assert.equal(await page.inputValue('input[name="name"]'), 'Strict teacher (copy 2)');
  await page.click('.ext-form-acts button >> text=Cancel');
  assert.deepEqual(dialogs, [], 'an untouched copy closes without asking');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Cancel creates nothing, asking first once the copy was edited', { skip, timeout: 60000 }, async () => {
  const { page, errors, dialogs, posts, ctx } = await open({ width: 1280, height: 860 });
  const before = await personas();
  await copyOf(page, 'Staff engineer');
  await page.click('.ext-form-acts button >> text=Cancel');
  await page.locator('#extBody .ext-list').waitFor();
  assert.deepEqual(dialogs, []);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.key), STAFF.id, 'focus returns to the original row');

  await copyOf(page, 'Staff engineer');
  await page.fill('textarea[name="prompt"]', 'A different engineer.');
  await page.keyboard.press('Escape');
  await page.locator('#extBody .ext-list').waitFor();
  assert.deepEqual(dialogs, ['Discard your changes?']);
  assert.equal(posts.length, 0, 'nothing was posted');
  assert.deepEqual(await personas(), before);
  assert.deepEqual(await assignments(), ASSIGNED);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the copy still needs a name and instructions, and a failed save keeps the draft', { skip, timeout: 60000 }, async () => {
  const { page, errors, posts, ctx } = await open({ width: 1280, height: 860 });
  const before = await personas();
  await copyOf(page, 'Teacher');
  const err = page.locator('.ext-form .ext-err');
  const submit = () => page.click('.ext-form-acts button[type="submit"]');

  await page.fill('input[name="name"]', '  ');
  await submit();
  await err.waitFor();
  assert.equal(await err.textContent(), 'Name the persona');
  await page.fill('input[name="name"]', 'Teacher');
  await submit();
  await page.waitForFunction(() => document.querySelector('.ext-form .ext-err')?.textContent.includes('already exists'));
  assert.equal(await err.textContent(), 'A persona named Teacher already exists', 'the copy never overwrites the original');
  await page.fill('input[name="name"]', 'Night teacher');
  await page.fill('textarea[name="prompt"]', '');
  await submit();
  await page.waitForFunction(() => document.querySelector('.ext-form .ext-err')?.textContent === 'Describe how the persona works and talks');

  // The server fails: the editor stays open with every edit, Save works again and says what went wrong.
  await page.fill('textarea[name="prompt"]', 'Teaches after dark.');
  await page.route('**/api/ext/personas', (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Disk full"}' }) : r.continue()));
  await submit();
  await page.waitForFunction(() => document.querySelector('.ext-form .ext-err')?.textContent === 'Disk full');
  assert.equal(await page.locator('.ext-form').count(), 1, 'still in the editor');
  assert.equal(await page.inputValue('input[name="name"]'), 'Night teacher');
  assert.equal(await page.inputValue('input[name="description"]'), TEACHER.description);
  assert.equal(await page.inputValue('textarea[name="prompt"]'), 'Teaches after dark.');
  assert.equal(await page.isEnabled('.ext-form-acts button[type="submit"]'), true);
  assert.equal(await page.textContent('.ext-form-acts button[type="submit"]'), 'Add');
  assert.equal(await page.evaluate(() => EX.dirty), true, 'the draft still counts as unsaved');
  assert.ok(posts.every((b) => !('id' in b)), 'no attempt carried the original id');
  assert.deepEqual(await personas(), before, 'nothing was created or changed');

  await page.unroute('**/api/ext/personas');
  await submit();
  await page.locator('#extBody .ext-list').waitFor();
  const after = await personas();
  assert.equal(after.length, before.length + 1);
  assert.equal(after.find((p) => p.name === 'Night teacher')?.prompt, 'Teaches after dark.');
  assert.deepEqual(await assignments(), ASSIGNED);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('390×844 phone: Copy is a 44px target in the row and the copy editor fits with Add in reach', { skip, timeout: 60000 }, async () => {
  const { page, errors, ctx } = await open({ width: 390, height: 844 }, true);
  const row = await page.evaluate(() => {
    const b = document.querySelector('#extBody .ext-copy').getBoundingClientRect(), li = b && document.querySelector('#extBody .ext-item').getBoundingClientRect();
    const body = document.getElementById('extBody');
    return { h: b.height, w: b.width, right: b.right, liRight: li.right, overflow: body.scrollWidth - body.clientWidth };
  });
  assert.ok(row.h >= 44, `Copy is ${row.h}px tall`);
  assert.ok(row.right <= row.liRight, 'Copy stays inside its row');
  assert.equal(row.overflow, 0, 'no sideways scroll in the list');
  await copyOf(page, 'Teacher');
  const m = await page.evaluate(() => {
    const body = document.getElementById('extBody'), add = document.querySelector('.ext-form-acts button[type="submit"]').getBoundingClientRect();
    const name = document.querySelector('input[name="name"]');
    return { overflow: body.scrollWidth - body.clientWidth, addBottom: add.bottom, addH: add.height, vh: innerHeight, font: parseFloat(getComputedStyle(name).fontSize) };
  });
  assert.equal(m.overflow, 0, 'no sideways scroll in the editor');
  assert.ok(m.addBottom <= m.vh, 'Add is on screen');
  assert.ok(m.addH >= 44, 'Add is a 44px target');
  assert.ok(m.font >= 16, 'fields are 16px so iOS does not zoom');
  assert.deepEqual(errors, []);
  await ctx.close();
});
