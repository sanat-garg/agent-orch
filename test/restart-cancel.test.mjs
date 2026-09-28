// The updates banner's Cancel (#478): POST /api/restart/cancel calls off a pending restart (the rolling timer or the
// idle drain, whose claiming resumes at once), logs it, and the banner offers 'Update ready: vX.YY' + Restart now until
// the owner restarts or a newer commit re-arms it. The servers run from a throwaway clone of this checkout (so a test
// commit can move their HEAD) on spare ports and data dirs; never the live one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRollingRestart } from '../rolling.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'restart-cancel-password';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const v = await f(); if (v) return v; } return f(); };

test('cancel stops a scheduled rolling restart; that HEAD is not re-armed, a newer one is', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cancel-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const st = { head: 'h2', exited: null, calls: [] };
  const r = createRollingRestart({
    stateFile: path.join(dir, 'restart.json'), bootCommit: () => 'h1', head: async () => st.head,
    changed: async (h) => (h === 'h1' ? [] : ['server.mjs']), version: async () => '1.42',
    preflight: async () => { st.calls.push('preflight'); await sleep(30); return ''; },
    prepare: async () => { st.calls.push('prepare'); return { ok: true, paused: [] }; }, resume: async () => {},
    chatIdle: () => true, exit: (c) => { st.exited = c; },
    cfg: { delayMs: 40, pollMs: 5 },
  });
  assert.equal((await r.check()).phase, 'scheduled');
  assert.equal(r.defer('h2'), true);
  assert.equal(r.status(), null);
  assert.equal(await r.check(), null, 'the cancelled HEAD stays deferred');
  await sleep(100);
  assert.equal(st.exited, null);
  assert.deepEqual(st.calls, []);

  // A newer commit re-arms it; a cancel during the preflight still stops it before anything is paused.
  st.head = 'h3';
  assert.equal((await r.check()).phase, 'scheduled');
  await until(() => r.status()?.phase === 'preflight', 2000);
  assert.equal(r.defer('h3'), true);
  await sleep(150);
  assert.equal(st.exited, null);
  assert.deepEqual(st.calls, ['preflight']);
  assert.equal(r.status(), null);
});

test('the banner shows Cancel while a restart is pending and "Update ready" once deferred', () => {
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const phases = /\nconst UPDATE_PHASE = .*\n/.exec(src)?.[0];
  const fn = /\nfunction updateBannerView\([\s\S]*?\n}\n/.exec(src)?.[0];
  assert.ok(phases && fn, 'updateBannerView is in app.js');
  const view = new Function(`const withUntil = (e) => e.text.replace('{until}', 'soon');${phases}${fn}return updateBannerView;`)();
  const base = { commits: 3, dismissed: 0, pending: false, update: null, deferred: null, reload: false };

  const idle = view({ ...base, pending: true }, true, 'idle');
  assert.equal(idle.text, 'Restarting once idle (automatic)…');
  assert.deepEqual([idle.hidden, idle.cancel, idle.restart], [false, true, false]);
  const rolling = view({ ...base, update: { at: 1, phase: 'scheduled' } }, false, 'auto');
  assert.equal(rolling.text, 'Updating the server at soon');
  assert.deepEqual([rolling.cancel, rolling.restart], [true, true]);
  assert.equal(view({ ...base, update: { at: 1, phase: 'pausing' } }, false, 'auto').cancel, false, 'too late once pausing');

  const deferred = view({ ...base, deferred: { version: '3.61' } }, false, 'auto');
  assert.equal(deferred.text, 'Update ready: v3.61');
  assert.deepEqual([deferred.hidden, deferred.restart, deferred.cancel], [false, true, false]);
  assert.equal(view({ ...base, commits: 0 }, false, 'auto').hidden, true);
  assert.match(fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), /id="updateBanner"[\s\S]*id="updateCancel"[^>]*>Cancel</);
});

