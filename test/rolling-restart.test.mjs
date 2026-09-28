// Rolling restart scheduler (rolling.mjs, #426): new server code schedules a restart within 2 min whatever is running;
// a run preflights, pauses, gives a chat turn its time and exits; a failing preflight blocks it (nothing paused, that
// HEAD skipped); restarts coalesce into one per 10 min, also across the restart itself; only a merge into main in flight
// holds it (briefly, at most mergeWaitMs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROLLING, createRollingRestart, preflight, readRestartState, serverFile } from '../rolling.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rolling-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 5000) => { for (const end = Date.now() + ms; !f() && Date.now() < end;) await sleep(10); return f(); };

// A scheduler over fakes. `o` overrides deps; `calls` records what ran, in order.
function harness(o = {}) {
  const dir = tmp(), calls = [];
  const st = { head: 'h2', running: 3, chatBusyFor: 0, exited: null, alerts: [] };
  const r = createRollingRestart({
    stateFile: path.join(dir, 'restart.json'),
    bootCommit: () => 'h1',
    head: async () => st.head,
    changed: async (h) => (h === 'h1' ? [] : ['orchestrator.mjs', 'server.mjs']),
    version: async () => '1.42',
    preflight: async () => { calls.push('preflight'); return ''; },
    busy: () => '', // running work (st.running) never holds a rolling restart
    prepare: async () => { calls.push('prepare'); st.running = 0; return { ok: true, paused: [7, 8] }; },
    resume: async (ids) => { calls.push(`resume ${ids}`); },
    chatIdle: () => { if (st.chatBusyFor > 0) { st.chatBusyFor--; return false; } return true; },
    exit: (code) => { calls.push(`exit ${code}`); st.exited = code; },
    alert: (m) => st.alerts.push(m),
    ...o,
    cfg: { delayMs: 20, pollMs: 5, busyRetryMs: 20, failRetryMs: 20, ...o.cfg },
  });
  return { r, calls, st, dir, file: path.join(dir, 'restart.json') };
}

test('only server code needs a restart; public/ and tests do not', () => {
  for (const f of ['server.mjs', 'orchestrator.mjs', 'bin/test.mjs', 'package.json', 'package-lock.json']) assert.equal(serverFile(f), true, f);
  for (const f of ['public/app.js', 'public/x.mjs', 'test/a.test.mjs', 'README.md', '.agent-orch/CONTEXT.md', 'install-worker.sh']) assert.equal(serverFile(f), false, f);
});

test('a server code change schedules a restart within 2 min even with tasks running, then pauses, waits for chat and exits', async () => {
  // The defaults: the 60 s poll plus the settle delay stays within 2 min.
  const now = 1_000_000_000;
  const d = harness({ now: () => now, cfg: { delayMs: ROLLING.delayMs } });
  assert.equal(d.st.running, 3);
  const plan = await d.r.check();
  assert.equal(plan.phase, 'scheduled');
  assert.ok(plan.at - now <= ROLLING.delayMs && ROLLING.delayMs + 60e3 <= 120e3, `restart in ${plan.at - now} ms`);
  assert.equal(d.r.cancel(), true);
  assert.equal(d.r.status(), null);

  // A run: preflight, pause the head's tasks, give a busy chat turn its time, record the restart, exit 0.
  const h = harness();
  h.st.chatBusyFor = 5;
  await h.r.check();
  assert.equal(h.r.status().phase, 'scheduled');
  assert.ok(await until(() => h.st.exited !== null), `exited: ${h.calls}`);
  assert.deepEqual(h.calls, ['preflight', 'prepare', 'exit 0']);
  assert.equal(h.st.chatBusyFor, 0, 'the chat turn finished first');
  const st = readRestartState(h.file);
  assert.deepEqual({ from: st.from, to: st.to, version: st.version, paused: st.paused }, { from: 'h1', to: 'h2', version: '1.42', paused: [7, 8] });
  assert.ok(st.at > 0);
  assert.equal(h.r.status().phase, 'exiting');

  // A chat turn that never ends holds it for chatWaitMs at most.
  const c = harness({ chatIdle: () => false, cfg: { chatWaitMs: 100 } });
  const t0 = Date.now();
  c.r.restartNow();
  assert.ok(await until(() => c.st.exited !== null));
  assert.ok(Date.now() - t0 >= 100);
  for (const x of [d, h, c]) fs.rmSync(x.dir, { recursive: true, force: true });
});

