// Short-lived CLI helpers: model discovery, plan-limit and sign-in checks (never agent runs, see agents.mjs spawnJsonl).
// Each helper runs detached in its own process group. A timeout or abort kills the whole group (SIGTERM, then SIGKILL
// KILL_GRACE_MS later) and the promise settles regardless; members left behind when the helper exits get the same.
// Nothing outlives this process: a normal exit SIGKILLs live groups, and a tiny sh watchdog per group kills it within
// a second when this process dies any other way (SIGKILL, crash, an unhandled SIGTERM).
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

export const KILL_GRACE_MS = 3000;
const SYS_PATH = '/usr/local/bin:/usr/bin:/bin';
const sysBin = (name) => ['/usr/bin', '/bin'].map((d) => `${d}/${name}`).find((f) => fs.existsSync(f)) || null;

const alive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const signalGroup = (pgid, sig) => { try { process.kill(-pgid, sig); } catch {} };
// SIGTERM to the group now, SIGKILL after the grace to whatever is left.
export function killGroup(pgid, grace = KILL_GRACE_MS) {
  if (!pgid || !alive(pgid)) return;
  signalGroup(pgid, 'SIGTERM');
  setTimeout(() => { if (alive(pgid)) signalGroup(pgid, 'SIGKILL'); }, grace).unref();
}

const live = new Set();
let exitHook = false;
const WATCHDOG = 'while kill -0 -$2 2>/dev/null; do if ! kill -0 $1 2>/dev/null; then kill -TERM -$2 2>/dev/null; sleep 3; kill -KILL -$2 2>/dev/null; exit 0; fi; sleep 1; done';
// Ties a process group this process started to its lifetime; returns the untrack function.
export function trackGroup(pgid) {
  if (!pgid) return () => {};
  if (!exitHook) { exitHook = true; process.on('exit', () => { for (const g of live) signalGroup(g, 'SIGKILL'); }); }
  live.add(pgid);
  const sh = sysBin('sh');
  if (sh) {
    try {
      spawn(sh, ['-c', WATCHDOG, 'agent-orch-helper-watchdog', String(process.pid), String(pgid)],
        { detached: true, stdio: 'ignore', env: { PATH: SYS_PATH } }).on('error', () => {}).unref();
    } catch {}
  }
  return () => live.delete(pgid);
}

// A tracked helper process (its own group, pgid = pid); its leftovers are killed when it exits. For SDKs that take a
// spawn function (the Claude SDK's spawnClaudeCodeProcess); everything else uses runHelper.
export function spawnHelper(cmd, args = [], { cwd, env, stdio = ['ignore', 'pipe', 'pipe'] } = {}) {
  const child = spawn(cmd, args, { cwd, env, stdio, detached: true });
  if (child.pid) {
    const untrack = trackGroup(child.pid);
    child.once('exit', () => { killGroup(child.pid); untrack(); });
  }
  return child;
}
// The Claude SDK's spawnClaudeCodeProcess for probe queries (supportedModels, usage): same helper discipline.
export function claudeHelperSpawn({ command, args, cwd, env, signal }) {
  const child = spawnHelper(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
  signal?.addEventListener('abort', () => killGroup(child.pid), { once: true });
  return child;
}

// Runs one helper: {code, signal, stdout, stderr (last 64k), timedOut, aborted, stopped, error}. Never rejects.
// stopOn: a stderr regex that ends it early (e.g. a CLI blocking on a sign-in prompt).
export function runHelper(cmd, args = [], { timeoutMs = 30_000, cwd, env, signal, stopOn, maxBuffer = 64 << 20 } = {}) {
  return new Promise((resolve) => {
    const r = { code: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, stopped: false, error: null };
    let child, done = false, timer = null, hard = null;
    const onAbort = () => stop('aborted');
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(hard);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    // Kill the group; settle even if a member we can't reach keeps the pipes open.
    function stop(why) {
      if (done) return;
      r[why] = true;
      if (child?.pid) killGroup(child.pid);
      hard ??= setTimeout(() => { child?.stdout?.destroy(); child?.stderr?.destroy(); finish(); }, KILL_GRACE_MS + 500);
    }
    try { child = spawnHelper(cmd, args, { cwd, env }); } catch (e) { r.error = e; return finish(); }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (r.stdout.length < maxBuffer) r.stdout += d; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      r.stderr = (r.stderr + d).slice(-65536);
      if (stopOn && stopOn.test(r.stderr)) stop('stopped');
    });
    child.on('error', (e) => { r.error = e; finish(); });
    child.on('close', (code, sig) => { r.code = code; r.signal = sig; finish(); });
    if (timeoutMs) timer = setTimeout(() => stop('timedOut'), timeoutMs);
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  });
}
// stdout of a successful helper; rejects with its last stderr line, 'timed out' or the spawn error.
export async function helperOut(cmd, args, opts) {
  const r = await runHelper(cmd, args, opts);
  if (!r.error && !r.timedOut && !r.aborted && r.code === 0) return r.stdout;
  throw new Error(r.timedOut ? 'timed out' : r.aborted ? 'aborted' : String(r.stderr).trim().split('\n').pop() || r.error?.message || `exit ${r.code ?? r.signal}`);
}

// A sync helper (sign-in checks read by sync callers), bounded by coreutils `timeout`, which leads its own process group
// and signals the whole group (SIGTERM, then SIGKILL 3 s later); leftovers are killed after it returns.
// spawnSync-shaped result: {status, stdout, stderr, error}.
export function runHelperSync(cmd, args = [], { timeoutMs = 5000, cwd, env } = {}) {
  const t = sysBin('timeout');
  const argv = t ? [t, ['-k', String(KILL_GRACE_MS / 1000), String(timeoutMs / 1000), cmd, ...args]] : [cmd, args];
  const r = spawnSync(argv[0], argv[1], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs + KILL_GRACE_MS + 2000, maxBuffer: 16 << 20 });
  if (t && r.pid) signalGroup(r.pid, 'SIGKILL');
  return r;
}

// Single-flight: concurrent calls with the same key share one in-flight promise.
const flights = new Map();
export function singleFlight(key, fn) {
  if (!flights.has(key)) flights.set(key, Promise.resolve().then(fn).finally(() => flights.delete(key)));
  return flights.get(key);
}
