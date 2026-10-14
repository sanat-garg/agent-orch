// Runs a schedule's shell command the way cron does (owner, 2026-10-14: schedules are cron jobs, not agent tasks): no
// agent, no plan usage. The command runs in the project folder under `bash -lc` (the login profile, so nvm/pyenv paths
// work) with a clean env: HOME/USER/PATH/LANG, TZ = the schedule's zone, the project's own .env, and never the server's
// PORT. Output goes to <dir>/<run id>.log and a wrapper writes the exit code to <dir>/<run id>.exit, so a job outlives
// an agent-orch restart: where a user systemd manager is reachable (lingering; this VPS) it runs in its own
// `systemd-run --user --scope`, outside agent-orch.service's cgroup that systemd kills on every restart. The process gets
// its own process group (detached), so a timeout kills the whole tree.
//
//   startJob({command, cwd, env, dir, id, scope?, spawnFn?}) → {pid, child}   (throws if it can't start)
//   jobState({pid, dir, id})  → {done: true, code} | {done: false, alive}
//   readOutput(dir, id, max)  → the log's last `max` bytes (a cut is marked)
//   killJob(pid, signal)      → kills the job's process group; false if it was gone
//   removeJobFiles(dir, id)
//   jobEnv({cwd, tz, base?})  → the clean env described above

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseEnvText } from './credentials.mjs';

const KEEP_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR'];
const WRAP = 'bash -lc "$1"; echo $? > "$2.tmp" && mv "$2.tmp" "$2"';

const files = (dir, id) => ({ log: path.join(dir, `${id}.log`), exit: path.join(dir, `${id}.exit`) });

export function jobEnv({ cwd, tz, base = process.env }) {
  const env = {};
  for (const k of KEEP_ENV) if (base[k]) env[k] = base[k];
  try { for (const { key: k, value: v } of parseEnvText(fs.readFileSync(path.join(cwd, '.env'), 'utf8'))) env[k] = v; } catch {}
  if (tz) env.TZ = tz;
  delete env.PORT;
  return env;
}

// A user systemd manager this process can reach (cached): its bus socket under XDG_RUNTIME_DIR.
let userBus;
function scopeEnv() {
  if (userBus !== undefined) return userBus;
  const run = process.env.XDG_RUNTIME_DIR || (process.getuid ? `/run/user/${process.getuid()}` : '');
  userBus = run && fs.existsSync(path.join(run, 'bus')) && fs.existsSync('/usr/bin/systemd-run') ? run : null;
  return userBus;
}

export function startJob({ command, cwd, env, dir, id, scope = true, spawnFn = spawn }) {
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`the project folder ${cwd} is missing`);
  fs.mkdirSync(dir, { recursive: true });
  const f = files(dir, id);
  const fd = fs.openSync(f.log, 'a');
  const bus = scope && scopeEnv();
  const argv = ['bash', '-c', WRAP, 'schedule', command, f.exit];
  const [bin, ...args] = bus ? ['systemd-run', '--user', '--scope', '--quiet', '--collect', ...argv] : argv;
  try {
    const child = spawnFn(bin, args, { cwd, env: bus ? { ...env, XDG_RUNTIME_DIR: bus } : env, detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    return { pid: child.pid, child };
  } finally { fs.closeSync(fd); }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function jobState({ pid, dir, id }) {
  try {
    const code = parseInt(fs.readFileSync(files(dir, id).exit, 'utf8'), 10);
    return { done: true, code: Number.isFinite(code) ? code : null };
  } catch {}
  return { done: false, alive: !!pid && alive(pid) };
}

export function readOutput(dir, id, max = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(files(dir, id).log, 'r');
    const size = fs.fstatSync(fd).size, n = Math.min(size, max), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    const s = buf.toString('utf8');
    return size > max ? `[… the first ${Math.round((size - max) / 1024)} KB are cut]\n${s.slice(s.indexOf('\n') + 1)}` : s;
  } catch { return ''; } finally { if (fd != null) fs.closeSync(fd); }
}

export function killJob(pid, signal = 'SIGTERM') {
  if (!pid) return false;
  try { process.kill(-pid, signal); return true; } catch {}
  try { process.kill(pid, signal); return true; } catch { return false; }
}

export function removeJobFiles(dir, id) {
  for (const f of Object.values(files(dir, id))) fs.rmSync(f, { force: true });
}
