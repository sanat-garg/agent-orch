// Rolling restarts (#426). In rapid mode the head is never idle, so "restart once idle" (#280/#293) never fires and merged
// fixes don't go live. With Apply updates = 'auto', new server code merged since boot (serverFile) schedules a restart
// within ROLLING.delayMs, at most one per ROLLING.windowMs (later commits coalesce into it; the window survives the
// restart through the state file). A run:
//   0. a merge into main in flight (merging(): the git critical section, seconds; never an agent session) is waited
//      for, polling every pollMs; one still going after mergeWaitMs is logged and the run goes on (prepare() still lets
//      it finish);
//   1. preflight(): `node --check` every server module, then boot server.mjs in a temp CW_DATA_DIR with
//      CW_NO_ORCHESTRATOR=1; a failure refuses the restart and alerts (that HEAD is skipped until a newer one lands);
//   2. prepare(): the orchestrator pauses the head's own runs (session and worktree kept), lets in-flight merges finish
//      and leaves worker jobs running (they are re-adopted after boot, #220);
//   3. a chat or planner turn in flight gets up to chatWaitMs;
//   4. the state file records {at, from, to, version} and exit(0) lets systemd start the new code, which resumes the
//      paused tasks and toasts 'Updated to vX.YY'.
// public/ changes need no restart (files are served from disk): clients just get a reload notice.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';

export const ROLLING = { delayMs: 30e3, windowMs: 10 * 60e3, busyRetryMs: 30e3, failRetryMs: 2 * 60e3, chatWaitMs: 60e3, mergeWaitMs: 60e3, pollMs: 500 };
export const APPLY_UPDATES = ['auto', 'idle', 'manual'];
// Files whose change needs a restart: any *.mjs outside test/ and public/, and the dependency manifests.
export const serverFile = (f) => (/\.mjs$/.test(f) && !/^(test|public)\//.test(f)) || f === 'package.json' || f === 'package-lock.json';

export function readRestartState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}
export function writeRestartState(file, st) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(st));
  fs.renameSync(file + '.tmp', file);
}

