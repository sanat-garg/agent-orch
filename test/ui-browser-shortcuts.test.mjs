// Saved site shortcuts in the built-in Browser view (public/browser.js bxs*): name and save the current http(s) page, reopen
// it through bv_nav (also after a reload), remove it; shortcuts are kept per signed-in user, machine and profile, and a
// profile's Clear removes only its own; a missing name or a non-http(s) page shows a clear message; at 390px the controls
// fit and are 44px; in Claude in Chrome mode they are hidden. /api/browser* is mocked and the socket's bv_* messages are
// captured (no real browser runs). CW_UI_SHOTS=1 saves screenshots into .agent-orch/shots/.
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
const PASSWORD = 'ui-browser-shortcuts-password';
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-browser-shortcuts-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1', AGENT_ORCH_BROWSER_HOME: path.join(tmp, 'home') } });
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
  const s = { errors: [], bv: [], clears: [] };
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
  await p.route('**/api/browser/clear', (r) => { s.clears.push(r.request().postDataJSON()); return json(r, { ok: true }); });
  await p.addInitScript(() => localStorage.setItem('cw.view', 'browser'));
  await p.goto(`${base}/`);
  await p.locator('#app:not([inert])').waitFor({ timeout: 20000 });
  return { ctx, p, s };
}
const serverSays = (p, msg) => p.evaluate((m) => window.bvOnServer(m), msg);
const page = (p, identity, url, role = 'control') => serverSays(p, { t: 'bv_state', node: 'mac', identity, url, title: '', active: false, takeover: false, role, task: null });
const opened = (s, identity) => waitFor(() => s.bv.some((m) => m.t === 'bv_open' && m.identity === identity && m.thumb === false), { timeout: 10000, message: `opens ${identity}: ${JSON.stringify(s.bv)}` });
const pick = async (p, s, identity) => { await p.locator('#bxProfile').selectOption(`mac/${identity}`); await opened(s, identity); };
const chips = (p) => p.locator('#bxSites .bx-site-open').allTextContents();
async function save(p, name) {
  await p.locator('#bxSitesName').fill(name);
  await p.locator('#bxSites').getByRole('button', { name: 'Save page' }).click();
}
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `ui-browser-shortcuts-${name}.png`) }); } };

