// Saved Browser task instructions (public/browser.js bxr*): the prompt box's Saved chip opens a panel to save the draft under a
// required name, insert one into the draft (appended to existing text, never sent by itself) and remove it; entries are kept in
// this browser's localStorage per signed-in user, machine and profile; at 390px the controls fit and are 44px. /api/browser* is
// mocked and the socket's bv_* messages are captured (no real browser runs). CW_UI_SHOTS=1 saves screenshots into .agent-orch/shots/.
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
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'ui-browser-recipes-password';
const SHOTS = process.env.CW_UI_SHOTS ? path.join(ROOT, '.agent-orch', 'shots') : null;
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, tmp, cookie, out = '';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-browser-recipes-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1', AGENT_ORCH_BROWSER_HOME: path.join(tmp, 'home') } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 60000);
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
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const NODES = { nodes: [{ id: 'mac', name: 'MacBook Air', local: false, online: true, capable: true,
  profiles: [{ identity: 'work', running: true, task: null }, { identity: 'default', running: false, task: null }] }] };

// A page with the Browser API mocked and the socket's bv_* traffic captured. ctxOpts.user: /api/me's user (else the real one).
async function app(opts, { ctx: given, user, nodes = NODES } = {}) {
  const [name, value] = cookie.split('=');
  const ctx = given || await browser.newContext(opts);
  if (!given) await ctx.addCookies([{ name, value, url: base }]);
  const p = await ctx.newPage();
  const s = { errors: [], bv: [], clears: [], tasks: [] };
  p.on('pageerror', (e) => s.errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => { const msg = JSON.parse(m); if (msg.t?.startsWith('bv_')) s.bv.push(msg); else server.send(m); });
    server.onMessage((m) => ws.send(m));
  });
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await p.route('**/api/status', async (r) => json(r, { ...(await (await r.fetch()).json()), claudeSignedIn: true }));
  if (user) await p.route('**/api/me', (r) => json(r, { user, usage: [] }));
  await p.route('**/api/browser', (r) => json(r, nodes));
  await p.route('**/api/browser/tasks?*', (r) => json(r, []));
  await p.route('**/api/browser/task', (r) => { s.tasks.push(r.request().postDataJSON()); return json(r, { taskId: 901 }); });
  await p.route('**/api/browser/clear', (r) => { s.clears.push(r.request().postDataJSON()); return json(r, { ok: true }); });
  await p.addInitScript(() => localStorage.setItem('cw.view', 'browser'));
  await p.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60000 }); // the app's own ready sign below; 'load' can lag on a busy machine
  await p.locator('#app:not([inert])').waitFor({ timeout: 60000 });
  return { ctx, p, s };
}
const opened = (s, identity) => waitFor(() => s.bv.some((m) => m.t === 'bv_open' && m.identity === identity && m.thumb === false), { timeout: 30000, message: `opens ${identity}: ${JSON.stringify(s.bv)}` });
const pick = async (p, s, identity) => { await p.locator('#bxProfile').selectOption(`mac/${identity}`); await opened(s, identity); };
const chips = (p) => p.locator('#bxRecipes .bx-recipe-ins').allTextContents();
const draft = (p) => p.locator('#bxInput').inputValue();
const key = async (p, identity) => `cw.bxRecipes:${await p.evaluate(() => me.user?.id || 'admin')}:mac/${identity}`;
const stored = async (p, k) => JSON.parse(await p.evaluate((x) => localStorage.getItem(x), k) || 'null');
async function save(p, name) {
  await p.locator('#bxRecipesName').fill(name);
  await p.locator('#bxRecipes').getByRole('button', { name: 'Save instruction' }).click();
}
async function openPanel(p) {
  if (await p.locator('#bxRecipes').isHidden()) await p.locator('#bxRecipesBtn').click();
  await p.locator('#bxRecipes').waitFor();
}
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `ui-browser-recipes-${name}.png`) }); } };
const INVOICES = 'Open the billing portal, download this month\'s invoices and list their totals.';

