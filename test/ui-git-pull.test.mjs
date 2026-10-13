// Opening a project after an hour (owner, 2026-10-13): the server checks GitHub first and pulls what it lacks before
// anything works there (server.mjs freshen, github.mjs pull). The chat shows "Pulling N new commits" while it runs, a
// message sent meanwhile goes only after the pull, a notice says it's on the latest version, and opening it again within
// the hour doesn't fetch again. origin is a local bare repo; a git shim on PATH slows `fetch` (counting them) and `merge`.
// Boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir and HOME, so no Claude sign-in) on a spare port.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrowser } from '../browser.mjs';
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'git-pull-password';
const CID = 'chat-proj', OTHER = 'chat-elsewhere';
let browser, skip = false;
try {
  const env = { ...process.env, ...macChromiumEnv() };
  browser = await chromium.launch({ env }).catch(() => chromium.launch({ env, executablePath: findBrowser({ env }) }));
} catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie, proj, other, fetchLog;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const commit = (cwd, file, text) => { fs.writeFileSync(path.join(cwd, file), text); git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', file); };

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-gitpull-'));
  const bare = path.join(dataDir, 'origin.git'), home = path.join(dataDir, 'home'), bin = path.join(dataDir, 'bin');
  proj = path.join(dataDir, 'proj'); other = path.join(dataDir, 'other'); fetchLog = path.join(dataDir, 'fetches');
  fs.mkdirSync(home); fs.mkdirSync(bin);
  git(dataDir, 'init', '-q', '--bare', '-b', 'main', bare);
  git(dataDir, 'init', '-q', '-b', 'main', proj);
  commit(proj, 'README.md', 'v1\n');
  git(proj, 'remote', 'add', 'origin', bare);
  git(proj, 'push', '-q', '-u', 'origin', 'main');
  // Another machine pushes two commits the server doesn't have.
  git(dataDir, 'clone', '-q', bare, other);
  commit(other, 'README.md', 'v2\n'); commit(other, 'feature.txt', 'new\n');
  git(other, 'push', '-q', 'origin', 'main');
  const realGit = execFileSync('which', ['git']).toString().trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nif [ "$1" = fetch ]; then echo x >> '${fetchLog}'; sleep 2; fi\ncase " $* " in *" merge "*) sleep 2;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });

  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const chat = (id, title, cwd, at) => ({ id, title, cwd, mode: 'default', agent: 'claude', model: 'opus', createdAt: at, updatedAt: at, fullAccess: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([chat(CID, 'Project chat', proj, 1), chat(OTHER, 'Elsewhere', home, 2)]));
  const port = await freePort();
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home,
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
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const fetches = () => (fs.existsSync(fetchLog) ? fs.readFileSync(fetchLog, 'utf8').split('\n').filter(Boolean).length : 0);

test('opening a stale project pulls from GitHub first, shows it, and holds a message until it is on the latest version', { skip }, async () => {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${base}/#${CID}`, { waitUntil: 'domcontentloaded' });
    await page.locator('#gitPull', { hasText: 'Checking GitHub for a newer version' }).waitFor();
    // A message typed straight away waits for the pull.
    await page.locator('#input').fill('what changed?');
    await page.locator('#input').press('Enter');
    await page.locator('#gitPull', { hasText: 'Pulling 2 new commits from GitHub' }).waitFor();
    await page.locator('#messages .notice', { hasText: 'Pulled 2 new commits from GitHub' }).waitFor({ timeout: 15000 });
    await page.locator('#gitPull').waitFor({ state: 'hidden' });
    assert.equal(git(proj, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'));
    assert.equal(fs.readFileSync(path.join(proj, 'feature.txt'), 'utf8'), 'new\n');
    // The log has the pull before the message: the turn ran on the latest version.
    await page.locator('#messages .notice.error', { hasText: 'Not sent' }).waitFor();
    const log = fs.readFileSync(path.join(dataDir, 'logs', `${CID}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const pulled = log.findIndex((e) => e.t === 'notice' && /Pulled 2/.test(e.text)), asked = log.findIndex((e) => e.t === 'user');
    assert.ok(pulled >= 0 && asked > pulled, `pull ${pulled} before message ${asked}`);
    assert.equal(fetches(), 1);
    // Back to it within the hour: no second fetch, no progress line.
    await page.locator('.convo-item', { hasText: 'Elsewhere' }).first().click().catch(() => page.evaluate((id) => { location.hash = id; }, OTHER));
    await page.goto(`${base}/#${CID}`);
    await page.locator('#messages .notice', { hasText: 'Pulled 2 new commits' }).waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#gitPull').isHidden(), true);
    assert.equal(fetches(), 1);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
