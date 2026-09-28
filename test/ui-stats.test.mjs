// The Stats sheet (public/stats.js): boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) with a few days of work seeded
// into the DB, a chat log and the usage log, then opens Stats from the sidebar and checks every tab renders the seeded
// numbers without page errors, the range buttons re-slice it, it fits a 375×667 phone with nothing sticking out sideways
// (tabs and a range menu chip on one short pinned row),
// and Escape closes it. Skips when Playwright's Chromium can't launch.
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
const PASSWORD = 'stats-ui-password';
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, failedIds;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-statsui-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const proj = path.join(dataDir, 'p', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: 'c0', title: 'Demo', cwd: proj, mode: 'orchestrator', agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1 }]));
  const now = Date.now();
  // Your messages over the last three days, each followed by the work it asked for.
  fs.mkdirSync(path.join(dataDir, 'logs'));
  const msgs = [];
  for (let d = 0; d < 3; d++) for (let k = 0; k < 4; k++) msgs.push({ t: 'user', text: `Please fix the sidebar layout and add tests for the queue, round ${d}-${k}`, ts: now - (d * 24 + k * 2 + 3) * 3600e3 });
  fs.writeFileSync(path.join(dataDir, 'logs', 'c0.jsonl'), msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
  fs.mkdirSync(path.join(dataDir, 'metrics'));
  const usage = [];
  for (let i = 0; i < 4; i++) for (const pct of [30, 70, 95]) usage.push({ t: now - (80 - i * 12) * 3600e3 + pct * 1000, agent: 'claude', kind: 'window', window: 'five_hour', pct, resetsAt: Math.round((now - (76 - i * 12) * 3600e3) / 1000) });
  usage.push({ t: now - 30 * 3600e3, agent: 'claude', kind: 'limit', status: 'hit', resetsAt: Math.round((now - 28 * 3600e3) / 1000), window: 'five_hour' });
  usage.push({ t: now - 28 * 3600e3, agent: 'claude', kind: 'limit', status: 'cleared', resetsAt: Math.round((now - 28 * 3600e3) / 1000), window: 'five_hour' });
  fs.writeFileSync(path.join(dataDir, 'metrics', 'usage.jsonl'), usage.map((u) => JSON.stringify(u)).join('\n') + '\n');

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
  // The server has migrated the DB; seed the work behind its back (WAL allows a second writer).
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  const s = now / 1000;
  const pid = Number(db.prepare('INSERT INTO projects (path, name, created_at) VALUES (?, ?, ?)').run(proj, 'demo', s - 4 * 86400).lastInsertRowid);
  // A paused project: left out of the Projects tab (unless picked in the project filter).
  db.prepare("INSERT INTO projects (path, name, status, created_at) VALUES (?, ?, 'paused', ?)").run(path.join(dataDir, 'p', 'old'), 'old-paused', s - 9 * 86400);
  // A paired worker (cluster.mjs's schema; the boot creates it only with the orchestrator on): task 0 ran there, the rest here.
  db.exec(`CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL, os TEXT, arch TEXT, token_hash TEXT UNIQUE,
    created_at INTEGER NOT NULL, last_seen INTEGER, status TEXT NOT NULL DEFAULT 'offline', inventory TEXT, resources TEXT,
    max_slots INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, draining INTEGER NOT NULL DEFAULT 0)`);
  db.prepare("INSERT INTO nodes (id, name, os, created_at, last_seen, status) VALUES ('mac1', 'Test MacBook', 'darwin', ?, ?, 'online')").run(Math.round(s - 86400), Math.round(s));
  const addT = db.prepare(`INSERT INTO tasks (project_id, kind, title, prompt, status, source, origin, created_at, started_at, finished_at, agent, model, ran_agent, ran_model, node_id)
    VALUES (?, 'work', ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const addR = db.prepare(`INSERT INTO runs (task_id, purpose, outcome, agent, input_tokens, output_tokens, cache_read_tokens, num_turns, started_at, finished_at, node_id)
    VALUES (?, 'work', ?, ?, 100, 2000, 90000, 12, ?, ?, ?)`);
  for (let i = 0; i < 12; i++) {
    const created = s - (i * 6 + 3) * 3600, agent = i % 4 === 3 ? 'codex' : 'claude', model = agent === 'codex' ? 'gpt-6-sol' : 'opus';
    const status = i === 5 ? 'cancelled' : 'done', reflect = i % 3 === 0;
    const id = Number(addT.run(pid, `Task number ${i} with a fairly long title that has to be truncated on phones`, status, reflect ? 'reflection' : 'planner', reflect ? 'reflection' : 'chat',
      created, created + 60, status === 'done' ? created + 1500 + i * 60 : created + 100, agent, model, agent, model, i === 0 ? 'mac1' : i === 1 ? 'controller' : null).lastInsertRowid);
    if (status === 'done') addR.run(id, i === 7 ? 'rate_limited' : 'ok', agent, created + 60, created + 1500 + i * 60, i === 0 ? 'mac1' : i === 1 ? 'controller' : null);
  }
  // Two failures for "Why tasks failed" (task 6 above is a plain cancel): a setup failure and a cancel cascading from #3.
  const addF = db.prepare("INSERT INTO tasks (project_id, kind, title, prompt, status, result, created_at, finished_at) VALUES (?, 'work', ?, 'x', ?, ?, ?, ?)");
  const setupId = Number(addF.run(pid, 'Worktree that would not lock', 'failed', 'setup failed: cannot lock ref', s - 3 * 3600, s - 2 * 3600).lastInsertRowid);
  const cascadeId = Number(addF.run(pid, 'Follow-up of task three', 'cancelled', 'cancelled with #3', s - 3 * 3600, s - 3600).lastInsertRowid);
  failedIds = [cascadeId, setupId];
  db.prepare("INSERT INTO events (ts, level, project_id, message) VALUES (?, 'info', ?, ?)").run(s - 7200, pid, '#3 moved before #2');
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

async function open(viewport, mobile) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/`);
  await page.locator('#app:not([inert])').waitFor();
  if (mobile) await page.locator('#openSidebar').click();
  await page.locator('#statsBtn').click();
  await page.locator('#sxBody .sx-grid').waitFor();
  return { ctx, page, errors };
}
const tab = async (page, id) => {
  await page.locator(`#sxTabs [data-tab="${id}"]`).click();
  await page.locator('#sxBody .sx-grid').waitFor();
};