test('save the draft under a name, insert it after a reload (appending to a draft), remove it; nothing is sent by itself', { skip, timeout: 300000 }, async () => {
  const { ctx, p, s } = await app({ viewport: { width: 1280, height: 860 } });
  try {
    await opened(s, 'work');
    assert.ok(await p.locator('#bxRecipes').isHidden(), 'closed until the chip is pressed');
    await shot(p, 'desktop-before');
    await p.locator('#bxInput').fill(INVOICES);
    await p.locator('#bxRecipesBtn').click();
    assert.equal(await p.locator('#bxRecipesBtn').getAttribute('aria-expanded'), 'true');
    await p.locator('#bxRecipes .bx-recipes-empty').waitFor();
    assert.match(await p.locator('#bxRecipes .bx-recipes-note').textContent(), /Saved on this device only, for work/);
    await save(p, '  Invoices  ');
    await p.locator('#bxRecipes .bx-recipe-ins', { hasText: 'Invoices' }).waitFor();
    assert.match(await p.locator('#bxRecipes .bx-recipes-msg').textContent(), /Saved Invoices/);
    assert.equal(await p.locator('#bxRecipesName').inputValue(), '', 'the name box clears');
    assert.equal(await draft(p), INVOICES, 'the draft is kept');
    await p.locator('#bxInput').fill('Check the support inbox and summarise anything urgent.');
    await save(p, 'Inbox');
    // The same name (any case) replaces that instruction rather than adding a second one.
    await p.locator('#bxInput').fill('Check the support inbox and reply to anything urgent.');
    await save(p, 'inbox');
    assert.deepEqual(await chips(p), ['Invoices', 'inbox']);
    await shot(p, 'desktop-after');
    assert.deepEqual(await stored(p, await key(p, 'work')), [{ name: 'Invoices', text: INVOICES }, { name: 'inbox', text: 'Check the support inbox and reply to anything urgent.' }]);
    assert.deepEqual(s.tasks, [], 'saving sends nothing');

    // After a reload they are still there; insert fills a blank draft, then appends to one with text, and never sends.
    s.bv.length = 0;
    await p.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.locator('#app:not([inert])').waitFor({ timeout: 60000 });
    await opened(s, 'work');
    assert.equal(await draft(p), '');
    await openPanel(p);
    assert.deepEqual(await chips(p), ['Invoices', 'inbox']);
    await p.getByRole('button', { name: 'Insert Invoices' }).click();
    assert.equal(await draft(p), INVOICES);
    assert.ok(await p.locator('#bxRecipes').isHidden(), 'the panel closes after inserting');
    assert.ok(await p.locator('#bxInput').evaluate((n) => n === document.activeElement), 'the draft takes focus to edit');
    assert.ok(await p.locator('#bxSend').isEnabled(), 'Send is ready, but it is the owner who presses it');
    await p.locator('#bxInput').fill('Use the work card.\n');
    await openPanel(p);
    await p.getByRole('button', { name: 'Insert inbox' }).click();
    assert.equal(await draft(p), 'Use the work card.\n\nCheck the support inbox and reply to anything urgent.');
    await p.waitForTimeout(300);
    assert.deepEqual(s.tasks, [], 'inserting sends nothing');
    // The owner edits and sends through the normal Send path.
    await p.locator('#bxInput').press('End');
    await p.locator('#bxInput').type(' Then stop.');
    await p.locator('#bxSend').click();
    await waitFor(() => s.tasks.length === 1, { timeout: 5000, message: 'sent once' });
    assert.deepEqual(s.tasks[0], { prompt: 'Use the work card.\n\nCheck the support inbox and reply to anything urgent. Then stop.', identity: 'work', node: 'mac' });

    // Remove: one goes, then the other, back to the empty state (and the key is gone).
    await openPanel(p);
    await p.getByRole('button', { name: 'Remove inbox' }).click();
    assert.deepEqual(await chips(p), ['Invoices']);
    assert.match(await p.locator('#bxRecipes .bx-recipes-msg').textContent(), /Removed inbox/);
    await p.getByRole('button', { name: 'Remove Invoices' }).click();
    await p.locator('#bxRecipes .bx-recipes-empty').waitFor();
    assert.equal(await p.evaluate((k) => localStorage.getItem(k), await key(p, 'work')), null);
    assert.deepEqual(s.errors, []);
  } finally { await ctx.close(); }
});

test('isolation: each profile and each signed-in user has its own saved instructions', { skip, timeout: 300000 }, async () => {
  const { ctx, p, s } = await app({ viewport: { width: 1280, height: 860 } });
  try {
    await opened(s, 'work');
    await p.locator('#bxInput').fill('Reconcile the expense report.');
    await openPanel(p);
    await save(p, 'Expenses');
    await pick(p, s, 'default');
    await p.locator('#bxRecipes .bx-recipes-empty').waitFor();
    assert.match(await p.locator('#bxRecipes .bx-recipes-note').textContent(), /for default/);
    await p.locator('#bxInput').fill('Read the news headlines.');
    await save(p, 'News');
    assert.deepEqual(await chips(p), ['News']);
    await pick(p, s, 'work');
    assert.deepEqual(await chips(p), ['Expenses'], 'work keeps only its own');
    assert.deepEqual((await stored(p, await key(p, 'default'))).map((x) => x.name), ['News']);

    // Another signed-in user in the same browser sees none of them.
    const other = await app({}, { ctx, user: { id: 'u-sam', name: 'Sam', role: 'admin', caps: {} } });
    await opened(other.s, 'work');
    await openPanel(other.p);
    await other.p.locator('#bxRecipes .bx-recipes-empty').waitFor();
    await other.p.locator('#bxInput').fill('File the timesheet.');
    await save(other.p, 'Timesheet');
    assert.deepEqual(await chips(other.p), ['Timesheet']);
    await other.p.close();
    assert.deepEqual((await stored(p, 'cw.bxRecipes:u-sam:mac/work')).map((x) => x.name), ['Timesheet']);
    assert.deepEqual((await stored(p, await key(p, 'work'))).map((x) => x.name), ['Expenses'], 'the first user\'s are untouched');
    assert.deepEqual(s.errors, []);
  } finally { await ctx.close(); }
});

