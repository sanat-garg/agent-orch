// The fallback sheet in a real browser: boots server.mjs (stub codex CLI with a wide catalog, CW_NO_ORCHESTRATOR=1, temp data dir) on a
// spare port. Chat: the composer's Fallbacks button opens it, and remove, undo, reorder (Alt+↑ and drag) and add each
// persist through PUT /api/convos/:id/fallbacks. Reflection: the Settings sheet opens the same sheet at once, without
// any request, and saves via PUT /api/orch/reflect-settings. Skips when Playwright's Chromium can't launch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedPath } from './helpers/isolated-path.mjs';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'fallbacks-ui-password';
const CID = 'chat-fb';
const START = [
  { agent: 'codex', model: 'gpt-6-sol' },
  { agent: 'codex', model: 'gpt-6-astra' },
  { agent: 'codex', model: 'gpt-6-nova' },
];
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, home, cookie, db, pid;
const PROJECT = () => path.join(dataDir, 'no-such-project');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fbui-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fbui-home-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Fallbacks', cwd: PROJECT(), mode: 'orchestrator',
    agent: 'codex', model: 'gpt-5.5', createdAt: 1, updatedAt: 1, fullAccess: true, fallbacks: START }]));
  const bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/codex-stub.mjs'), path.join(bin, 'codex'));
  const port = await freePort();
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  const PATH = isolatedPath(bin);
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH, CODEX_STUB_MODELS: 'wide', AA_API_KEY: '', CW_AA_BASE: 'http://127.0.0.1:9',
    PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  // PUT validates against discovered models: wait for the stub catalog.
  for (let i = 0; ; i++) {
    const a = await (await fetch(base + '/api/agents', { headers: { cookie } })).json();
    if (a.agents.find((x) => x.id === 'codex')?.models.length) break;
    if (i > 100) assert.fail('model discovery never finished');
    await new Promise((res) => setTimeout(res, 200));
  }
  // The chat's project (reflection fallbacks live on it) and a codex usage limit (the limited dot).
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  db.exec('PRAGMA busy_timeout=5000');
  pid = Number(db.prepare("INSERT INTO projects(path,name,status,convo_id,reflect_fallbacks,created_at) VALUES(?,?,'paused',?,?,0)")
    .run(PROJECT(), 'fb', CID, JSON.stringify([{ agent: 'codex', model: 'gpt-6-astra' }])).lastInsertRowid);
  db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)').run('blocked_until:codex', String(Math.floor(Date.now() / 1000) + 3600));
});