test('save the current page under a name, reopen it through bv_nav (also after a reload), remove it', { skip, timeout: 120000 }, async () => {
  const { ctx, p, s } = await app({ viewport: { width: 1280, height: 860 } });
  try {
    await opened(s, 'work');
    assert.equal(await p.locator('#bxProfile').inputValue(), 'mac/work');
    await page(p, 'work', 'https://mail.google.com/mail/u/0/#inbox');
    assert.ok(await p.locator('#bxSites').isHidden(), 'closed until the star is pressed');
    await shot(p, 'desktop-before');
    await p.locator('#bxSitesBtn').click();
    assert.equal(await p.locator('#bxSitesBtn').getAttribute('aria-expanded'), 'true');
    await p.locator('#bxSites .bx-sites-empty', { hasText: 'No saved sites for work yet' }).waitFor();
    assert.match(await p.locator('#bxSites .bx-sites-cur').textContent(), /This page: https:\/\/mail\.google\.com\/mail\/u\/0\/#inbox/);
    await save(p, '  Inbox  ');
    await p.locator('#bxSites .bx-site-open', { hasText: 'Inbox' }).waitFor();
    assert.match(await p.locator('#bxSites .bx-sites-msg').textContent(), /Saved Inbox/);
    assert.equal(await p.locator('#bxSitesName').inputValue(), '', 'the name box clears');
    await page(p, 'work', 'https://calendar.google.com/calendar/r');
    await save(p, 'Calendar');
    assert.deepEqual(await chips(p), ['Inbox', 'Calendar']);
    // The same name again replaces that shortcut's address rather than adding a second one.
    await page(p, 'work', 'https://calendar.google.com/calendar/r/week');
    await save(p, 'calendar');
    assert.deepEqual(await chips(p), ['Inbox', 'calendar']);
    assert.equal(await p.locator('#bxSites .bx-site-open', { hasText: 'calendar' }).getAttribute('title'), 'https://calendar.google.com/calendar/r/week');
    await shot(p, 'desktop-after');
    // Stored in this browser, scoped by user, machine and profile.
    const uid = await p.evaluate(() => me.user?.id || 'admin');
    const stored = JSON.parse(await p.evaluate((k) => localStorage.getItem(k), `cw.bxSites:${uid}:mac/work`));
    assert.deepEqual(stored.map((x) => x.name), ['Inbox', 'calendar']);

    // Reopen after a reload: the shortcuts are still there and a click navigates through bv_nav, then the panel closes.
    s.bv.length = 0;
    await p.reload();
    await p.locator('#app:not([inert])').waitFor({ timeout: 20000 });
    await opened(s, 'work');
    await page(p, 'work', 'https://example.com/');
    await p.locator('#bxSitesBtn').click();
    assert.deepEqual(await chips(p), ['Inbox', 'calendar']);
    await p.locator('#bxSites .bx-site-open', { hasText: 'Inbox' }).click();
    await waitFor(() => s.bv.some((m) => m.t === 'bv_nav'), { timeout: 5000, message: 'navigates' });
    assert.deepEqual(s.bv.filter((m) => m.t === 'bv_nav'), [{ node: 'mac', identity: 'work', t: 'bv_nav', action: 'go', url: 'https://mail.google.com/mail/u/0/#inbox' }]);
    assert.ok(await p.locator('#bxSites').isHidden(), 'the panel closes after opening a site');

    // While another window (or a task) has control the shortcuts can't open, and say why.
    await page(p, 'work', 'https://mail.google.com/mail/u/0/#inbox', 'watch');
    await p.locator('#bxSitesBtn').click();
    assert.ok(await p.locator('#bxSites .bx-site-open', { hasText: 'Inbox' }).isDisabled(), 'disabled while watching');
    await page(p, 'work', 'https://mail.google.com/mail/u/0/#inbox');
    assert.ok(await p.locator('#bxSites .bx-site-open', { hasText: 'Inbox' }).isEnabled());

    // Remove: one goes, then the other, back to the empty state (and the key is gone).
    await p.getByRole('button', { name: 'Remove calendar' }).click();
    assert.deepEqual(await chips(p), ['Inbox']);
    await p.getByRole('button', { name: 'Remove Inbox' }).click();
    await p.locator('#bxSites .bx-sites-empty').waitFor();
    assert.equal(await p.evaluate((k) => localStorage.getItem(k), `cw.bxSites:${uid}:mac/work`), null);
    assert.deepEqual(s.errors, []);
  } finally { await ctx.close(); }
});

test('profile isolation: each profile and each signed-in user has its own shortcuts; Clear removes only that profile\'s', { skip, timeout: 120000 }, async () => {
  const { ctx, p, s } = await app({ viewport: { width: 1280, height: 860 } });
  try {
    await opened(s, 'work');
    await page(p, 'work', 'https://mail.google.com/');
    await p.locator('#bxSitesBtn').click();
    await save(p, 'Mail');
    await pick(p, s, 'default');
    await p.locator('#bxSites .bx-sites-empty', { hasText: 'No saved sites for default yet' }).waitFor();
    await page(p, 'default', 'https://news.ycombinator.com/');
    await save(p, 'HN');
    assert.deepEqual(await chips(p), ['HN']);
    await pick(p, s, 'work');
    assert.deepEqual(await chips(p), ['Mail'], 'work keeps only its own');
    const uid = await p.evaluate(() => me.user?.id || 'admin');

    // Another signed-in user in the same browser sees none of them.
    const other = await app({}, { ctx, user: { id: 'u-sam', name: 'Sam', role: 'admin', caps: {} } });
    await opened(other.s, 'work');
    await other.p.locator('#bxSitesBtn').click();
    await other.p.locator('#bxSites .bx-sites-empty', { hasText: 'No saved sites for work yet' }).waitFor();
    await page(other.p, 'work', 'https://github.com/');
    await save(other.p, 'GitHub');
    assert.deepEqual(await chips(other.p), ['GitHub']);
    await other.p.close();
    assert.deepEqual(JSON.parse(await p.evaluate(() => localStorage.getItem('cw.bxSites:u-sam:mac/work'))).map((x) => x.name), ['GitHub']);

    // Clear the default profile from the Profiles sheet: its shortcuts go, work's (and the other user's) stay.
    await p.locator('#bxManage').click();
    const row = p.locator('#bwBody .bw-row').filter({ has: p.locator('.cn-label', { hasText: /^default$/ }) });
    await row.getByRole('button', { name: 'Clear…' }).click();
    await waitFor(() => s.clears.length === 1, { timeout: 5000, message: 'Clear posts' });
    assert.deepEqual(s.clears[0], { node: 'mac', identity: 'default' });
    await waitFor(async () => (await p.evaluate((k) => localStorage.getItem(k), `cw.bxSites:${uid}:mac/default`)) === null, { timeout: 5000, message: 'default\'s shortcuts removed' });
    assert.deepEqual(JSON.parse(await p.evaluate((k) => localStorage.getItem(k), `cw.bxSites:${uid}:mac/work`)).map((x) => x.name), ['Mail']);
    assert.ok(await p.evaluate(() => localStorage.getItem('cw.bxSites:u-sam:mac/work')), 'another user\'s are untouched');
    assert.deepEqual(s.errors, []);
  } finally { await ctx.close(); }
});

test('invalid input: a missing name or a page that is not http(s) shows a clear message and saves nothing', { skip, timeout: 120000 }, async () => {
  const { ctx, p, s } = await app({ viewport: { width: 1280, height: 860 } });
  try {
    await opened(s, 'work');
    await page(p, 'work', 'https://mail.google.com/');
    await p.locator('#bxSitesBtn').click();
    const msg = p.locator('#bxSites .bx-sites-msg');
    await save(p, '   ');
    assert.equal(await msg.textContent(), 'Name the shortcut first.');
    assert.ok(await msg.evaluate((n) => n.classList.contains('err')));
    assert.ok(await p.locator('#bxSitesName').evaluate((n) => n === document.activeElement), 'the name box takes focus');
    for (const url of ['about:blank', 'chrome://settings/', 'data:text/html,hi', 'javascript:alert(1)', 'file:///etc/passwd', '', 'not a url']) {
      await page(p, 'work', url);
      assert.equal(await p.locator('#bxSites .bx-sites-cur').textContent(), 'Open an http or https page to save it here.', url);
      await save(p, 'Bad');
      assert.equal(await msg.textContent(), 'Only an http or https page can be saved: open a site first.', url);
    }
    await p.locator('#bxSites .bx-sites-empty').waitFor();
    assert.equal(await p.locator('#bxSitesName').inputValue(), 'Bad', 'the typed name is kept to try again');
    const uid = await p.evaluate(() => me.user?.id || 'admin');
    assert.equal(await p.evaluate((k) => localStorage.getItem(k), `cw.bxSites:${uid}:mac/work`), null, 'nothing saved');
    // Hand-edited or corrupt storage is ignored rather than breaking the panel.
    await p.evaluate((k) => localStorage.setItem(k, JSON.stringify([{ name: 'Evil', url: 'javascript:alert(1)' }, { name: '', url: 'https://x.test/' }, 7, { name: 'Ok', url: 'https://ok.test/' }])), `cw.bxSites:${uid}:mac/work`);
    await pick(p, s, 'default');
    await pick(p, s, 'work');
    assert.deepEqual(await chips(p), ['Ok']);
    await p.evaluate((k) => localStorage.setItem(k, '{not json'), `cw.bxSites:${uid}:mac/work`);
    await pick(p, s, 'default');
    await pick(p, s, 'work');
    await p.locator('#bxSites .bx-sites-empty').waitFor();
    assert.deepEqual(s.errors, []);
  } finally { await ctx.close(); }
});

test('iPhone (390px): the star and the panel fit with 44px targets; Claude in Chrome mode hides them', { skip, timeout: 120000 }, async () => {
  const { ctx, p, s } = await app({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  try {
    await opened(s, 'work');
    await page(p, 'work', 'https://mail.google.com/');
    await p.locator('#bxSitesBtn').tap();
    await save(p, 'Inbox');
    await save(p, 'A rather long shortcut name for the mail inbox');
    const box = (sel) => p.locator(sel).first().boundingBox();
    for (const sel of ['#bxSitesBtn', '#bxSites .bx-site-open', '#bxSites .bx-site-rm', '#bxSitesName', '#bxSites .bx-sites-form button']) {
      const b = await box(sel);
      assert.ok(b.height >= 44 && b.x >= 0 && b.x + b.width <= 390, `${sel} is a 44px target on screen: ${JSON.stringify(b)}`);
    }
    for (const sel of ['#bxSites', '#bxSites .bx-site']) {
      for (const b of await p.locator(sel).evaluateAll((ns) => ns.map((n) => n.getBoundingClientRect().toJSON()))) assert.ok(b.left >= 0 && b.right <= 390, `${sel} fits: ${JSON.stringify(b)}`);
    }
    assert.equal(await p.locator('#bxSitesName').evaluate((n) => getComputedStyle(n).fontSize), '16px', 'iOS does not zoom into the name box');
    const prompt = await box('#bxPrompt .box');
    assert.ok(prompt.y + prompt.height <= 844, `the prompt box stays on screen: ${JSON.stringify(prompt)}`);
    await shot(p, 'iphone');
    assert.deepEqual(s.errors, []);
  } finally { await ctx.close(); }

  // With a Claude in Chrome runner the view has no URL bar or canvas: no shortcuts either.
  const chrome = await app({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    { nodes: { ...NODES, runner: { mode: 'chrome', node: 'mac', name: 'Chrome on MacBook Air', label: 'Claude in Chrome on MacBook Air' } } });
  try {
    await chrome.p.locator('#bxDirect').waitFor();
    assert.ok(await chrome.p.locator('#bxSitesBtn').isHidden(), 'no star');
    assert.ok(await chrome.p.locator('#bxSites').isHidden(), 'no panel');
    assert.deepEqual(chrome.s.errors, []);
  } finally { await chrome.ctx.close(); }
});