test('desktop: Overview leads with shipped tasks; every tab renders the seeded work', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 1280, height: 900 }, false);
  await tab(page, 'overview');
  await page.locator('#sxRange [data-range="all"]').click();
  assert.equal(await page.locator('.sx-hero-num strong').textContent(), '11');
  assert.equal(await page.locator('.sx-tile').first().locator('.sx-label').textContent(), 'Agent time');
  assert.ok(await page.locator('.sx-insights li').count() >= 3, 'insights');
  assert.match(await page.locator('.sx-insights').textContent(), /5-hour windows peaked at 95% on average before resetting \(4 of 4 reached 90%\+\)/);
  assert.ok(await page.locator('.sx-heat-c .msg').count() >= 1, 'your messages on the heatmap');
  // Who worked when: always the last 30 days (not the range picker, not trimmed to the first active day), with blue
  // total squares for each day (end of row) and each hour of the day (bottom row), and details on hover.
  const heat = page.locator('.sx-card', { hasText: 'Who worked when' });
  assert.match(await heat.locator('.sx-card-sub').textContent(), /^Last 30 days · \d+(\.\d)? (h|min) of agent work on \d+ days?( · \d+% while you were away)?$/);
  assert.equal(await heat.locator('.sx-heat-row:not(.sx-heat-totlab)').count(), 30, 'a month of rows');
  assert.equal(await heat.locator('.sx-heat-dtot').count(), 30, 'a total square per day');
  assert.equal(await heat.locator('.sx-heat-htot').count(), 24, 'a total square per hour of day');
  const dayTips = await heat.locator('.sx-heat-dtot').evaluateAll((ds) => ds.map((d) => d.dataset.tip));
  assert.ok(dayTips.some((t) => /\n.+ of agent time · \d+ messages? from you$/.test(t)), dayTips.join(' | '));
  assert.ok(dayTips.filter((t) => /No agent work/.test(t)).length >= 20, 'quiet days are shown, not skipped');
  const colors = await heat.evaluate((h) => [getComputedStyle(h.querySelector('.sx-heat-dtot:not([data-t="0"])')).backgroundColor, getComputedStyle(h.querySelector('.sx-heat-c:not(.sx-heat-tot):not([data-s="0"])')).backgroundColor]);
  assert.notEqual(colors[0], colors[1], 'totals use their own color');
  assert.match(await heat.locator('.sx-heat-sum').textContent(), /^\d+(\.\d)?(h|min)$/);
  assert.equal(await heat.locator('.sx-heat-day, .msg.m, .msg.l').count(), 0, 'no day dots or big message dots');
  assert.equal(await heat.locator('.sx-heat-more').count(), 0, 'desktop shows every day');
  assert.equal(await heat.locator('.sx-heat-c:not([aria-label])').count(), 0, 'every cell has a text value');
  assert.match(await heat.locator('.sx-heat-c:not([data-tip])').first().getAttribute('title'), /No activity$/);
  // The range picker doesn't change it.
  await page.locator('#sxRange [data-range="24h"]').click();
  assert.equal(await page.locator('.sx-card', { hasText: 'Who worked when' }).locator('.sx-heat-dtot').count(), 30);
  await page.locator('#sxRange [data-range="all"]').click();
  const tip = await heat.locator('.sx-heat-c[data-tip]').evaluateAll((cs) => cs.map((c) => c.dataset.tip).find((t) => /of agent time/.test(t)));
  assert.match(tip, /^.+, \d+ (AM|PM)–\d+ (AM|PM)\n.+ of agent time.*\n(Claude|Codex).+\n#\d+ /, tip);
  assert.doesNotMatch(await heat.textContent(), /h\/h/, 'no "h/h" unit');
  await page.locator('.sx-heat-c[data-tip]').first().hover();
  assert.equal(await page.locator('#sxTip').isVisible(), true);
  // Why tasks failed: a bar per reason in plain words, then the latest failures with their reason under the title.
  const why = page.locator('.sx-card', { hasText: 'Why tasks failed' });
  assert.match(await why.locator('.sx-card-sub').textContent(), /^No one reason stands out: 3 failures across 3 reasons\.$/);
  const whyBars = await why.locator('.sx-bar-name').allTextContents();
  assert.ok(whyBars.includes('Setup failed') && whyBars.includes('Cancelled with a failed prerequisite') && whyBars.includes('Cancelled'), whyBars.join());
  assert.deepEqual(await why.locator('.sx-bar-val').allTextContents(), ['1', '1', '1']);
  const rows = await why.locator('.sx-td-name').evaluateAll((ns) => ns.map((n) => [n.querySelector('strong').textContent, n.querySelector('small').textContent]));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.slice(0, 2), [[`#${failedIds[0]} Follow-up of task three`, 'cancelled with #3'], [`#${failedIds[1]} Worktree that would not lock`, 'setup failed: cannot lock ref']]);

  await tab(page, 'you');
  assert.equal(await page.locator('.sx-tile .sx-value').first().textContent(), '12');
  assert.match(await page.locator('.sx-words').textContent(), /sidebar/);
  assert.equal(await page.locator('.sx-quote').count(), 0);
  assert.doesNotMatch(await page.locator('#sxBody').textContent(), /Where it began/, 'removed');

  await tab(page, 'agents');
  const models = await page.locator('.sx-table .sx-tr:not(.sx-th) .sx-td-name strong').allTextContents();
  assert.equal(models.length, 2, models.join());
  assert.equal(await page.locator('.sx-quota').count(), 1);

  await tab(page, 'projects');
  assert.match(await page.locator('.sx-model-head').first().textContent(), /demo/);
  assert.equal(await page.locator('.sx-model-head').count(), 1, 'only active projects');
  assert.doesNotMatch(await page.locator('#sxBody').textContent(), /old-paused/);
  assert.match(await page.locator('.sx-card-sub').first().textContent(), /^1 active project · 1 paused not shown$/);

  // Machines: one row per machine with its done count, and a busy-time share bar with a text legend.
  await tab(page, 'machines');
  const machine = (id) => page.locator(`.sx-machines .sx-tr[data-machine="${id}"]`);
  assert.equal(await machine('mac1').locator('.sx-td-name strong').textContent(), 'Test MacBook');
  assert.equal(await machine('controller').locator('.sx-td-name strong').textContent(), 'This server');
  assert.equal(await machine('mac1').locator('[data-label="Done"]').textContent(), '1');
  assert.equal(await machine('controller').locator('[data-label="Done"]').textContent(), '10');
  assert.match(await page.locator('.sx-card', { hasText: 'Busy time by machine' }).locator('.sx-legend').textContent(), /This server \d+%.*Test MacBook \d+%/);
  assert.equal(await page.locator('#sxTabs [role=tab]').count(), 5);
  await page.locator('#sxTabs [data-tab="machines"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#sxTabs [data-tab="overview"]').getAttribute('aria-selected'), 'true', 'arrow keys wrap across five tabs');

  // Ranges re-slice: nothing in the seeded data is in the last 24 hours but the newest few tasks.
  await tab(page, 'overview');
  await page.locator('#sxRange [data-range="24h"]').click();
  assert.equal(await page.locator('#sxRange [data-range="24h"]').getAttribute('aria-pressed'), 'true');
  assert.ok(Number(await page.locator('.sx-hero-num strong').textContent()) < 11);
  assert.match(await page.locator('.sx-card', { hasText: 'Why tasks failed' }).locator('.sx-card-sub').textContent(), /^No one reason stands out: 2 failures across 2 reasons\.$/);
  await page.locator('#sxRange [data-range="all"]').click();

  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#statsModal').isHidden(), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'statsBtn', 'focus goes back to the sidebar button');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('375×667: a bottom sheet with nothing sticking out sideways on any tab', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 375, height: 667 }, true);
  for (const id of ['overview', 'you', 'agents', 'projects', 'machines']) {
    await tab(page, id);
    const m = await page.evaluate(() => {
      const panel = document.querySelector('#statsModal .modal-panel'), r = panel.getBoundingClientRect();
      const wide = [...panel.querySelectorAll('*')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && (b.left < r.left - 0.5 || b.right > r.right + 0.5); })
        .map((e) => `${e.tagName.toLowerCase()}.${e.className}`).slice(0, 5);
      const body = document.getElementById('sxBody');
      return { left: r.left, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight, wide, pageW: document.documentElement.scrollWidth,
        bodyW: body.scrollWidth, bodyCW: body.clientWidth, headH: document.querySelector('#statsModal .m-head').getBoundingClientRect().height };
    });
    assert.ok(m.left >= 0 && m.right <= m.vw + 0.5 && m.bottom <= m.vh + 0.5, `${id}: panel outside the viewport ${JSON.stringify(m)}`);
    assert.ok(m.bottom >= m.vh - 0.5, `${id}: phones get a bottom sheet`);
    assert.deepEqual(m.wide, [], `${id}: content sticks out of the panel`);
    assert.ok(m.pageW <= m.vw && m.bodyW <= m.bodyCW, `${id}: scrolls sideways ${JSON.stringify(m)}`);
    assert.ok(m.headH < 80, `${id}: title and buttons stay on one line (${m.headH}px)`);
    const small = await page.evaluate(() => Math.min(...[...document.querySelectorAll('#sxTabs button, #sxBody .sx-table *')].map((e) => parseFloat(getComputedStyle(e).fontSize))));
    assert.ok(small >= 11, `${id}: ${small}px type`);
  }
  // UI-REVIEW #27: the pinned part above the scrolling body (grabber, title, tabs + range chip) stays short, the tabs and
  // the chip share one row, and the subtitle scrolls with the body.
  const pin = await page.evaluate(() => {
    const panel = document.querySelector('#statsModal .modal-panel'), body = document.getElementById('sxBody');
    return { pinned: body.getBoundingClientRect().top - panel.getBoundingClientRect().top, tabsTop: document.getElementById('sxTabs').offsetTop,
      chipTop: document.getElementById('sxRangeChip').offsetTop, subInBody: body.contains(document.getElementById('sxSub')) };
  });
  assert.ok(pin.pinned < 120, `pinned header is ${pin.pinned}px`);
  assert.equal(pin.chipTop, pin.tabsTop, 'tabs and range chip on one row');
  const tabTops = await page.locator('#sxTabs [role=tab]').evaluateAll((bs) => bs.map((b) => b.offsetTop));
  assert.equal(new Set(tabTops).size, 1, `five tabs on one row ${tabTops}`);
  const clipped = await page.locator('#sxTabs').evaluate((t) => [t, ...t.children].filter((e) => e.scrollWidth > e.clientWidth + 0.5).map((e) => e.textContent));
  assert.deepEqual(clipped, [], 'every tab label fits at 375pt');
  await tab(page, 'machines');
  assert.ok(await page.locator('.sx-machines .sx-tr[data-machine="mac1"]').isVisible());
  assert.equal(pin.subInBody, true, 'the subtitle scrolls with the body');
  assert.equal(await page.locator('#sxRange').isVisible(), false, 'range buttons wait behind the chip');
  await tab(page, 'overview');
  const chip = page.locator('#sxRangeChip');
  const all = await page.locator('.sx-hero-num strong').textContent();
  assert.match(await chip.textContent(), /^All ▾$/);
  await chip.click();
  assert.equal(await chip.getAttribute('aria-expanded'), 'true');
  const b24 = page.locator('#sxRange [data-range="24h"]');
  assert.ok((await b24.boundingBox()).height >= 44, '44pt rows in the range menu');
  await b24.click();
  assert.equal(await b24.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#sxRange').isVisible(), false, 'picking closes the menu');
  assert.match(await chip.textContent(), /^24h ▾$/);
  assert.ok(Number(await page.locator('.sx-hero-num strong').textContent()) < Number(all), 'the 24h range re-slices the data');
  assert.equal(await page.evaluate(() => localStorage.getItem('cw.sx.range')), '24h');
  await chip.click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#statsModal').isVisible(), true, 'Escape closes the menu first');
  assert.equal(await chip.getAttribute('aria-expanded'), 'false');
  await chip.click();
  await page.locator('#sxRange [data-range="all"]').click();
  assert.match(await chip.textContent(), /^All ▾$/);
  // UI-REVIEW #23 (still on Overview, range All): legible labels, a text value per cell, and at most 14 day rows until "Show all days".
  const heat = page.locator('.sx-card', { hasText: 'Who worked when' });
  const dayRows = () => heat.locator('.sx-heat-row:not(.sx-heat-totlab)').count();
  const few = await dayRows();
  assert.ok(few >= 1 && few <= 14, `${few} day rows on a phone`);
  const sizes = await heat.evaluate((h) => [...h.querySelectorAll('.sx-heat-h, .sx-heat-row, .sx-heat-sum')].map((e) => parseFloat(getComputedStyle(e).fontSize)));
  assert.ok(Math.min(...sizes) >= 11, `heatmap labels ${Math.min(...sizes)}px`);
  assert.ok(parseFloat(await heat.locator('.sx-heat-h').first().evaluate((e) => getComputedStyle(e).fontSize)) >= 11);
  assert.deepEqual((await heat.locator('.sx-heat-h').allTextContents()).filter(Boolean), ['12 AM', '6 AM', 'Noon', '6 PM', 'Day']);
  const unlabelled = () => heat.locator('.sx-heat-c').evaluateAll((cs) => cs.filter((c) => !c.getAttribute('aria-label')).length);
  assert.equal(await unlabelled(), 0, 'every cell has a text value');
  assert.match(await heat.locator('.sx-heat-c[data-tip]:not(.sx-heat-tot)').first().getAttribute('aria-label'), /^.+, \d+ (AM|PM)–\d+ (AM|PM)\. /);
  const more = heat.locator('button.sx-heat-more');
  assert.equal(await more.textContent(), 'Show all days');
  await more.click();
  assert.equal(await dayRows(), 30, 'all days after Show all days');
  assert.equal(await unlabelled(), 0);
  assert.equal(await more.textContent(), 'Show fewer');
  await more.click();
  assert.equal(await dayRows(), few);
  await ctx.close();
  assert.deepEqual(errors, []);
});
