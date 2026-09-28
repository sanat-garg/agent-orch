// "While you were away" and the other modals on iPhone-sized screens: boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data
// dir) with a long away-summary seeded straight into the DB (many tasks, very long titles, summaries and paths), then at
// 375×667 and 390×844 checks every modal panel stays inside the viewport with no horizontal scroll, and that the away
// list is the only scrolling area. Skips when Playwright's Chromium can't launch. CW_AWAY_KEEP=1 leaves the server up
// (and prints its URL + cookie) for bin/shot.mjs.
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
const PASSWORD = 'away-ui-password';
const VIEWPORTS = [{ width: 375, height: 667 }, { width: 390, height: 844 }];
const MODALS = ['awayModal', 'connsModal', 'usageModal', 'serverModal', 'queueModal', 'fbModal', 'delegModal', 'lightbox', 'pickerModal', 'machineModal', 'extModal', 'statsModal', 'browserModal', 'bvModal'];
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-awayui-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const long = 'an-extremely-long-project-directory-name-without-any-spaces-at-all-to-break-on';
  const paths = [path.join(dataDir, 'p', 'short'), path.join(dataDir, 'p', long)];
  for (const p of paths) fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify(paths.map((cwd, i) => ({ id: `c${i}`, title: `Chat ${i}`, cwd, mode: 'chat',
    agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true,
    repo: { url: `https://github.com/someone/${path.basename(cwd)}-with-a-long-repository-name` } }))));
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
  // The server has migrated the DB; seed finished work behind its back (WAL allows a second writer).
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  const now = Date.now() / 1000;
  const addP = db.prepare('INSERT INTO projects (path, name, created_at) VALUES (?, ?, ?)');
  const addT = db.prepare(`INSERT INTO tasks (project_id, kind, title, prompt, status, result, created_at, finished_at) VALUES (?, 'work', ?, 'x', ?, ?, ?, ?)`);
  paths.forEach((p, i) => {
    const pid = Number(addP.run(p, path.basename(p), now - 9000).lastInsertRowid);
    for (let k = 0; k < 14; k++) {
      const title = k % 3 ? `Fix the thing number ${k} so that it no longer overflows the screen on a very narrow iPhone in portrait orientation`
        : `Refactor public/components/really/deeply/nested/directory/structure/${long}/file-${k}.mjs`;
      const failed = k % 4 === 3;
      addT.run(pid, title, failed ? 'failed' : 'done',
        failed ? `Error: ENOENT /home/ubuntu/${long}/${long}/missing-file-${k}.json could not be opened for reading`
          : `AGENT-ORCH-STATUS: done — updated /srv/${long}/src/${long}.mjs and its tests`, now - 9000, now - 600 - i * 900 - k * 60);
    }
  });
  db.close();
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
  if (process.env.CW_AWAY_KEEP) console.log(`KEEP ${base} ${cookie} cw.lastSeen=${Date.now() - 3 * 3600e3}`);
});

after(async () => {
  await browser?.close();
  if (process.env.CW_AWAY_KEEP) return;
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(viewport) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript((t) => localStorage.setItem('cw.lastSeen', String(t)), Date.now() - 3 * 3600e3);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/`);
  await page.locator('#awayModal:not([hidden]) .aw-list li').first().waitFor();
  await page.waitForTimeout(400); // let the rise/sheet-up animation finish before measuring
  return { ctx, page, errors };
}

// Where a modal's panel sits, and anything inside it that sticks out sideways.
const measure = (page, id) => page.evaluate((id) => {
  const panel = document.querySelector(`#${id} .modal-panel`), r = panel.getBoundingClientRect();
  const wide = [...panel.querySelectorAll('*')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && (b.left < r.left - 0.5 || b.right > r.right + 0.5); })
    .map((e) => `${e.tagName.toLowerCase()}.${e.className}`).slice(0, 5);
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight,
    scrollW: document.documentElement.scrollWidth, panelScrollW: panel.scrollWidth, panelW: panel.clientWidth, wide };
}, id);
const inside = (m, what) => {
  assert.ok(m.left >= 0 && m.top >= 0 && m.right <= m.vw + 0.5 && m.bottom <= m.vh + 0.5, `${what} panel outside the viewport: ${JSON.stringify(m)}`);
  assert.ok(m.scrollW <= m.vw, `${what}: page scrolls sideways (${m.scrollW} > ${m.vw})`);
  assert.ok(m.panelScrollW <= m.panelW, `${what}: panel scrolls sideways (${m.panelScrollW} > ${m.panelW})`);
  assert.deepEqual(m.wide, [], `${what}: content sticks out of the panel`);
};

for (const vp of VIEWPORTS) {
  test(`${vp.width}×${vp.height}: the away summary fits the screen and only its list scrolls`, { skip, timeout: 60000 }, async () => {
    const { ctx, page, errors } = await open(vp);
    const m = await measure(page, 'awayModal');
    inside(m, 'away');
    assert.ok(m.bottom >= m.vh - 0.5, 'phones get a bottom sheet');
    const s = await page.evaluate(() => {
      const body = document.querySelector('#awayBody'), head = document.querySelector('#awayModal .m-head').getBoundingClientRect();
      const top = head.top;
      body.scrollTop = body.scrollHeight;
      return { scrolls: body.scrollHeight > body.clientHeight, moved: body.scrollTop > 0, headStays: document.querySelector('#awayModal .m-head').getBoundingClientRect().top === top,
        oy: getComputedStyle(body).overflowY, ob: getComputedStyle(body).overscrollBehaviorY,
        // Long titles wrap onto two lines (clamped) instead of running off the edge.
        wraps: Math.max(...[...body.querySelectorAll('.aw-list .tt')].map((t) => Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight)))) };
    });
    assert.deepEqual(s, { scrolls: true, moved: true, headStays: true, oy: 'auto', ob: 'contain', wraps: 2 });
    await ctx.close();
    assert.deepEqual(errors, []);
  });

  test(`${vp.width}×${vp.height}: no other modal overflows the screen`, { skip, timeout: 60000 }, async () => {
    const { ctx, page, errors } = await open(vp);
    for (const id of MODALS.filter((x) => x !== 'awayModal')) {
      await page.evaluate((id) => { for (const m of document.querySelectorAll('.modal')) m.hidden = m.id !== id; }, id);
      await page.evaluate(async (id) => {
        await Promise.all(document.querySelector(`#${id} .modal-panel`).getAnimations().map((a) => a.finished.catch(() => {})));
      }, id);
      inside(await measure(page, id), id);
    }
    await ctx.close();
    assert.deepEqual(errors, []);
  });
}
