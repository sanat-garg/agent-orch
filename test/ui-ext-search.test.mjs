// Skills & tools search (ext.js) in a real browser against server.mjs (temporary HOME, data and port; no orchestrator).
// The fixture holds 26 local skills (Claude, Codex or both) and 14 synced ones from the Claude account, plus MCP servers
// and personas: the search matches names and descriptions case-insensitively, the All/Local/Synced filter uses each
// skill's source, counts read "n of total", no matches differs from an empty library, Clear resets, the field keeps
// focus while typing (even through a reload), and a filtered row opens its own entry, with EX.data left whole.
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
const PASSWORD = 'ext-search-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, root, home, dataDir, cookie;

const TOPICS = ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'release', 'changelog', 'deploy', 'docker', 'k8s', 'terraform', 'sql',
  'graphql', 'rest', 'auth', 'oauth', 'cache', 'queue', 'cron', 'email', 'sms', 'stripe', 'invoice', 'chart', 'map', 'i18n'];
const LOCAL = TOPICS.map((t, i) => ({ folder: `${t}-helper`, agents: i % 3 === 0 ? ['claude'] : i % 3 === 1 ? ['codex'] : ['claude', 'codex'],
  description: `Use when working with ${t.toUpperCase()} files in a project.` }));
// One local skill whose name never says what its description does.
LOCAL.push({ folder: 'tidy-up', agents: ['claude', 'codex'], description: 'Formats Markdown TABLES and lists consistently.' });
const SYNCED = ['brand-voice', 'pitch-deck', 'meeting-notes', 'okr-review', 'pdf-forms', 'hiring-loop', 'pricing-page',
  'roadmap', 'retro', 'onboarding', 'incident-review', 'sales-email', 'blog-post', 'press-kit'].map((f, i) => ({ folder: f,
  bucket: i % 2 ? 'bucket-a' : 'bucket-b/team', description: `Account skill ${i}: drafts the ${f.replace(/-/g, ' ')} the company way.` }));

function writeSkill(dir, folder, description) {
  fs.mkdirSync(path.join(dir, folder), { recursive: true });
  fs.writeFileSync(path.join(dir, folder, 'SKILL.md'), `---\nname: ${folder}\ndescription: ${JSON.stringify(description)}\n---\n# ${folder}\n`);
}

before(async () => {
  if (skip) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-extsearch-'));
  home = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  for (const d of [home, dataDir, path.join(root, 'proj')]) fs.mkdirSync(d, { recursive: true });
  for (const s of LOCAL) for (const a of s.agents) writeSkill(path.join(home, a === 'claude' ? '.claude/skills' : '.codex/skills'), s.folder, s.description);
  for (const s of SYNCED) writeSkill(path.join(home, '.claude/skills/synced', s.bucket), s.folder, s.description);
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
  const post = async (url, body) => {
    const res = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    assert.equal(res.status, 200, `${url}: ${await res.text()}`);
  };
  await post('/api/ext/mcp', { name: 'playwright', type: 'stdio', commandLine: 'npx -y @playwright/mcp@latest --headless', agents: ['claude', 'codex'], enabled: true });
  await post('/api/ext/mcp', { name: 'context7', type: 'http', url: 'https://mcp.context7.com/mcp', agents: ['claude'], enabled: true });
  await post('/api/ext/personas', { name: 'Staff engineer', description: 'Pragmatic, simple designs, tested', prompt: 'You are a staff engineer.' });
  await post('/api/ext/personas', { name: 'Teacher', description: 'Explains what and why, plainly', prompt: 'You are a teacher.' });
});
after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript(() => localStorage.setItem('cw.lastSeen', String(Date.now())));
  const page = await ctx.newPage();
  const errors = [], dialogs = [], requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/ext')) requests.push(r.url()); });
  await page.goto(`${base}/#c0`);
  await page.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => page.click('#splashSkip'));
  return { page, errors, dialogs, requests, ctx };
}
const names = (page) => page.$$eval('#extBody .ext-list .ext-open strong', (els) => els.map((e) => e.textContent));
const count = (page) => page.textContent('#extBody .ext-count');
const focused = (page) => page.evaluate(() => document.activeElement?.classList.contains('ext-q'));
const TOTAL = LOCAL.length + SYNCED.length;

