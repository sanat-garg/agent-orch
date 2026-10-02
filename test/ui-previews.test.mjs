// Live previews UI (public/previews.js): boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir, so no preview starts and
// Caddy is never touched) with one project that has a preview and two domains. Checks the new-project address field
// (none by default and never guessed, live availability states, posts the slug), the chat header link with its status, and the
// sidebar manager (projects with their addresses, domains, a slug change PUTs) on desktop and a 390px phone.
// Writes go through page.route mocks. Skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'previews-ui-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pvui-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const proj = path.join(dataDir, 'p', 'demo'), other = path.join(dataDir, 'p', 'notes');
  fs.mkdirSync(proj, { recursive: true }); fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([
    { id: 'c0', title: 'Demo', cwd: proj, mode: 'bypassPermissions', model: '', createdAt: 1, updatedAt: 2, repo: { full: 'me/demo', url: 'https://github.com/me/demo' } },
    { id: 'c1', title: 'Notes', cwd: other, mode: 'bypassPermissions', model: '', createdAt: 1, updatedAt: 1 },
  ]));
  fs.writeFileSync(path.join(dataDir, 'previews.json'), JSON.stringify({ domains: ['greygoose.baby', 'example.dev'],
    entries: { [proj]: { slug: 'demo-site', domain: 'greygoose.baby', port: 4990 } } }));
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
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(hash = '', mobile = false) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/${hash}`);
  await page.locator('#app:not([inert])').waitFor();
  return { ctx, page, errors };
}

test('new project: no address unless added; it checks live and is posted', { skip }, async () => {
  const { ctx, page, errors } = await open();
  try {
    const slug = page.locator('#pvDraftSlug'), check = page.locator('#pvDraftCheck');
    const addBtn = page.locator('.preview-line .pv-skip', { hasText: 'Add a live preview address' });
    // Nothing by default, even with a message that names the project.
    await addBtn.waitFor();
    await page.locator('#input').fill('Build a todo app with dark mode');
    assert.equal(await page.locator('.preview-line .pv-none').textContent(), 'None');
    assert.equal(await slug.count(), 0);
    await addBtn.click();
    assert.equal(await slug.inputValue(), '', 'not guessed from the project name');
    await slug.fill('todo-app-dark-mode');
    await page.waitForFunction(() => /todo-app-dark-mode\.greygoose\.baby is free/.test(document.getElementById('pvDraftCheck').textContent));
    assert.match(await check.getAttribute('class'), /\bok\b/);
    // Taken by another project, reserved, and an owner site already in the Caddyfile.
    await slug.fill('demo-site');
    await page.waitForFunction(() => /Taken by demo/.test(document.getElementById('pvDraftCheck').textContent));
    assert.match(await check.getAttribute('class'), /\bbad\b/);
    await slug.fill('www');
    await page.waitForFunction(() => /reserved/.test(document.getElementById('pvDraftCheck').textContent));
    // Skip hides the field again (nothing would be posted); it can come back.
    await page.locator('.preview-line .pv-skip').click();
    assert.equal(await page.locator('#pvDraftSlug').count(), 0);
    await addBtn.click();
    // Two domains: a picker, and the choice is posted with the slug.
    await slug.fill('My Todo');
    await page.locator('.preview-line select.pv-domain').selectOption('.example.dev');
    await page.waitForFunction(() => /my-todo\.example\.dev is free/.test(document.getElementById('pvDraftCheck').textContent));
    let posted = null;
    await page.route('**/api/convos', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Link GitHub first (test)' }) });
    });
    await page.locator('#composer').evaluate((f) => f.requestSubmit());
    await page.waitForFunction(() => document.querySelector('.notice.error'));
    assert.deepEqual({ slug: posted.newProject.slug, domain: posted.newProject.domain }, { slug: 'my-todo', domain: 'example.dev' });
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('the chat header links to the project preview with its status', { skip }, async () => {
  const { ctx, page, errors } = await open('#c0');
  try {
    const a = page.locator('#previewLink');
    await a.waitFor();
    assert.equal(await a.getAttribute('href'), 'https://demo-site.greygoose.baby');
    assert.match(await a.textContent(), /demo-site\.greygoose\.baby/);
    assert.equal(await a.locator('.pv-dot.stopped').count(), 1);
    assert.equal(await a.getAttribute('target'), '_blank');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('sidebar manager: every project, domains, and a slug change PUTs (desktop and 390px phone)', { skip }, async () => {
  for (const mobile of [false, true]) {
    const { ctx, page, errors } = await open('', mobile);
    try {
      if (mobile) await page.locator('#openSidebar').click();
      await page.locator('#previewsBtn').click();
      await page.locator('#pvBody .pv-row[data-cid="c0"]').waitFor();
      const demo = page.locator('.pv-row[data-cid="c0"]'), notes = page.locator('.pv-row[data-cid="c1"]');
      assert.equal(await demo.locator('input.pv-slug').inputValue(), 'demo-site');
      assert.match(await demo.locator('.pv-status').textContent(), /Stopped/);
      assert.equal(await demo.locator('a.btn').getAttribute('href'), 'https://demo-site.greygoose.baby');
      // No address guessed for a project without one; Add waits for a typed slug.
      assert.equal(await notes.locator('input.pv-slug').inputValue(), '');
      const add = notes.locator('button', { hasText: 'Add' });
      assert.equal(await add.isDisabled(), true);
      // A tap anywhere in the address box (not just on the typed text) focuses the slug.
      await notes.locator('.pv-https').click();
      assert.equal(await notes.locator('input.pv-slug').evaluate((n) => n === document.activeElement), true);
      await notes.locator('input.pv-slug').fill('my-notes');
      assert.equal(await add.isEnabled(), true);
      // The bare domain (no subdomain): the slug box goes away and Add PUTs '@'.
      let bare = null;
      await page.route('**/api/convos/c1/preview', (route) => {
        bare = route.request().postDataJSON();
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      });
      await notes.locator('select.pv-domain').selectOption('@example.dev');
      assert.equal(await notes.locator('input.pv-slug').isHidden(), true);
      await page.waitForFunction(() => /✓ example\.dev is free/.test(document.querySelector('.pv-row[data-cid="c1"] .pv-check').textContent));
      await add.click();
      await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('https://example.dev'));
      assert.deepEqual(bare, { slug: '@', domain: 'example.dev' });
      await page.locator('.toast').evaluateAll((ts) => ts.forEach((t) => t.remove()));
      assert.deepEqual(await page.locator('.pv-dname').allTextContents(), ['greygoose.baby', 'example.dev']);
      // A rename: the live check, then Save PUTs the slug and domain.
      let put = null;
      await page.route('**/api/convos/c0/preview', (route) => {
        put = route.request().postDataJSON();
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      });
      await demo.locator('input.pv-slug').fill('demo-two');
      await page.waitForFunction(() => /demo-two\.greygoose\.baby is free/.test(document.querySelector('.pv-row[data-cid="c0"] .pv-check').textContent));
      await demo.locator('button', { hasText: 'Save' }).click();
      await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('demo-two'));
      assert.deepEqual(put, { slug: 'demo-two', domain: 'greygoose.baby' });
      // Nothing sticks out sideways on the phone.
      const overflow = await page.evaluate(() => [...document.querySelectorAll('#pvBody *')].filter((n) => n.getBoundingClientRect().right > innerWidth + 1).map((n) => n.className));
      assert.deepEqual(overflow, [], `overflowing: ${overflow}`);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  }
});
