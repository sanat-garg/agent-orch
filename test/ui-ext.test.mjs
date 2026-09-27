// Settings → Skills & tools (ext.js) in a real browser against server.mjs (temporary HOME, data and port; no
// orchestrator): a skill, an MCP server and a persona are added from the sheet, secrets come back masked, the composer's
// persona chip appears and sets the chat's persona, and on a phone the editor fits the screen with Save in reach.
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
const PASSWORD = 'ext-ui-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, root, home, dataDir, cookie;

before(async () => {
  if (skip) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-extui-'));
  home = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  for (const d of [home, dataDir, path.join(root, 'proj'), path.join(home, '.claude/skills/by-hand')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/skills/by-hand/SKILL.md'), '---\nname: by-hand\ndescription: >\n  Installed by hand,\n  outside agent-orch.\n---\nHi\n');
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: 'c0', title: 'Demo', cwd: path.join(root, 'proj'), mode: 'default', model: '', createdAt: 1, updatedAt: 1 }]));
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
  const errors = [], dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.goto(`${base}/#c0`);
  await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
  return { page, errors, dialogs, ctx };
}
const saved = (page) => page.locator('#extBody .ext-list').waitFor();

test('add a skill, an MCP server and a persona, then pick the persona for the chat', { skip, timeout: 90000 }, async () => {
  const { page, errors, dialogs, ctx } = await open({ width: 1280, height: 860 });
  await page.click('#settingsBtn');
  await page.waitForFunction(() => document.getElementById('stExtSummary').textContent === '1 skill');
  await page.click('[data-ext-open="skills"]');
  await saved(page);
  assert.equal(await page.locator('#extTab-skills').getAttribute('aria-selected'), 'true');
  assert.match(await page.textContent('#extBody .ext-list'), /by-hand\s*Installed by hand, outside agent-orch\./);
  assert.equal(await page.locator('#personaChip').isHidden(), true, 'no chip before any persona exists');

  await page.click('#extBody .ext-acts .btn.primary');
  await page.fill('input[name="name"]', 'release-notes');
  await page.fill('textarea[name="description"]', 'Use when: writing release notes.');
  await page.fill('textarea[name="body"]', '# Release notes');
  await page.click('.ext-form-acts button[type="submit"]');
  await saved(page);
  assert.match(fs.readFileSync(path.join(home, '.codex/skills/release-notes/SKILL.md'), 'utf8'), /description: "Use when: writing release notes\."/);

  await page.click('#extTab-mcp');
  await page.click('#extBody .ext-acts .btn.primary');
  await page.click('.ext-starters .chip >> nth=0'); // the Playwright example
  await page.fill('textarea[name="env"]', 'TOKEN=very-secret');
  await page.click('.ext-form-acts button[type="submit"]');
  await saved(page);
  await page.click('#extBody .ext-open');
  assert.equal(await page.inputValue('textarea[name="env"]'), 'TOKEN=••••••', 'secrets come back masked');
  await page.click('.ext-form-acts button[type="submit"]'); // saving the mask keeps the value
  await saved(page);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'extensions/mcp.json'), 'utf8')).servers[0].env.TOKEN, 'very-secret');

  // Esc leaves an editor, asking first once something was typed (the dialog is accepted here).
  await page.click('#extTab-personas');
  await page.click('#extBody .ext-acts .btn.primary');
  await page.fill('input[name="name"]', 'Draft');
  await page.keyboard.press('Escape');
  await saved(page).catch(() => page.locator('#extBody .ext-empty').waitFor());
  assert.deepEqual(dialogs, ['Discard your changes?']);
  await page.click('#extBody .ext-acts .btn.primary');
  await page.click('.ext-starters .chip >> nth=0'); // Staff engineer
  await page.click('.ext-form-acts button[type="submit"]');
  await saved(page);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#extModal').isHidden(), true);

  await page.locator('#personaChip').waitFor();
  await page.click('#personaChip');
  await page.click('#personaPop .cm-opt >> text=Staff engineer');
  await page.waitForFunction(() => document.getElementById('personaLabel').textContent === 'Staff engineer');
  const convo = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'convos.json'), 'utf8'))[0];
  for (let i = 0; i < 50 && !convo().persona; i++) await page.waitForTimeout(50);
  assert.match(convo().persona, /^[0-9a-f]{10}$/);
  await page.click('#personaChip');
  await page.click('#personaPop .cm-opt >> text=Manage personas…');
  await page.locator('#extModal:not([hidden]) #extTab-personas[aria-selected="true"]').waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('375×667: the editor fits the screen and Save stays on screen', { skip, timeout: 60000 }, async () => {
  const { page, errors, ctx } = await open({ width: 375, height: 667 }, true);
  await page.evaluate(() => window.Ext.open('mcp'));
  await saved(page);
  await page.click('#extBody .ext-open');
  await page.locator('.ext-form').waitFor();
  const m = await page.evaluate(() => {
    const body = document.getElementById('extBody'), save = document.querySelector('.ext-form-acts button[type="submit"]').getBoundingClientRect();
    return { overflow: body.scrollWidth - body.clientWidth, scrolls: body.scrollHeight > body.clientHeight, saveBottom: save.bottom, vh: innerHeight };
  });
  assert.equal(m.overflow, 0, 'no sideways scroll');
  assert.ok(m.scrolls, 'the form is taller than the sheet');
  assert.ok(m.saveBottom <= m.vh, 'Save is on screen while the form scrolls');
  assert.deepEqual(errors, []);
  await ctx.close();
});