test('nothing new since boot schedules nothing', async () => {
  const h = harness();
  h.st.head = 'h1';
  assert.equal(await h.r.check(), null);
  assert.equal(h.r.status(), null);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('a failing preflight blocks the restart: nothing is paused, the owner is alerted, and that HEAD is skipped', async () => {
  const h = harness({ preflight: async () => { h.calls.push('preflight'); return h.st.head === 'h2' ? 'broken.mjs: SyntaxError: Unexpected token' : ''; } });
  await h.r.check();
  assert.ok(await until(() => h.r.status() === null));
  assert.deepEqual(h.calls, ['preflight'], 'no pause, no exit');
  assert.equal(h.st.exited, null);
  assert.match(h.st.alerts[0], /Update skipped: the code at h2 does not boot \(broken\.mjs: SyntaxError/);
  assert.equal(await h.r.check(), null, 'the same HEAD is not retried');
  assert.equal(fs.existsSync(h.file), false);
  h.st.head = 'h3'; // a fix lands
  assert.equal((await h.r.check()).phase, 'scheduled');
  assert.ok(await until(() => h.st.exited === 0));
  assert.deepEqual(h.calls, ['preflight', 'preflight', 'prepare', 'exit 0']);

  // HEAD moved while pausing (a merge finished) and the newer code fails: the paused tasks resume, no exit.
  let n = 0;
  const m = harness({ preflight: async () => (++n === 1 ? '' : 'server.mjs exited (1) during boot'),
    prepare: async () => { m.st.head = 'h9'; return { ok: true, paused: [4] }; } });
  m.r.restartNow();
  assert.ok(await until(() => m.st.alerts.length > 0));
  assert.deepEqual(m.calls, ['resume 4']);
  assert.equal(m.st.exited, null);
  assert.match(m.st.alerts[0], /code at h9 does not boot/);
  for (const x of [h, m]) fs.rmSync(x.dir, { recursive: true, force: true });
});

test('the real preflight refuses code that fails node --check or does not boot, and passes code that answers', async () => {
  const bad = tmp(), crash = tmp(), good = tmp();
  fs.writeFileSync(path.join(bad, 'broken.mjs'), 'export const x = ;\n');
  fs.writeFileSync(path.join(bad, 'server.mjs'), '');
  assert.match(await preflight({ root: bad }), /^broken\.mjs: /);
  fs.writeFileSync(path.join(crash, 'server.mjs'), "throw new Error('boom at boot');\n");
  assert.match(await preflight({ root: crash }), /server\.mjs exited \(1\) during boot: .*boom at boot/);
  // It boots with no orchestrator, on its own data dir and port.
  fs.writeFileSync(path.join(good, 'server.mjs'), `import http from 'node:http';
    if (process.env.CW_NO_ORCHESTRATOR !== '1' || !process.env.CW_DATA_DIR || process.env.PORT === '3000') process.exit(2);
    http.createServer((q, s) => s.end(q.url === '/auth/check' ? 'ok' : '')).listen(Number(process.env.PORT), '127.0.0.1');\n`);
  assert.equal(await preflight({ root: good }), '');
  for (const d of [bad, crash, good]) fs.rmSync(d, { recursive: true, force: true });
});

test('restarts coalesce: at most one per 10 min, also across the restart itself', async () => {
  let now = 5_000_000_000;
  const h = harness({ now: () => now, cfg: { delayMs: ROLLING.delayMs, windowMs: ROLLING.windowMs } });
  fs.writeFileSync(h.file, JSON.stringify({ at: now - 3 * 60e3, to: 'h1' })); // the last restart was 3 min ago
  const first = await h.r.check();
  assert.equal(first.at, now - 3 * 60e3 + ROLLING.windowMs);
  now += 60e3; h.st.head = 'h3'; // more commits land: they ride along
  const again = await h.r.check();
  assert.equal(again.at, first.at);
  assert.equal(h.r.cancel(), true);

  // The process that restarts records when; the next one waits out the window from then.
  const a = harness();
  a.r.restartNow();
  assert.ok(await until(() => a.st.exited === 0));
  const at = readRestartState(a.file).at;
  const b = harness({ now: () => at + 60e3, stateFile: a.file, cfg: { delayMs: ROLLING.delayMs, windowMs: ROLLING.windowMs } });
  assert.equal((await b.r.check()).at, at + ROLLING.windowMs);
  // "Restart now" skips the window (still preflighted).
  assert.equal(b.r.restartNow().at, at + 60e3);
  b.r.cancel();
  for (const x of [h, a, b]) fs.rmSync(x.dir, { recursive: true, force: true });
});

test('only a merge into main in flight holds the restart, polled briefly; a failed pause resumes the tasks and retries', async () => {
  // A restart-when-idle drain (busy) reschedules; a merge (merging) is waited for in place and the run goes on at once.
  let merging = 'integrator #12 is merging';
  const logs = [];
  const h = harness({ merging: () => merging, log: (m) => logs.push(m), cfg: { busyRetryMs: 60e3 } });
  await h.r.check();
  await sleep(120);
  assert.deepEqual(h.calls, [], 'nothing ran while the merge was in flight');
  assert.equal(h.r.status().phase, 'merging');
  assert.equal(h.r.restartNow().phase, 'merging', 'restart now does not start a second run');
  assert.equal(h.r.cancel(), false);
  assert.equal(logs.filter((m) => /waiting \(integrator #12 is merging\)/.test(m)).length, 1, 'logged once');
  const t0 = Date.now();
  merging = '';
  assert.ok(await until(() => h.st.exited === 0));
  assert.ok(Date.now() - t0 < 1000, 'proceeds as soon as the merge finishes, not after busyRetryMs');
  assert.deepEqual(h.calls, ['preflight', 'prepare', 'exit 0']);

  // A merge still going after mergeWaitMs (60 s by default) is logged and the restart goes on (prepare lets it finish).
  assert.equal(ROLLING.mergeWaitMs, 60e3);
  const slogs = [];
  const s = harness({ merging: () => '#9 is merging', log: (m) => slogs.push(m), cfg: { mergeWaitMs: 150 } });
  const t1 = Date.now();
  s.r.restartNow();
  assert.ok(await until(() => s.st.exited === 0));
  assert.ok(Date.now() - t1 >= 150);
  assert.ok(slogs.some((m) => /#9 is merging for over 0 s; restarting as soon as it finishes/.test(m)), slogs.join('\n'));
  assert.deepEqual(s.calls, ['preflight', 'prepare', 'exit 0']);

  // A restart-when-idle drain still reschedules.
  let busy = 'a restart-when-idle drain is in progress';
  const b = harness({ busy: () => busy });
  b.r.restartNow();
  await sleep(80);
  assert.deepEqual(b.calls, []);
  busy = '';
  assert.ok(await until(() => b.st.exited === 0));

  let tries = 0;
  const p = harness({ prepare: async () => (++tries === 1 ? { ok: false, paused: [3], why: '#5 still running on this server' } : { ok: true, paused: [3] }) });
  p.r.restartNow();
  assert.ok(await until(() => p.st.exited === 0));
  assert.deepEqual(p.calls, ['preflight', 'resume 3', 'preflight', 'exit 0']);
  for (const x of [h, s, b, p]) fs.rmSync(x.dir, { recursive: true, force: true });
});
