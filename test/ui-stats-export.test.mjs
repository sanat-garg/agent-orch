// Stats → Export runs CSV (public/stats.js sxRunsCsv / sxExportRuns): boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data
// dir) with runs seeded across three projects, then downloads the CSV for several project/range filters and checks the
// rows (cut()'s overlap rule, seconds in range, whole-run token totals, unknown model / still-running end left empty),
// RFC 4180 quoting of a project name with a comma and quotes, the object URL being released, and the button being
// disabled while loading and when no runs match (with a visible reason). Skips when Playwright's Chromium can't launch.
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
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'stats-export-password';
const QUOTED = 'Acme, "beta"';
let browser, skip = false;
const macEnv = macChromiumEnv();
try { browser = await chromium.launch(macEnv.DYLD_INSERT_LIBRARIES
  ? { executablePath: macEnv.AGENT_ORCH_BROWSER_PATH, env: { ...process.env, DYLD_INSERT_LIBRARIES: macEnv.DYLD_INSERT_LIBRARIES } } : {}); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, ids, now;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sxexport-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
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
  // The server has migrated the DB; seed the work behind its back (WAL allows a second writer).
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  now = Date.now();
  const s = Math.floor(now / 1000);
  const addP = db.prepare('INSERT INTO projects (path, name, created_at) VALUES (?, ?, ?)');
  const pA = Number(addP.run(path.join(dataDir, 'p', 'a'), QUOTED, s - 9 * 86400).lastInsertRowid);
  const pB = Number(addP.run(path.join(dataDir, 'p', 'b'), 'plain', s - 9 * 86400).lastInsertRowid);
  const pC = Number(addP.run(path.join(dataDir, 'p', 'c'), 'idle', s - 9 * 86400).lastInsertRowid);
  const addT = db.prepare(`INSERT INTO tasks (project_id, kind, title, prompt, status, created_at, started_at, finished_at, agent, model, ran_agent, ran_model)
    VALUES (?, 'work', ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?)`);
  const addR = db.prepare(`INSERT INTO runs (task_id, purpose, outcome, agent, input_tokens, output_tokens, cache_read_tokens, num_turns, started_at, finished_at)
    VALUES (?, 'work', ?, ?, ?, ?, ?, 3, ?, ?)`);
  // A: an old Claude run (3 days ago, one hour long) and a Codex run with no recorded model that straddles the 24h edge.
  const tA1 = Number(addT.run(pA, 'Old work', 'done', s - 3 * 86400, s - 3 * 86400, s - 3 * 86400 + 3600, 'claude', 'opus', 'claude', 'opus').lastInsertRowid);
  const tA2 = Number(addT.run(pA, 'Edge, "work"', 'done', s - 25 * 3600, s - 25 * 3600, s - 23 * 3600, 'codex', null, 'codex', null).lastInsertRowid);
  // B: a Claude run still going (no end, no outcome yet), started two hours ago.
  const tB1 = Number(addT.run(pB, 'Running', 'running', s - 2 * 3600, s - 2 * 3600, null, 'claude', 'sonnet', 'claude', 'sonnet').lastInsertRowid);
  addR.run(tA1, 'ok', 'claude', 1234, 5678, 901234, s - 3 * 86400, s - 3 * 86400 + 3600);
  addR.run(tA2, 'rate_limited', 'codex', 40, 50, 60, s - 25 * 3600, s - 23 * 3600);
  addR.run(tB1, null, 'claude', 0, 0, 0, s - 2 * 3600, null);
  ids = { pA, pB, pC, tA1, tA2, tB1, s };
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

// RFC 4180: fields split on commas outside quotes, "" is a literal quote, records end with CRLF.
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; }
    else f += ch;
  }
  assert.equal(row.length + f.length, 0, 'the file ends with a CRLF');
  return rows;
}
const HEAD = ['Project', 'Task ID', 'Agent', 'Model', 'Started (UTC)', 'Ended (UTC)', 'Outcome', 'Seconds in range',
  'Input tokens (whole run)', 'Output tokens (whole run)', 'Cache tokens (whole run)'];

async function openStats({ delayStats } = {}) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Record object URLs made and released.
  await page.addInitScript(() => {
    window.__urls = { made: [], freed: [] };
    const mk = URL.createObjectURL.bind(URL), rm = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (b) => { const u = mk(b); window.__urls.made.push(u); return u; };
    URL.revokeObjectURL = (u) => { window.__urls.freed.push(u); rm(u); };
  });
  let release;
  if (delayStats) {
    const gate = new Promise((r) => { release = r; });
    await page.route('**/api/stats*', async (route) => { await gate; await route.continue(); });
  }
  await page.goto(`${base}/`);
  await page.locator('#app:not([inert])').waitFor();
  await page.locator('#statsBtn').click();
  return { ctx, page, errors, release };
}
const pick = async (page, project, range) => {
  await page.selectOption('#sxProject', project);
  await page.locator(`#sxRange [data-range="${range}"]`).click();
};
async function download(page) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#sxExport')]);
  return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), 'utf8') };
}