test('search skills by name and description, filter by source, then open a filtered entry', { skip, timeout: 90000 }, async () => {
  const { page, errors, dialogs, requests, ctx } = await open();
  await page.evaluate(() => window.Ext.open('skills'));
  await page.waitForFunction((n) => document.querySelectorAll('#extBody .ext-list .ext-item').length === n, TOTAL);
  assert.equal(await count(page), `${TOTAL} skills`);
  const q = page.locator('#extBody .ext-q');
  assert.equal(await q.isVisible(), true);
  assert.equal(await page.locator('#extBody .ext-q-clear').isHidden(), true, 'no Clear before anything is typed');
  assert.deepEqual(await page.$$eval('#extBody .ext-src button', (bs) => bs.map((b) => [b.textContent, b.getAttribute('aria-pressed')])),
    [['All', 'true'], ['Local', 'false'], ['Synced', 'false']]);

  // Typing filters without a fetch per keystroke, and the field keeps focus (the same node) throughout.
  await q.click();
  const node = await q.elementHandle();
  const before = requests.length;
  await page.keyboard.type('PDF', { delay: 30 });
  assert.equal(requests.length, before, 'no request while typing');
  assert.deepEqual(await names(page), ['pdf-helper', 'pdf-forms']);
  assert.equal(await count(page), `2 of ${TOTAL} skills`);
  assert.equal(await focused(page), true);
  assert.equal(await node.evaluate((n) => n.isConnected && n === document.activeElement), true, 'the same input, never rebuilt');
  assert.equal(await page.evaluate(() => EX.data.skills.length), TOTAL, 'EX.data stays whole');

  // A reload (another tab changed skills) arrives mid-typing: the list refreshes, the field and its caret stay.
  await page.evaluate(() => window.Ext.changed('skills'));
  await page.waitForTimeout(300);
  await page.keyboard.type(' forms');
  assert.equal(await node.evaluate((n) => n === document.activeElement && n.value), 'PDF forms');
  assert.deepEqual(await names(page), ['pdf-forms'], 'every word must match, in the name or description');

  // Description-only matches, case-insensitively.
  await q.fill('tables');
  assert.deepEqual(await names(page), ['tidy-up']);
  await q.fill('THE COMPANY WAY');
  assert.equal((await names(page)).length, SYNCED.length);

  // Source: Local and Synced use each skill's source; the search narrows within it.
  await q.fill('');
  await page.click('#extBody .ext-src button[data-src="synced"]');
  assert.deepEqual((await names(page)).sort(), SYNCED.map((s) => s.folder).sort());
  assert.equal(await count(page), `${SYNCED.length} of ${TOTAL} skills`);
  assert.equal(await page.locator('#extBody .ext-list .ext-tag', { hasText: 'Synced' }).count(), SYNCED.length);
  await page.click('#extBody .ext-src button[data-src="local"]');
  assert.deepEqual((await names(page)).sort(), LOCAL.map((s) => s.folder).sort());
  assert.equal(await page.locator('#extBody .ext-list .ext-tag', { hasText: 'Synced' }).count(), 0);
  await q.fill('pdf');
  assert.deepEqual(await names(page), ['pdf-helper'], 'pdf-forms is synced, so Local leaves it out');
  assert.equal(await count(page), `1 of ${TOTAL} skills`);

  // No matches is not an empty library, and Clear resets the words and the source and refocuses the field.
  await q.fill('zzz-nothing');
  assert.equal(await page.locator('#extBody .ext-list').count(), 0);
  assert.equal(await page.textContent('#extBody .ext-nomatch'), 'No local skills match “zzz-nothing”. Clear search');
  assert.doesNotMatch(await page.textContent('#extBody'), /No skills yet/);
  assert.equal(await count(page), `0 of ${TOTAL} skills`);
  await page.click('#extBody .ext-nomatch button');
  assert.equal(await q.inputValue(), '');
  assert.equal(await focused(page), true);
  assert.equal((await names(page)).length, TOTAL);
  assert.equal(await page.getAttribute('#extBody .ext-src button[data-src="all"]', 'aria-pressed'), 'true');
  await q.fill('deploy');
  await page.click('#extBody .ext-q-clear');
  assert.equal((await names(page)).length, TOTAL);
  // Esc in a non-empty search clears it; the sheet stays open.
  await q.fill('docker');
  await page.keyboard.press('Escape');
  assert.equal(await q.inputValue(), '');
  assert.equal(await page.locator('#extModal').isVisible(), true);

  // Opening a filtered row opens that entry: a synced one is read-only; back returns to the same filtered list.
  await page.click('#extBody .ext-src button[data-src="synced"]');
  await q.fill('meeting');
  assert.deepEqual(await names(page), ['meeting-notes']);
  await page.click('#extBody .ext-open[data-key="meeting-notes"]');
  await page.locator('.ext-form').waitFor();
  assert.equal(await page.textContent('.ext-edit-head h3'), 'meeting-notes');
  assert.match(await page.textContent('.ext-form'), /Synced from your Claude account/);
  assert.equal(await page.locator('.ext-form-acts button[type="submit"]').count(), 0, 'no Save for a synced skill');
  assert.equal(await page.locator('.ext-form-acts .danger').count(), 0, 'no Delete for a synced skill');
  await page.click('.ext-form-acts button >> text=Done');
  await page.locator('#extBody .ext-list').waitFor();
  assert.equal(await page.locator('#extBody .ext-q').inputValue(), 'meeting');
  assert.deepEqual(await names(page), ['meeting-notes']);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.key), 'meeting-notes', 'focus returns to the row');

  // A local match opens its editable editor; a draft there still asks before it is dropped.
  await page.click('#extBody .ext-src button[data-src="all"]');
  await page.locator('#extBody .ext-q').fill('tables');
  await page.click('#extBody .ext-open[data-key="tidy-up"]');
  await page.locator('.ext-form').waitFor();
  assert.equal(await page.inputValue('input[name="name"]'), 'tidy-up');
  assert.equal(await page.inputValue('textarea[name="description"]'), 'Formats Markdown TABLES and lists consistently.');
  await page.fill('textarea[name="body"]', '# changed');
  await page.click('#extTab-mcp');
  assert.equal(await page.locator('#extTab-mcp').getAttribute('aria-selected'), 'true');
  assert.deepEqual(dialogs, ['Discard your changes?']);

  // Other tabs search their own entries and keep their own words; the skills search waits for the way back.
  await page.locator('#extBody .ext-list').waitFor();
  assert.equal(await page.locator('#extBody .ext-src').count(), 0, 'source filter is for skills only');
  assert.equal(await page.locator('#extBody .ext-q').inputValue(), '');
  assert.equal(await page.getAttribute('#extBody .ext-q', 'placeholder'), 'Search MCP servers');
  await page.locator('#extBody .ext-q').fill('context7.com');
  assert.deepEqual(await names(page), ['context7'], 'the URL is what the row shows');
  assert.equal(await count(page), '1 of 2 servers');
  const sw = page.locator('#extBody .ext-item .st-switch');
  await sw.click(); // toggling a filtered server still saves and keeps the filter
  await page.waitForFunction(() => EX.data.mcp.find((s) => s.name === 'context7').enabled === false);
  assert.deepEqual(await names(page), ['context7']);
  assert.equal(await sw.isChecked(), false);
  await page.click('#extTab-personas');
  await page.locator('#extBody .ext-q').fill('plainly');
  assert.deepEqual(await names(page), ['Teacher']);
  await page.click('#extTab-agents');
  assert.equal(await page.textContent('#extBody .ext-empty'), 'No subagents yet.', 'an empty library says so');
  assert.equal(await page.locator('#extBody .ext-search').isHidden(), true, 'nothing to search');
  await page.click('#extTab-skills');
  assert.equal(await page.locator('#extBody .ext-q').inputValue(), 'tables');
  assert.deepEqual(await names(page), ['tidy-up']);

  // Reopening the sheet starts with no search.
  await page.locator('#extBody .ext-q').focus();
  await page.keyboard.press('Escape'); // clears the search
  await page.keyboard.press('Escape'); // closes the sheet
  await page.locator('#extModal').waitFor({ state: 'hidden' });
  await page.evaluate(() => window.Ext.open('mcp'));
  await page.locator('#extBody .ext-list').waitFor();
  assert.equal(await page.locator('#extBody .ext-q').inputValue(), '');
  assert.equal((await names(page)).length, 2);
  assert.deepEqual(errors, []);
  await ctx.close();
});