// Proves the code in `root` boots: `node --check` every root and bin/ *.mjs, then start server.mjs once on a spare port
// with no orchestrator (never on the live DB) and a throwaway data dir, and wait up to bootMs for /auth/check.
// Resolves '' when it booted, else why not.
export async function preflight({ root, bootMs = 20e3 } = {}) {
  const mjs = (dir) => { try { return fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.mjs')).map((f) => path.join(dir, f)); } catch { return []; } };
  for (const f of [...mjs('.'), ...mjs('bin')]) {
    const err = await new Promise((resolve) => execFile(process.execPath, ['--check', f], { cwd: root, timeout: 30e3 },
      (e, _out, stderr) => resolve(e ? `${f}: ${String(stderr || e.message).trim().split('\n').slice(0, 5).join(' | ')}` : '')));
    if (err) return err;
  }
  const port = await new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orch-preflight-'));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), CW_DATA_DIR: dir, CW_NO_ORCHESTRATOR: '1' } });
  let out = '', exited = null;
  const tail = () => { const lines = out.trim().split('\n'); return lines.find((l) => /Error\b/.test(l))?.trim() || lines.slice(-3).join(' | '); };
  child.stdout.on('data', (d) => { out = (out + d).slice(-4000); });
  child.stderr.on('data', (d) => { out = (out + d).slice(-4000); });
  child.on('exit', (code, sig) => { exited = code ?? sig; });
  try {
    for (const end = Date.now() + bootMs; Date.now() < end && exited == null; await new Promise((r) => setTimeout(r, 500))) {
      try { await (await fetch(`http://127.0.0.1:${port}/auth/check`, { signal: AbortSignal.timeout(2000) })).body?.cancel(); return ''; } catch {}
    }
    return exited != null ? `server.mjs exited (${exited}) during boot: ${tail()}` : `server.mjs did not answer /auth/check within ${Math.round(bootMs / 1000)} s: ${tail()}`;
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// deps: stateFile; head() → the checkout's HEAD sha; changed(head) → server files changed since boot; version(head);
// preflight() → '' | why; busy() → why a restart must wait now ('' = go; retried every busyRetryMs); merging() → the
// merge into main in flight ('' = none; waited for, at most mergeWaitMs); prepare() → {ok, paused, why};
// resume(paused) undoes prepare; chatIdle(); exit(code); log(msg); alert(msg); onChange() (status() changed).
export function createRollingRestart(deps) {
  const cfg = { ...ROLLING, ...Object.fromEntries(Object.entries(deps.cfg || {}).filter(([, v]) => v != null)) }, now = deps.now || Date.now;
  const log = deps.log || (() => {}), alert = deps.alert || log, onChange = deps.onChange || (() => {});
  let plan = null, timer = null, skipHead = '', busyNoted = '';
  const lastAt = () => Number(readRestartState(deps.stateFile).at) || 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function schedule(at, reason, phase = 'scheduled') {
    clearTimeout(timer);
    plan = { at, reason, phase };
    timer = setTimeout(() => run().catch((e) => { alert(`Update failed: ${e?.message || e}`); plan = null; onChange(); }), Math.max(0, at - now()));
    timer.unref?.();
    onChange();
    return plan;
  }
  const done = () => { clearTimeout(timer); plan = null; onChange(); };
  // The poll (Apply updates = auto): new server code since boot → a restart within delayMs, but not sooner than windowMs
  // after the last one. Already scheduled: the new commits ride along.
  async function check() {
    if (plan) return plan;
    const head = await deps.head();
    if (!head || head === skipHead) return null;
    const files = await deps.changed(head);
    if (!files.length || plan) return plan;
    const at = Math.max(now() + cfg.delayMs, lastAt() + cfg.windowMs);
    log(`rolling: ${files.length} server file(s) changed since boot (${files.slice(0, 3).join(', ')}); restarting in ${Math.round((at - now()) / 1000)} s`);
    return schedule(at, `${files.length} server file(s) changed`);
  }
  // "Restart now" (the updates banner): skips the delay and the window, not the preflight.
  function restartNow(reason = 'restart now') {
    if (plan && plan.phase !== 'scheduled') return plan;
    return schedule(now(), reason);
  }
  // Only a restart that hasn't started running can be called off (Apply updates changed away from auto).
  function cancel() {
    if (!plan || plan.phase !== 'scheduled') return false;
    done();
    return true;
  }
  // The owner's Cancel (the updates banner): also while waiting for a merge or the preflight, never once pausing. HEAD
  // `skip` is not re-armed by check(); a newer one is, and restartNow still runs it.
  function defer(skip) {
    if (!plan || !['scheduled', 'merging', 'preflight'].includes(plan.phase)) return false;
    skipHead = skip;
    done();
    return true;
  }
  async function run() {
    const mine = plan, gone = () => plan !== mine; // cancelled while waiting for a merge or the preflight
    const why = deps.busy?.() || '';
    if (why) {
      if (busyNoted !== why) log(`rolling: waiting (${why})`);
      busyNoted = why;
      schedule(now() + cfg.busyRetryMs, plan?.reason || 'update');
      return false;
    }
    busyNoted = '';
    const merge = deps.merging?.() || '';
    if (merge) {
      plan.phase = 'merging'; onChange();
      log(`rolling: waiting (${merge})`);
      for (const end = now() + cfg.mergeWaitMs; deps.merging() && now() < end;) await sleep(cfg.pollMs);
      const still = deps.merging();
      if (still) log(`rolling: ${still} for over ${Math.round(cfg.mergeWaitMs / 1000)} s; restarting as soon as it finishes`);
      if (gone()) return false;
    }
    plan.phase = 'preflight'; onChange();
    let head = await deps.head();
    let bad = await deps.preflight();
    if (gone()) return false;
    if (bad) return refuse(head, bad);
    plan.phase = 'pausing'; onChange();
    const r = await deps.prepare();
    if (!r?.ok) {
      await deps.resume(r?.paused || []);
      log(`rolling: not restarting yet (${r?.why || 'busy'}); retrying in ${Math.round(cfg.failRetryMs / 1000)} s`);
      schedule(now() + cfg.failRetryMs, plan.reason);
      return false;
    }
    for (const end = now() + cfg.chatWaitMs; !deps.chatIdle() && now() < end;) await sleep(cfg.pollMs);
    // A merge that finished while pausing moved HEAD: the code about to boot is checked again.
    const latest = await deps.head();
    if (latest !== head) {
      head = latest;
      bad = await deps.preflight();
      if (bad) { await deps.resume(r.paused); return refuse(head, bad); }
    }
    plan.phase = 'exiting'; onChange();
    const version = await deps.version(head);
    writeRestartState(deps.stateFile, { at: now(), from: deps.bootCommit?.() || null, to: head, version, paused: r.paused, reason: plan.reason });
    log(`rolling: exiting for restart to ${head.slice(0, 8)} (v${version}); ${r.paused.length} head task(s) paused`);
    deps.exit(0);
    return true;
  }
  function refuse(head, why) {
    skipHead = head;
    done();
    alert(`Update skipped: the code at ${head?.slice(0, 8) || 'HEAD'} does not boot (${String(why).slice(0, 300)})`);
    return false;
  }
  return { check, restartNow, cancel, defer, status: () => (plan ? { at: Math.round(plan.at / 1000), phase: plan.phase, reason: plan.reason } : null) };
}