// ---------- the server ----------
const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cancel-repo-'));
after(() => fs.rmSync(clone, { recursive: true, force: true }));
const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: clone, encoding: 'utf8' }).trim();
let cloned = false;
function setupClone() {
  if (cloned) return;
  cloned = true;
  execFileSync('git', ['clone', '-q', ROOT, clone]);
  const diff = execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: ROOT, maxBuffer: 64 << 20 });
  if (diff.length) execFileSync('git', ['apply', '--whitespace=nowarn'], { cwd: clone, input: diff });
  git('commit', '-q', '--allow-empty', '-am', 'working tree');
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(clone, 'node_modules'));
}
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
async function boot() {
  setupClone();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cancel-data-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await freePort();
  assert.notEqual(port, 3000);
  const proc = spawn(process.execPath, ['server.mjs'], { cwd: clone, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), CW_DATA_DIR: dir,
    AGENT_ORCH_BOOT_COMMIT: git('rev-parse', 'HEAD~1'), AGENT_ORCH_RESTART_POLL_MS: '200', AGENT_ORCH_ROLLING_DELAY_MS: '120000' } });
  const s = { proc, base: `http://127.0.0.1:${port}`, out: '' };
  s.exited = new Promise((resolve) => proc.on('exit', resolve));
  after(() => proc.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${s.out}`)), 20000);
    const onData = (d) => { s.out += d; if (s.out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    s.exited.then((code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${s.out}`)); });
  });
  const r = await fetch(s.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  await r.arrayBuffer();
  const cookie = r.headers.get('set-cookie').split(';')[0];
  s.api = async (p, method = 'GET', body) => {
    const res = await fetch(s.base + p, { method, headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return s;
}
const status = async (s) => (await s.api('/api/status')).body;

test('cancelling the idle drain resumes claiming at once and defers the update', { timeout: 90000 }, async () => {
  const s = await boot();
  assert.equal((await s.api('/api/orch/parallel', 'PUT', { applyUpdates: 'idle' })).status, 200);
  assert.ok(await until(async () => (await status(s)).restartPending), `no drain started:\n${s.out}`);
  assert.equal((await s.api('/api/orch/parallel', 'PUT', { applyUpdates: 'idle' })).body.state.draining, true);

  const unauth = await fetch(s.base + '/api/restart/cancel', { method: 'POST' });
  assert.equal(unauth.status, 401);
  await unauth.arrayBuffer();
  const r = await s.api('/api/restart/cancel', 'POST');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.restartPending, false);
  assert.match(r.body.deferred?.version, /^\d+\.\d+$/);
  assert.equal((await s.api('/api/orch/parallel', 'PUT', { applyUpdates: 'idle' })).body.state.draining, false, 'claiming resumes');
  await sleep(1500); // several polls: the drain is not re-armed and the server stays up
  const st = await status(s);
  assert.equal(st.restartPending, false);
  assert.deepEqual(st.deferred, r.body.deferred);
  assert.equal(s.proc.exitCode, null, s.out);
  assert.doesNotMatch(s.out, /exiting for restart/);
  assert.match(s.out, /\[orchestrator\] Restart cancelled by the owner: update v[\d.]+ waits/, 'logged as an event');
  assert.equal((await s.api('/api/restart/cancel', 'POST')).status, 409, 'nothing left to cancel');
});

test('cancelling a rolling restart defers it; a new commit re-arms it', { timeout: 90000 }, async () => {
  const s = await boot();
  assert.equal((await status(s)).applyUpdates, 'auto');
  assert.ok(await until(async () => (await status(s)).update?.phase === 'scheduled'), `no rolling restart scheduled:\n${s.out}`);
  const r = await s.api('/api/restart/cancel', 'POST');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.update, null);
  assert.ok(r.body.deferred?.version);
  await sleep(1000);
  assert.equal((await status(s)).update, null, 'the same HEAD is not re-armed');
  assert.ok((await status(s)).deferred);

  git('commit', '-q', '--allow-empty', '-m', 'newer');
  const st = await until(async () => { const x = await status(s); return x.update?.phase === 'scheduled' && x; });
  assert.ok(st, `a new commit did not re-arm the restart:\n${s.out}`);
  assert.equal(st.deferred, null);
});
