// How a worker holds its jobs to its local cap (cap.mjs; .agent-orch/CLUSTER.md "Local cap") and measures what they use.
// Every agent CLI and done-when check a job starts runs through a small wrapper script in <home>/run that records its
// pid (the command's own, as it execs in place) and then execs the command under the cap where the OS allows it:
//   Linux  a transient systemd scope per job (`systemd-run --user --scope -p CPUQuota=… -p MemoryMax=…`, the user's
//          systemd manager: the installer enables lingering), else a background nice level;
//   macOS  a background nice level (no per-process CPU or RAM quota without root; `taskpolicy -b` would confine jobs
//          to the efficiency cores, which the installer avoids on purpose: ProcessType Standard, Nice 5).
// The worker adds the rest: it takes no more jobs than the cap allows and its memory watch pauses the newest job when
// the jobs stay over the RAM cap (worker.mjs). Usage = the process trees under those pids: /proc on Linux, `ps` on
// macOS. AGENT_ORCH_WORKER_LIMITER=off|nice|systemd overrides the choice (tests use nice).
import fs from 'node:fs';
import path from 'node:path';
import { helperOut, runHelper } from './helpers.mjs';

const CLK = 100; // USER_HZ
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const sysBin = (name) => ['/usr/bin', '/bin', '/usr/sbin'].map((d) => `${d}/${name}`).find((f) => fs.existsSync(f)) || null;

// Which way jobs are held to a CPU/RAM cap here: 'systemd' (a scope per job), 'nice' or 'off'. Probed once: a scope
// with both properties must start.
export async function probeLimiter({ platform = process.platform, env = process.env } = {}) {
  const forced = env.AGENT_ORCH_WORKER_LIMITER;
  if (['off', 'nice', 'systemd'].includes(forced)) return forced;
  const run = platform === 'linux' && sysBin('systemd-run'), yes = sysBin('true');
  if (!run || !yes) return 'nice';
  const r = await runHelper(run, ['--user', '--scope', '--quiet', '--collect', '-p', 'CPUQuota=100%', '-p', 'MemoryMax=1G', '--', yes],
    { timeoutMs: 10_000, env: { ...env, XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}` } });
  return r.code === 0 ? 'systemd' : 'nice';
}
// How jobs are held to `cap` with limiter `mode`, in words (the status view, the log), or null without a CPU/RAM cap.
export function heldBy(mode, cap) {
  if (cap?.cpu == null && cap?.mem == null) return null;
  const props = [cap.cpu != null && 'CPUQuota', cap.mem != null && 'MemoryMax'].filter(Boolean).join(', ');
  return [mode === 'systemd' ? `a systemd scope per job (${props})` : cap.cpu != null && mode !== 'off' && 'low priority (nice 10)',
    cap.cpu != null && 'a core per task', cap.mem != null && 'the memory watch'].filter(Boolean).join(', ');
}

// The wrapper for one command of a job: `exec` is its argv before the caller's arguments ("$@"). cap: the resolved cap.
export function wrapperScript({ job, what, exec, pidFile, cap, mode }) {
  const lines = ['#!/bin/sh', `# agent-orch worker: job ${job}'s ${what}, under this machine's local cap (node worker.mjs limit; worker-cap.mjs).`,
    `echo $$ >> ${q(pidFile)}`];
  const cmd = `${exec.map(q).join(' ')} "$@"`;
  const props = [cap?.cpu != null && `CPUQuota=${Math.round(cap.cpu * 100)}%`, cap?.mem != null && `MemoryMax=${cap.mem}`].filter(Boolean);
  const run = mode === 'systemd' && props.length && sysBin('systemd-run'), yes = sysBin('true'), nice = cap?.cpu != null && mode !== 'off' && sysBin('nice');
  if (run && yes) {
    const p = props.flatMap((x) => ['-p', x]).join(' ');
    lines.push('export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
      `if ${q(run)} --user --scope --quiet --collect ${p} -- ${q(yes)} 2>/dev/null; then`,
      `  exec ${q(run)} --user --scope --quiet --collect "--unit=agent-orch-job-${job}-$$" ${p} -- ${cmd}`, 'fi');
  }
  lines.push(nice ? `exec ${q(nice)} -n 10 ${cmd}` : `exec ${cmd}`);
  return `${lines.join('\n')}\n`;
}

// A job's wrappers and pid file under <home>/run: wrap(job, what, exec) writes one (with the cap in effect now) and
// returns its path; pids(job) lists what they started; drop(job) removes them.
// reset() clears a previous run's leftovers (at the daemon's start, once no other daemon holds this home).
export function createWrappers({ dir, cap = () => null, mode = () => 'off' }) {
  const pidFile = (job) => path.join(dir, `job-${job}.pids`);
  function reset() {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  function wrap(job, what, exec) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `job-${job}-${what}.sh`);
    fs.writeFileSync(file, wrapperScript({ job, what, exec, pidFile: pidFile(job), cap: cap(), mode: mode() }), { mode: 0o700 });
    fs.chmodSync(file, 0o700);
    return file;
  }
  function pids(job) {
    try { return [...new Set(fs.readFileSync(pidFile(job), 'utf8').split('\n').map(Number).filter((n) => Number.isInteger(n) && n > 1))]; } catch { return []; }
  }
  function drop(job) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const f of names) if (f.startsWith(`job-${job}-`) || f === `job-${job}.pids`) fs.rmSync(path.join(dir, f), { force: true });
  }
  return { reset, wrap, pids, drop };
}