test('Export runs CSV downloads the filtered runs with exact totals and correct quoting', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await openStats();
  await page.locator('#sxBody .sx-grid').waitFor();
  const { s } = ids;
  const iso = (sec) => new Date(sec * 1000).toISOString();

  // All projects, all time: every run, oldest first; the quoted project name survives the round trip.
  await pick(page, 'all', 'all');
  assert.equal(await page.isEnabled('#sxExport'), true);
  assert.equal(await page.isHidden('#sxExportNote'), true);
  let { name, text } = await download(page);
  assert.match(name, /^agent-orch-runs-all-projects-all-\d{4}-\d\d-\d\d\.csv$/);
  assert.ok(text.includes('\r\n"Acme, ""beta""",'), `quoted project field:\n${text}`);
  let rows = parseCsv(text);
  assert.deepEqual(rows[0], HEAD);
  assert.equal(rows.length, 4, text);
  assert.deepEqual(rows[1], [QUOTED, String(ids.tA1), 'claude', 'opus', iso(s - 3 * 86400), iso(s - 3 * 86400 + 3600), 'ok', '3600', '1234', '5678', '901234']);
  // The Codex run has no recorded model: left empty, not guessed.
  assert.deepEqual(rows[2], [QUOTED, String(ids.tA2), 'codex', '', iso(s - 25 * 3600), iso(s - 23 * 3600), 'rate_limited', '7200', '40', '50', '60']);
  // The running run has no end or outcome yet; its seconds run up to the snapshot.
  assert.deepEqual(rows[3].slice(0, 7), ['plain', String(ids.tB1), 'claude', 'sonnet', iso(s - 2 * 3600), '', '']);
  assert.ok(Math.abs(Number(rows[3][7]) - 7200) <= 30, rows[3][7]);
  // The object URL is released after the download.
  await page.waitForFunction(() => window.__urls.made.length === 1 && window.__urls.freed.includes(window.__urls.made[0]), null, { timeout: 5000 });

  // Project A, last 24h: only the straddling run, with just its in-range seconds but its whole-run tokens.
  await pick(page, String(ids.pA), '24h');
  ({ name, text } = await download(page));
  assert.match(name, /^agent-orch-runs-acme-beta-24h-\d{4}-\d\d-\d\d\.csv$/);
  rows = parseCsv(text);
  assert.equal(rows.length, 2, text);
  assert.equal(rows[1][1], String(ids.tA2));
  assert.ok(Math.abs(Number(rows[1][7]) - 3600) <= 30, `seconds in range: ${rows[1][7]}`);
  assert.deepEqual(rows[1].slice(8), ['40', '50', '60']);

  // Project B, last 7 days: just its running run.
  await pick(page, String(ids.pB), '7d');
  rows = parseCsv((await download(page)).text);
  assert.deepEqual(rows.map((r) => r[1]), ['Task ID', String(ids.tB1)]);

  // Empty selection: a project with no runs disables the button and says why.
  await pick(page, String(ids.pC), 'all');
  assert.equal(await page.isDisabled('#sxExport'), true);
  assert.equal(await page.textContent('#sxExportNote'), 'No agent runs match this project and range');
  assert.equal(await page.isVisible('#sxExportNote'), true);
  // Project A, 24h → 30d still matches; back to a match re-enables it.
  await pick(page, String(ids.pA), '30d');
  assert.equal(await page.isEnabled('#sxExport'), true);
  assert.equal(await page.isHidden('#sxExportNote'), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Export runs CSV is disabled while stats load', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, release } = await openStats({ delayStats: true });
  await page.locator('#statsModal:not([hidden])').waitFor();
  assert.equal(await page.isDisabled('#sxExport'), true);
  assert.equal(await page.getAttribute('#sxExport', 'title'), 'Loading stats…');
  assert.equal(await page.isHidden('#sxExportNote'), true);
  release();
  await page.locator('#sxBody .sx-grid').waitFor();
  await page.waitForFunction(() => !document.getElementById('sxExport').disabled);
  // A refresh disables it again until the new snapshot lands.
  await page.unroute('**/api/stats*');
  let open;
  const gate = new Promise((r) => { open = r; });
  await page.route('**/api/stats*', async (route) => { await gate; await route.continue(); });
  await page.click('#sxRefresh');
  assert.equal(await page.isDisabled('#sxExport'), true);
  open();
  await page.waitForFunction(() => !document.getElementById('sxExport').disabled);
  assert.deepEqual(errors, []);
  await ctx.close();
});