test('required input: a blank draft or a blank name shows a clear message and saves nothing; bad storage is ignored', { skip, timeout: 300000 }, async () => {
  const { ctx, p, s } = await app({ viewport: { width: 1280, height: 860 } });
  try {
    await opened(s, 'work');
    await openPanel(p);
    const msg = p.locator('#bxRecipes .bx-recipes-msg');
    await p.locator('#bxInput').fill('   \n ');
    await save(p, 'Empty');
    assert.equal(await msg.textContent(), 'Type an instruction in the box first.');
    assert.ok(await msg.evaluate((n) => n.classList.contains('err')));
    assert.ok(await p.locator('#bxInput').evaluate((n) => n === document.activeElement), 'the prompt box takes focus');
    await p.locator('#bxInput').fill('Download the bank statement.');
    await save(p, '   ');
    assert.equal(await msg.textContent(), 'Name the instruction first.');
    assert.ok(await p.locator('#bxRecipesName').evaluate((n) => n === document.activeElement), 'the name box takes focus');
    await p.locator('#bxRecipes .bx-recipes-empty').waitFor();
    assert.equal(await p.evaluate((k) => localStorage.getItem(k), await key(p, 'work')), null, 'nothing saved');
    assert.equal(await draft(p), 'Download the bank statement.', 'the draft is kept');
    assert.deepEqual(s.tasks, []);
    // Enter in the name box saves the instruction; it does not send the prompt.
    await p.locator('#bxRecipesName').fill('Statement');
    await p.locator('#bxRecipesName').press('Enter');
    await p.locator('#bxRecipes .bx-recipe-ins', { hasText: 'Statement' }).waitFor();
    assert.deepEqual(s.tasks, []);
    // The library is bounded: the oldest go first.
    await p.evaluate((k) => localStorage.setItem(k, JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ name: `R${i}`, text: `Step ${i}` })))), await key(p, 'work'));
    await save(p, 'Newest');
    const names = (await stored(p, await key(p, 'work'))).map((x) => x.name);
    assert.equal(names.length, 30);
    assert.equal(names[0], 'R1');
    assert.equal(names.at(-1), 'Newest');
    // Hand-edited or corrupt storage is ignored rather than breaking the panel.
    await p.evaluate((k) => localStorage.setItem(k, JSON.stringify([{ name: 'NoText', text: '  ' }, { name: '', text: 'x' }, 7, { name: 'Ok', text: 'Fine' }])), await key(p, 'work'));
    await pick(p, s, 'default');
    await pick(p, s, 'work');
    assert.deepEqual(await chips(p), ['Ok']);
    await p.evaluate((k) => localStorage.setItem(k, '{not json'), await key(p, 'work'));
    await pick(p, s, 'default');
    await pick(p, s, 'work');
    await p.locator('#bxRecipes .bx-recipes-empty').waitFor();
    assert.deepEqual(s.errors, []);
  } finally { await ctx.close(); }
});

test('iPhone (390px): the chip and the panel fit with 44px targets and the prompt box stays on screen', { skip, timeout: 300000 }, async () => {
  const { ctx, p, s } = await app({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  try {
    await opened(s, 'work');
    await p.locator('#bxRecipesBtn').tap();
    await p.locator('#bxInput').fill('Open the CRM and log today\'s calls.');
    await save(p, 'Calls');
    await save(p, 'A rather long instruction name for the CRM call log');
    const box = (sel) => p.locator(sel).first().boundingBox();
    for (const sel of ['#bxRecipesBtn', '#bxRecipes .bx-recipe-ins', '#bxRecipes .bx-recipe-rm', '#bxRecipesName', '#bxRecipes .bx-recipes-form button', '#bxSend']) {
      const b = await box(sel);
      assert.ok(b.height >= 44 && b.x >= 0 && b.x + b.width <= 390, `${sel} is a 44px target on screen: ${JSON.stringify(b)}`);
    }
    for (const sel of ['#bxRecipes', '#bxRecipes .bx-recipe', '#bxPrompt .box']) {
      for (const b of await p.locator(sel).evaluateAll((ns) => ns.map((n) => n.getBoundingClientRect().toJSON()))) assert.ok(b.left >= 0 && b.right <= 390, `${sel} fits: ${JSON.stringify(b)}`);
    }
    assert.equal(await p.locator('#bxRecipesName').evaluate((n) => getComputedStyle(n).fontSize), '16px', 'iOS does not zoom into the name box');
    const prompt = await box('#bxPrompt .box');
    assert.ok(prompt.y + prompt.height <= 844, `the prompt box stays on screen: ${JSON.stringify(prompt)}`);
    const panel = await box('#bxRecipes');
    assert.ok(panel.y + panel.height <= prompt.y + 1, `the panel sits above the prompt box: ${JSON.stringify({ panel, prompt })}`);
    await shot(p, 'iphone');
    await p.locator('#bxInput').fill('');
    await p.getByRole('button', { name: 'Insert Calls' }).tap();
    assert.equal(await draft(p), 'Open the CRM and log today\'s calls.');
    assert.deepEqual(s.tasks, []);
    assert.deepEqual(s.errors, []);
  } finally { await ctx.close(); }
});