// ---- usage: the process table, then each job's trees (their roots: the wrapper pids, children of this process)
function linuxTable(procDir) {
  const table = new Map();
  let names = [];
  try { names = fs.readdirSync(procDir); } catch {}
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let s;
    try { s = fs.readFileSync(path.join(procDir, n, 'stat'), 'utf8'); } catch { continue; }
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    table.set(Number(n), { ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]), start: Number(f[19]) });
  }
  return table;
}
// A process's memory: its PSS (shared pages split between their users), else its RSS.
function linuxMem(procDir, pid) {
  const kb = (file, key) => {
    try { const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(fs.readFileSync(path.join(procDir, String(pid), file), 'utf8')); return m ? Number(m[1]) * 1024 : null; } catch { return null; }
  };
  return kb('smaps_rollup', 'Pss') ?? kb('status', 'VmRSS') ?? 0;
}
// `ps -axo pid=,ppid=,rss=,%cpu=` → Map pid → {ppid, rss (bytes), cpu (cores)}.
export function parsePs(text) {
  const table = new Map();
  for (const line of String(text || '').split('\n')) {
    const [pid, ppid, rss, cpu] = line.trim().split(/\s+/);
    if (!/^\d+$/.test(pid || '')) continue;
    table.set(Number(pid), { ppid: Number(ppid), rss: Number(rss) * 1024 || 0, cpu: (parseFloat(String(cpu).replace(',', '.')) || 0) / 100 });
  }
  return table;
}

// sample(roots: Map job id → [pid]) → {at, cpu (cores), mem (bytes), jobs: Map id → {cpu, mem}}. A root counts only while
// it is this process's child (a recycled pid doesn't); its whole tree counts once.
export function createJobUsage({ selfPid = process.pid, platform = process.platform, procDir = '/proc', ps = null } = {}) {
  let prev = new Map(), prevAt = 0;
  const readPs = ps || (() => helperOut('/bin/ps', ['-axo', 'pid=,ppid=,rss=,%cpu='], { timeoutMs: 5000, env: { ...process.env, LC_ALL: 'C' } }));
  async function sample(roots) {
    const at = Date.now(), linux = platform !== 'darwin';
    let table;
    try { table = linux ? linuxTable(procDir) : parsePs(await readPs()); } catch { table = new Map(); }
    const kids = new Map();
    for (const [pid, p] of table) (kids.get(p.ppid) || kids.set(p.ppid, []).get(p.ppid)).push(pid);
    const ticks = new Map(), dt = prevAt ? (at - prevAt) / 1000 : 0, seen = new Set(), jobs = new Map();
    for (const [id, pids] of roots) {
      const use = { cpu: 0, mem: 0 };
      const stack = pids.filter((pid) => table.get(pid)?.ppid === selfPid);
      while (stack.length) {
        const pid = stack.pop();
        if (seen.has(pid)) continue;
        seen.add(pid);
        const p = table.get(pid);
        if (linux) {
          const key = `${pid}:${p.start}`, before = prev.get(key);
          ticks.set(key, p.ticks);
          if (before != null && dt > 0) use.cpu += Math.max(0, (p.ticks - before) / CLK / dt);
          use.mem += linuxMem(procDir, pid);
        } else { use.cpu += p.cpu; use.mem += p.rss; }
        stack.push(...(kids.get(pid) || []));
      }
      jobs.set(id, { cpu: Math.round(use.cpu * 100) / 100, mem: Math.round(use.mem) });
    }
    prev = ticks; prevAt = at;
    const sum = (k) => [...jobs.values()].reduce((a, u) => a + u[k], 0);
    return { at, cpu: Math.round(sum('cpu') * 100) / 100, mem: sum('mem'), jobs };
  }
  return { sample };
}