after(async () => {
  db?.close();
  await browser?.close();
  child?.kill('SIGKILL');
  for (const d of [dataDir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const saved = async () => (await (await fetch(base + '/api/convos', { headers: { cookie } })).json()).find((c) => c.id === CID).fallbacks;
const models = (list) => list && list.map((f) => f.model);
async function until(want, what) {
  let got;
  for (let i = 0; i < 50; i++) {
    got = models(await saved());
    if (JSON.stringify(got) === JSON.stringify(want)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(got, want, what);
}

test('chat fallbacks: the picker has no Auto Delegate; the sheet removes, undoes, reorders and adds via PUT /api/convos/:id/fallbacks', { skip, timeout: 90000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name, value, url: base }]);
  // A chat that had the old Auto Delegate flag: the flag is dropped (its list was already set, so it stays).
  await ctx.addInitScript((cid) => { if (!sessionStorage.seeded) { localStorage.setItem(`cw.auto.${cid}`, '1'); sessionStorage.seeded = 1; } }, CID);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${CID}`);
  const chip = page.locator('#fbChip');
  await page.waitForFunction(() => ((document.querySelector('#fbChip')?.getAttribute('aria-label') || '').match(/^Fallbacks: /) ? document.querySelector('#fbChip').getAttribute('aria-label').split(', then ').length : 0) === 3);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#model option')].some((o) => /auto/i.test(o.value + o.textContent))), false);
  assert.equal(await page.evaluate((cid) => localStorage.getItem(`cw.auto.${cid}`), CID), null);
  await chip.click();
  assert.equal(await page.locator('#fbTitle').innerText(), 'If GPT-5.5 hits its limit');
  const rows = page.locator('#fbModal .fe-list .fe-row');
  const names = () => rows.locator('.fe-model').allInnerTexts();
  await assert.doesNotReject(rows.nth(2).waitFor());
  assert.deepEqual(await names(), ['GPT-6-Sol', 'GPT-6-Astra', 'GPT-6-Nova']);
  assert.deepEqual(await rows.locator('.fe-pos').allInnerTexts(), ['1', '2', '3']);
  assert.deepEqual(await rows.locator('.fe-agent').allInnerTexts(), ['Codex', 'Codex', 'Codex']);
  // Codex is limited: a small dot on each of its models, nothing else about usage.
  assert.deepEqual(await rows.evaluateAll((els) => els.map((e) => !!e.querySelector('.fe-lim'))), [true, true, true]);
  assert.equal(await page.locator('#fbModal .fe-reset').count(), 0);

  // Remove the second model: saved at once, the composer button follows.
  await rows.nth(1).locator('.fe-rm').click();
  await until(['gpt-6-sol', 'gpt-6-nova'], 'remove persisted');
  assert.deepEqual(await names(), ['GPT-6-Sol', 'GPT-6-Nova']);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#fbChip .fb-name').length), 2);
  assert.match(await chip.getAttribute('aria-label'), /^Fallbacks: .+ \(.+\), then .+ \(.+\)$/, 'named, with usage status');
  // Undo from the toast puts it back in place.
  await page.locator('#toasts .toast-act').click();
  await until(['gpt-6-sol', 'gpt-6-astra', 'gpt-6-nova'], 'undo persisted');
  await rows.nth(1).locator('.fe-rm').click();
  await until(['gpt-6-sol', 'gpt-6-nova'], 'remove persisted again');

  // Move the (now) second model up with Alt+↑ on the focused row; focus stays on it.
  await rows.nth(1).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await until(['gpt-6-nova', 'gpt-6-sol'], 'Alt+↑ persisted');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.key), 'codex/gpt-6-nova');

  // Drag the second row above the first by its handle (pointer events, mouse).
  await page.waitForFunction(() => document.querySelector('#fbModal .fe-list .fe-row')?.dataset.key === 'codex/gpt-6-nova');
  await page.waitForTimeout(300);
  const grip = await rows.nth(1).locator('.fe-grip').boundingBox(), first = await rows.nth(0).boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y - 10, { steps: 4 });
  await page.mouse.move(grip.x + grip.width / 2, first.y + 4, { steps: 6 });
  await page.mouse.up();
  await until(['gpt-6-sol', 'gpt-6-nova'], 'drag persisted');

  // Add from the searchable picker; the primary model can't be added.
  await page.locator('#fbModal .fe-add-btn').click();
  await page.locator('#fbModal .fe-search').fill('gpt-5.5');
  assert.equal(await page.locator('#fbModal .fe-opt', { hasText: 'GPT-5.5' }).first().isDisabled(), true);
  await page.locator('#fbModal .fe-search').fill('lumen');
  await page.locator('#fbModal .fe-opt', { hasText: 'GPT-6-Lumen' }).click();
  await until(['gpt-6-sol', 'gpt-6-nova', 'gpt-6-lumen'], 'add persisted');
  // Removing every model leaves an empty list: tasks wait.
  for (let i = 0; i < 3; i++) await rows.nth(0).locator('.fe-rm').click();
  await until([], 'empty list persisted');
  await page.locator('#fbModal .fe-hint', { hasText: 'No fallbacks' }).waitFor();
  assert.equal(await chip.innerText(), 'No fallbacks');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('reflection fallbacks: the sidebar Settings sheet opens the same fallback sheet instantly, without any request, and saves for every project', { skip, timeout: 90000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const seed = await fetch(base + '/api/orch/reflect-settings', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ fallbacks: [{ agent: 'codex', model: 'gpt-6-astra' }] }) });
  assert.equal(seed.status, 200); await seed.json();
  await page.goto(`${base}/#${CID}`);
  await page.waitForLoadState('networkidle');
  await page.locator('#settingsBtn').click();
  await page.waitForFunction(() => ((document.querySelector('#stReflectBtn')?.getAttribute('aria-label') || '').match(/^Fallbacks: /) ? document.querySelector('#stReflectBtn').getAttribute('aria-label').split(', then ').length : 0) === 1);
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  // Rendered in the same task as the click: no fetch, no loading state.
  const shown = await page.evaluate(() => {
    document.querySelector('#stReflectBtn').click();
    return { open: !document.querySelector('#fbModal').hidden, title: document.querySelector('#fbTitle').textContent,
      rows: [...document.querySelectorAll('#fbModal .fe-row .fe-model')].map((e) => e.textContent) };
  });
  assert.equal(shown.open, true);
  assert.match(shown.title, /^If .+ hits its limit$/);
  assert.deepEqual(shown.rows, ['GPT-6-Astra']);
  await page.waitForTimeout(300);
  assert.deepEqual(requests, [], 'opening the reflection sheet fetches nothing');

  await page.locator('#fbModal .fe-add-btn').click();
  await page.locator('#fbModal .fe-search').fill('sol');
  await page.locator('#fbModal .fe-opt', { hasText: 'GPT-6-Sol' }).click();
  const stored = () => JSON.parse(db.prepare("SELECT value FROM kv WHERE key='reflect_settings'").get()?.value || '{}').fallbacks || [];
  for (let i = 0; i < 50 && stored().length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(stored(), [{ agent: 'codex', model: 'gpt-6-astra' }, { agent: 'codex', model: 'gpt-6-sol' }]);
  assert.ok(requests.some((u) => u.endsWith('/api/orch/reflect-settings')));
  assert.equal(await page.locator('#stReflectBtn .fb-name').count(), 2);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('task drawer: the Model chip shows model → fallbacks and opens the shared sheet; "Add fallback" when there are none', { skip, timeout: 90000 }, async () => {
  const resetChat = await fetch(base + '/api/convos/' + CID + '/fallbacks', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ fallbacks: START }) });
  assert.equal(resetChat.status, 200); await resetChat.json();
  const add = (fallbacks) => Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,agent,model,fallbacks,created_at) VALUES(?,'Task fallback editing','code','codex','gpt-5.5',?,0)")
    .run(pid, fallbacks && JSON.stringify(fallbacks)).lastInsertRowid);
  const id = add(START), none = add(null);
  const taskFb = async (id) => (await (await fetch(base + '/api/orch/task/' + id, { headers: { cookie } })).json()).task.fallbacks;
  const until = async (id, fn, what) => { for (let i = 0; i < 100; i++) { if (fn(await taskFb(id))) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(what); };
  const ctx = await browser.newContext();
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/#' + CID);
  await page.locator('#obQueue').waitFor();
  const open = async (id) => { await page.evaluate((id) => openTask(id), id); await page.locator('#drBody h3', { hasText: 'Model' }).waitFor(); };
  await open(id);
  // No separate Fallbacks section: one chip names the model and its fallbacks in order.
  assert.equal(await page.locator('#drBody h3', { hasText: /^Fallbacks$/ }).count(), 0);
  const chip = page.locator('#drBody .dr-model .dr-chip-btn').first();
  // The first name is the model it would run on now (codex is limited in this fixture, so that's the route's pick).
  assert.match(await chip.innerText(), /^[^→]+ → GPT-6-Sol → GPT-6-Astra → GPT-6-Nova$/);
  assert.equal(await page.locator('#drBody .dr-model button', { hasText: 'Add fallback' }).count(), 0);
  await chip.click();
  const rows = page.locator('#fbModal .fe-row');
  await rows.nth(2).waitFor();
  assert.match(await page.locator('#fbTitle').innerText(), /^If .+ hits its limit$/);
  // Reorder in the sheet: saved on the task, and the chip follows.
  await rows.nth(1).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await until(id, (f) => f[0].model === 'gpt-6-astra', 'reorder saved');
  await page.waitForFunction(() => / → GPT-6-Astra → GPT-6-Sol → GPT-6-Nova$/.test(document.querySelector('#drBody .dr-model .dr-chip-btn').textContent));
  // Now it differs from the chat's list: remove one, then reset to the chat's list.
  await rows.first().locator('.fe-rm').click();
  await until(id, (f) => f.length === 2, 'remove saved');
  await page.locator('#fbSub', { hasText: 'Custom list for this task' }).waitFor();
  await page.locator('#fbSub').getByRole('button', { name: "Reset to chat's list" }).click();
  await until(id, (f) => f.length === 3, 'reset saved');
  assert.deepEqual(await saved(), START);
  await page.keyboard.press('Escape');
  // A running task's sheet says when changes apply.
  db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(id);
  await page.reload();
  await page.locator('#obQueue').waitFor();
  await open(id);
  await page.locator('#drBody .dr-model .dr-chip-btn').first().click();
  await page.locator('#fbSub', { hasText: 'Changes apply from the next resume or limit event.' }).waitFor();
  await page.keyboard.press('Escape');
  // Finished: the chain is read-only text, and there's no "Add fallback".
  db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(id);
  await page.reload();
  await page.locator('#obQueue').waitFor();
  await open(id);
  assert.equal(await page.locator('#drBody .dr-model button').count(), 0);
  assert.match(await page.locator('#drBody .dr-model .tc-tag.model').innerText(), /^GPT-5.5 → /);
  // No fallbacks yet: "Add fallback", in the same chip style, opens the same sheet; adding one turns it into the chain.
  await open(none);
  const addBtn = page.locator('#drBody .dr-model button', { hasText: 'Add fallback' });
  assert.equal(await addBtn.getAttribute('class'), await page.locator('#drBody .dr-model .dr-chip-btn').first().getAttribute('class'));
  await addBtn.click();
  await page.locator('#fbModal .fe-add-btn').click();
  await page.locator('#fbModal .fe-search').fill('sol');
  await page.locator('#fbModal .fe-opt', { hasText: 'GPT-6-Sol' }).click();
  await until(none, (f) => f?.length === 1 && f[0].model === 'gpt-6-sol', 'add saved');
  await page.waitForFunction(() => / → GPT-6-Sol$/.test(document.querySelector('#drBody .dr-model .dr-chip-btn')?.textContent || ''));
  assert.equal(await page.locator('#drBody .dr-model button', { hasText: 'Add fallback' }).count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('reflection direction: typed or picked from presets in Settings → This project, saved per project; blank clears it', { skip, timeout: 90000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#${CID}`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => openSettings());
  const box = page.locator('#stDirection');
  await box.waitFor();
  const stored = () => db.prepare('SELECT reflect_direction AS d FROM projects WHERE id=?').get(pid).d;
  const until = async (want, what) => { for (let i = 0; i < 60; i++) { if (stored() === want) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(`${what}: ${stored()}`); };
  assert.equal(await box.inputValue(), '', 'optional: empty by default');
  assert.equal(stored(), null);
  await box.fill('Make the dashboard feel polished');
  await until('Make the dashboard feel polished', 'typed text saves');
  await page.locator('#stDirSaved', { hasText: 'Saved' }).waitFor();
  await page.locator('.st-presets .chip', { hasText: 'Security' }).tap();
  await until('Make the dashboard feel polished\nMake it more secure: authentication, password hashing, rate limits or captchas, input validation, secrets and permissions.', 'a preset adds a line');
  await page.locator('.st-presets .chip', { hasText: 'Security' }).tap();
  assert.equal((await box.inputValue()).match(/password hashing/g).length, 1, 'once');
  // A state push while it is shown doesn't clobber the box; clearing it goes back to "decide on your own".
  await page.evaluate(() => renderOrchBar());
  assert.match(await box.inputValue(), /polished/);
  await box.fill('');
  await box.blur();
  await until(null, 'blank clears it');
  await page.locator('#stDirSaved', { hasText: 'Cleared' }).waitFor();
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.st-presets .chip')].every((c) => c.getBoundingClientRect().right <= innerWidth));
  assert.equal(fits, true, 'fits 390px');
  assert.deepEqual(errors, []);
  await ctx.close();
});

// The bug: the chat was switched to Fable but the reflection fallback sheet still said Opus, because the project's
// default model only followed the chat on the next message and the sheet used the work route, not the reflection model.
test('fallback sheets name the model they back up: the chat\'s new model at once, and the reflection model for reflection', { skip, timeout: 90000 }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const queued = Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,created_at) VALUES(?,'Unrouted work','code',0)").run(pid).lastInsertRowid);
  const reset = await fetch(base + '/api/orch/reflect-settings', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ model: null }) });
  assert.equal(reset.status, 200); await reset.json();
  try {
    await page.goto(`${base}/#${CID}`);
    await page.waitForLoadState('networkidle');
    // The owner picks Fable for the chat: the project follows before any message is sent.
    await page.evaluate(() => send({ t: 'set_model', cid: state.cid, agent: 'claude', model: 'claude-fable-5-1' }));
    for (let i = 0; i < 50 && db.prepare('SELECT model FROM projects WHERE id=?').get(pid).model !== 'claude-fable-5-1'; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(db.prepare('SELECT model FROM projects WHERE id=?').get(pid).model, 'claude-fable-5-1');
    await page.waitForFunction(() => O.project?.reflect_route?.model === 'claude-fable-5-1');
    await page.waitForFunction((id) => O.tasks.get(id)?.runs_model === 'claude-fable-5-1', queued);
    await page.evaluate(() => openSettings());
    assert.match(await page.locator('#stReflectBtn').getAttribute('title'), /^If claude-fable-5-1 hits its limit, reflection tasks/);
    assert.match(await page.locator('#stReflectModel option').first().innerText(), /^Default · claude-fable-5-1/);
    await page.locator('#stReflectBtn').click();
    assert.equal(await page.locator('#fbTitle').innerText(), 'If claude-fable-5-1 hits its limit');
    await page.keyboard.press('Escape');
    // Its own model in Settings wins over the chat's.
    await page.locator('#stReflectModel').selectOption({ label: 'GPT-6-Sol' });
    await page.waitForFunction(() => /^If GPT-6-Sol hits its limit/.test(document.querySelector('#stReflectBtn').title));
    await page.locator('#stReflectBtn').click();
    assert.equal(await page.locator('#fbTitle').innerText(), 'If GPT-6-Sol hits its limit');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    // The chat's own sheet and a queued task's sheet name the chat's new model too.
    assert.match(await page.locator('#fbChip').getAttribute('title'), /^If claude-fable-5-1 hits its limit, queued tasks/);
    await page.evaluate((id) => openFallbacks(taskFallbacks(id), document.body), queued);
    assert.equal(await page.locator('#fbTitle').innerText(), 'If claude-fable-5-1 hits its limit');
    assert.deepEqual(errors, []);
  } finally {
    await page.evaluate(() => send({ t: 'set_model', cid: state.cid, agent: 'codex', model: 'gpt-5.5' })).catch(() => {});
    db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(queued);
    const r = await fetch(base + '/api/orch/reflect-settings', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ model: null }) });
    await r.arrayBuffer();
    await ctx.close();
  }
});
