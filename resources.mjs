// Resource analyzer and safe reaper (BRIEF goal 9). Every ~10 s it reads /proc (no deps): system memory, load, CPU% per
// core, and per process pid/ppid/pgid/cmdline/RSS (+PSS from smaps_rollup)/CPU%/age/cwd. Processes are grouped into
// trees and each tree gets a category. The reaper kills ONLY leftovers (REAP below): never the live server, running
// task or chat trees, owner terminals, system services, or anything owned by another user.
//   Ownership: runAgent/chat turns put AGENT_ORCH_OWNER=<server pid>:task|chat:<id> into the agent's env (inherited by
// every descendant, even after re-parenting to init) and CLI adapters register their spawned pid/pgid (registerPid).
// A marked process whose server is this process belongs to its task/chat while that is running, else it is a leftover;
// one marked by another live server (a test instance looking at the real one) just inherits its parent's category.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { helperOut, runHelperSync } from './helpers.mjs';

export const OWNER_ENV = 'AGENT_ORCH_OWNER';
export const ownerTag = (kind, id, server = process.pid) => `${server}:${kind}:${id}`;
export const withOwner = (env, kind, id) => ({ ...env, [OWNER_ENV]: ownerTag(kind, id) });
const parseOwner = (s) => {
  const m = /^(\d+):(task|chat):(.+)$/.exec(s || '');
  return m && { tag: s, server: Number(m[1]), kind: m[2], id: m[3] };
};

// Categories the reaper may kill on its own, with the minimum tree age (s). Login sessions only while no login is active.
export const REAP = { 'orphaned agent': 120, 'test server': 1800, browser: 600, 'login session': 120 };
// Never killed, not even by hand (running task trees go through the task pause API).
export const PROTECTED = new Set(['live server', 'system', 'owner terminal']);
export const manualKillable = (cat) => !PROTECTED.has(cat) && !cat.startsWith('task:');

const CLK = 100; // USER_HZ
const MAX_REGISTERED = 2000;
const registered = new Map(); // pid -> {tag, pgid, start}

// Called by CLI adapters (agents.mjs spawnJsonl) for each agent process they spawn on behalf of a task or chat.
export function registerPid({ pid, pgid = pid, kind, id, procDir = '/proc' }) {
  if (!pid) return;
  registered.set(pid, { tag: ownerTag(kind, id), pgid, start: readStat(procDir, pid)?.start ?? null });
  if (registered.size > MAX_REGISTERED) registered.delete(registered.keys().next().value);
}
export const registeredPids = () => registered;

// ---- /proc reading
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
function readStat(dir, pid) {
  const s = read(path.join(dir, String(pid), 'stat'));
  if (!s) return null;
  const l = s.indexOf('('), r = s.lastIndexOf(')');
  const f = s.slice(r + 2).split(' ');
  return { comm: s.slice(l + 1, r), state: f[0], ppid: Number(f[1]), pgid: Number(f[2]), ticks: Number(f[11]) + Number(f[12]), start: Number(f[19]) };
}
const kb = (text, key) => { const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text || ''); return m ? Number(m[1]) * 1024 : null; };

export function readProcesses(dir = '/proc') {
  const procs = new Map();
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)); } catch {}
  for (const n of names) {
    const pid = Number(n), st = readStat(dir, pid);
    if (!st) continue;
    const status = read(path.join(dir, n, 'status')) || '';
    const argv = (read(path.join(dir, n, 'cmdline')) || '').split('\0').filter(Boolean);
    const env = {};
    for (const kv of (read(path.join(dir, n, 'environ')) || '').split('\0')) {
      const i = kv.indexOf('=');
      if (i > 0 && /^(AGENT_ORCH_OWNER|CW_DATA_DIR|PORT)$/.test(kv.slice(0, i))) env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    let cwd = null;
    try { cwd = fs.readlinkSync(path.join(dir, n, 'cwd')); } catch {}
    procs.set(pid, {
      pid, ...st, uid: Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? -1), argv, env, cwd,
      cgroup: read(path.join(dir, n, 'cgroup')) || '',
      rss: kb(status, 'VmRSS') || 0, pss: kb(read(path.join(dir, n, 'smaps_rollup')), 'Pss'),
    });
  }
  return procs;
}

// macOS has no /proc (the worker daemon on the owner's Mac): the same shape from os.*, `vm_stat` and `sysctl vm.swapusage`.
export function readSystem(dir = '/proc') {
  if (process.platform === 'darwin' && dir === '/proc') return readSystemDarwin();
  const mem = read(path.join(dir, 'meminfo')) || '';
  const cpus = [];
  for (const line of (read(path.join(dir, 'stat')) || '').split('\n')) {
    const m = /^cpu(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    cpus.push({ total: v.slice(0, 8).reduce((a, b) => a + b, 0), idle: v[3] + (v[4] || 0) });
  }
  const load = (read(path.join(dir, 'loadavg')) || '0 0 0').split(' ').slice(0, 3).map(Number);
  return {
    memTotal: kb(mem, 'MemTotal'), memAvailable: kb(mem, 'MemAvailable'), swapTotal: kb(mem, 'SwapTotal'), swapFree: kb(mem, 'SwapFree'),
    load, cpus, uptime: Number((read(path.join(dir, 'uptime')) || '0').split(' ')[0]),
  };
}

// CPU % per core between two readSystem() `cpus` readings (0 for a core with no earlier reading).
export const cpuPercent = (prev, cpus) => cpus.map((c, i) => {
  const b = prev?.[i], d = b ? c.total - b.total : 0;
  return d > 0 ? Math.round(Math.max(0, 1 - (c.idle - b.idle) / d) * 1000) / 10 : 0;
});

// `vm_stat` → bytes the system could hand out without swapping (free + inactive + speculative + purgeable pages), like
// Linux's MemAvailable. null when unparseable.
export function parseVmStat(text) {
  const page = Number(/page size of (\d+) bytes/.exec(text || '')?.[1]);
  if (!page) return null;
  const pages = (k) => Number(new RegExp(`^Pages ${k}:\\s+(\\d+)`, 'm').exec(text)?.[1] || 0);
  return (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * page;
}
// `sysctl -n vm.swapusage` ("total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)") → {swapTotal, swapFree} bytes.
export function parseSwapUsage(text) {
  const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
  const v = (k) => { const m = new RegExp(`${k} = ([\\d.]+)([KMG])`).exec(text || ''); return m ? Math.round(Number(m[1]) * unit[m[2]]) : null; };
  return { swapTotal: v('total'), swapFree: v('free') };
}
// macOS power for worker telemetry. `pmset -g batt` ("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t64%;
// charging; 1:10 remaining") → {pct, charging, source: 'ac' | 'battery'}; null without a battery (a Mac mini).
export function parseBattery(text) {
  const m = /(\d{1,3})%;\s*([^;\n]+)/.exec(text || '');
  if (!m) return null;
  const state = m[2].trim().toLowerCase();
  return { pct: Number(m[1]), charging: state === 'charging' || state === 'finishing charge',
    source: /'AC Power'/.test(text) ? 'ac' : /'Battery Power'/.test(text) ? 'battery' : null };
}
// `pmset -g therm`: CPU_Speed_Limit (100 = not throttled) and any thermal warning level → {pressure: 'nominal' |
// 'throttled', speedLimit, warning}; the "No … has been recorded" notes mean nominal.
export function parseThermal(text) {
  if (!text) return null;
  const speed = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(text), warn = /thermal warning level\D{0,20}?(\d+)/i.exec(text);
  const speedLimit = speed ? Number(speed[1]) : null, warning = warn ? Number(warn[1]) : null;
  return { pressure: (speedLimit != null && speedLimit < 100) || warning > 0 ? 'throttled' : 'nominal', speedLimit, warning };
}
export async function readPowerDarwin() {
  const out = (args) => helperOut('/usr/bin/pmset', args, { timeoutMs: 3000 }).catch(() => '');
  const [batt, therm] = await Promise.all([out(['-g', 'batt']), out(['-g', 'therm'])]);
  return { battery: parseBattery(batt), thermal: parseThermal(therm) };
}
function readSystemDarwin() {
  const out = (cmd, args) => { const r = runHelperSync(cmd, args, { timeoutMs: 3000 }); return r.status === 0 ? r.stdout : ''; };
  const avail = parseVmStat(out('/usr/bin/vm_stat', []));
  const swap = parseSwapUsage(out('/usr/sbin/sysctl', ['-n', 'vm.swapusage']));
  const cpus = os.cpus().map(({ times: t }) => ({ total: (t.user + t.nice + t.sys + t.idle + t.irq) / 10, idle: t.idle / 10 }));
  return { memTotal: os.totalmem(), memAvailable: avail ?? os.freemem(), ...swap, load: os.loadavg(), cpus, uptime: os.uptime() };
}

// ---- classification
const base = (s) => path.basename(String(s || ''));
const AGENT_BIN = /^(claude|codex|ccd-cli)$/;
const AGENT_SCRIPT = /(^|\/)(claude|codex)(\.m?js)?$|@anthropic-ai\/claude|@openai\/codex|mcp|language-?server|langserver/i;
const LANG_BIN = /(language-?server|langserver|^gopls$|^rust-analyzer$|^clangd$|mcp)/i;
const SYSTEM = /^(systemd|\(sd-pam\)|sd-pam|dbus-daemon|dbus-broker|sshd|sshd-session|sshd-auth|agetty|cron|login|su|sudo|gpg-agent|ssh-agent|pipewire|wireplumber|at-spi.*)$/;
export const isBrowser = (p) => /^(chrome|chromium|chromium-browser|headless_shell|chrome_crashpad_handler|chrome-headless-shell)$/.test(base(p.argv[0]) || p.comm) ||
  /ms-playwright|playwright/.test(p.argv[0] || '');
export function isAgent(p) {
  const b = base(p.argv[0]) || p.comm;
  if (AGENT_BIN.test(b) || LANG_BIN.test(b)) return true;
  return /^(node|bun|deno|python3?)$/.test(b) && p.argv.slice(1, 3).some((a) => !a.startsWith('-') && AGENT_SCRIPT.test(a));
}
const isServerMjs = (p) => /^node/.test(base(p.argv[0]) || p.comm) && p.argv.some((a) => base(a) === 'server.mjs');
export function isTestServer(p, tmpDirs) {
  if (!isServerMjs(p)) return false;
  const d = p.env.CW_DATA_DIR;
  const inTmp = d && (tmpDirs.some((t) => d === t || d.startsWith(t.replace(/\/?$/, '/'))) || d.includes('/node_modules/.cache/'));
  return !!inTmp || (p.env.PORT != null && p.env.PORT !== '3000');
}
const isLogin = (p) => base(p.argv[0]) === 'tmux' && p.argv.join(' ').includes('agent-orch-login');

// Classifies every process. ctx: {uid, selfPid, isActive({kind,id}), tmpDirs, registered}. Returns Map pid → category.
export function classify(procs, { uid, selfPid = process.pid, isActive = () => false, tmpDirs = defaultTmpDirs(), registered: reg = registered } = {}) {
  const cats = new Map();
  const ownerOf = (p) => {
    const r = reg.get(p.pid);
    if (r && (r.start == null || r.start === p.start)) return parseOwner(r.tag);
    return parseOwner(p.env.AGENT_ORCH_OWNER);
  };
  // A tree starts at init/systemd; below another user's process (sshd, sudo) a process inherits 'system'.
  const rootish = (p, par) => !par || p.ppid <= 1 || par.comm === 'systemd';
  // A leftover's category: a browser or test server keeps its own (and its own age limit); anything else is an orphaned agent.
  const leftover = (p) => (isBrowser(p) ? 'browser' : isTestServer(p, tmpDirs) ? 'test server' : 'orphaned agent');
  function rootCat(p) {
    if (isTestServer(p, tmpDirs)) return 'test server';
    if (/agent-orch\.service/.test(p.cgroup) && isServerMjs(p)) return 'live server';
    if (/agent-orch-(tmux|shell)\.service/.test(p.cgroup) || base(p.argv[0]) === 'ttyd') return 'owner terminal';
    if (isLogin(p)) return 'login session';
    if (base(p.argv[0]) === 'tmux') return 'owner terminal';
    if (isBrowser(p)) return 'browser';
    if (isAgent(p)) return 'orphaned agent';
    if (SYSTEM.test(p.comm) || SYSTEM.test(base(p.argv[0]))) return 'system';
    return 'other';
  }
  const seen = new Set();
  function cat(p) {
    if (cats.has(p.pid)) return cats.get(p.pid);
    if (seen.has(p.pid)) return 'other'; // ppid cycle (can't happen in a real /proc)
    seen.add(p.pid);
    const c = decide(p);
    cats.set(p.pid, c);
    return c;
  }
  function decide(p) {
    if (p.uid !== uid || p.pid <= 2 || p.ppid === 2) return 'system';
    if (p.pid === selfPid) return 'live server';
    const par = procs.get(p.ppid), own = ownerOf(p);
    if (own && own.tag !== (par && ownerOf(par))?.tag) {
      if (own.server === selfPid) return isActive(own) ? (own.kind === 'task' ? `task:${own.id}` : 'chat') : leftover(p);
      if (!procs.has(own.server)) return leftover(p); // its server is gone
    }
    return rootish(p, par) ? rootCat(p) : cat(par);
  }
  for (const p of procs.values()) cat(p);
  return cats;
}

// Groups classified processes into trees: a tree root is a process whose parent has another category (or none).
export function buildTrees(procs, cats, { uptime, cpu = new Map() } = {}) {
  const roots = new Map();
  const rootOf = (p) => {
    for (let q = p, n = 0; ; n++) {
      const par = procs.get(q.ppid);
      if (!par || q.ppid <= 1 || cats.get(par.pid) !== cats.get(q.pid) || n > 1000) return q;
      q = par;
    }
  };
  for (const p of procs.values()) {
    const r = rootOf(p);
    let t = roots.get(r.pid);
    if (!t) {
      roots.set(r.pid, t = { pid: r.pid, pgid: r.pgid, category: cats.get(r.pid), cmd: r.argv.join(' ').slice(0, 200) || `[${r.comm}]`,
        cwd: r.cwd, ageSec: uptime ? Math.max(0, Math.round(uptime - r.start / CLK)) : null, count: 0, rss: 0, pss: 0, cpu: 0, pids: [], procs: [] });
    }
    t.count++; t.rss += p.rss; t.pss += p.pss ?? p.rss; t.cpu += cpu.get(p.pid) || 0;
    t.pids.push(p.pid);
    t.procs.push(p);
  }
  return [...roots.values()];
}

export function defaultTmpDirs() {
  return [...new Set(['/tmp', '/var/tmp', os.tmpdir()])];
}

// ---- the monitor + reaper
// opts: procDir, dataDir, uid, selfPid, isActive, loginActive, log(message, level), kill(pid, sig), mode 'on'|'dry'|'off',
// intervalMs, killWaitMs, tmpDirs, registered (pid registry; tests pass their own).
export function createResources({ procDir = '/proc', dataDir, uid = process.getuid?.() ?? -1, selfPid = process.pid, isActive = () => false,
  loginActive = () => false, log = () => {}, kill = (pid, sig) => process.kill(pid, sig), mode = 'on', intervalMs = 10_000, killWaitMs = 5000,
  tmpDirs = defaultTmpDirs(), registered: reg = registered } = {}) {
  const logFile = dataDir ? path.join(dataDir, 'metrics', 'reaper.jsonl') : null;
  let prev = null, last = null, timer = null;
  const dryLogged = new Set();

  function sample() {
    const system = readSystem(procDir), procs = readProcesses(procDir);
    for (const pid of reg.keys()) if (!procs.has(pid)) reg.delete(pid);
    const cpu = new Map();
    const t = Date.now();
    if (prev) {
      const dt = (t - prev.t) / 1000;
      for (const p of procs.values()) {
        const before = prev.ticks.get(p.pid);
        if (before && before.start === p.start && dt > 0) cpu.set(p.pid, Math.max(0, (p.ticks - before.ticks) / CLK / dt * 100));
      }
      system.cpuPct = cpuPercent(prev.cpus, system.cpus);
    } else system.cpuPct = system.cpus.map(() => 0);
    prev = { t, cpus: system.cpus, ticks: new Map([...procs.values()].map((p) => [p.pid, { ticks: p.ticks, start: p.start }])) };
    const cats = classify(procs, { uid, selfPid, isActive, tmpDirs, registered: reg });
    const trees = buildTrees(procs, cats, { uptime: system.uptime, cpu });
    last = { at: t, system, procs, cats, cpu, trees };
    return last;
  }
  const snap = () => last || sample();

  const eligible = (t) => REAP[t.category] != null && t.ageSec != null && t.ageSec >= REAP[t.category] &&
    (t.category !== 'login session' || !loginActive());
  const candidates = (s = snap()) => s.trees.filter(eligible);

  function append(entry) {
    if (!logFile) return;
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, JSON.stringify(entry) + '\n'); } catch {}
  }

  // Kills one tree: SIGTERM now, SIGKILL after killWaitMs to whatever is still the same process. The whole process group
  // is signalled only when every member of that group is in the tree; otherwise each tree member gets its own signal.
  // Every target is re-checked (owner uid, not us, not a protected category) right before signalling.
  function killTree(tree, s, { reason, allow }) {
    const targets = tree.procs.filter((p) => p.uid === uid && p.pid > 1 && p.pid !== selfPid && allow(s.cats.get(p.pid)));
    if (!targets.length) return null;
    const set = new Set(targets.map((p) => p.pid));
    const group = tree.pgid === tree.pid && [...s.procs.values()].every((p) => p.pgid !== tree.pgid || set.has(p.pid));
    const signal = (sig) => {
      if (group) { try { kill(-tree.pgid, sig); return; } catch {} }
      for (const p of targets) { try { kill(p.pid, sig); } catch {} }
    };
    signal('SIGTERM');
    const t = setTimeout(() => {
      const alive = targets.filter((p) => readStat(procDir, p.pid)?.start === p.start);
      if (!alive.length) return;
      const root = targets.find((p) => p.pid === tree.pid);
      if (group && root && alive.includes(root)) { try { kill(-tree.pgid, 'SIGKILL'); } catch {} }
      for (const p of alive) { try { kill(p.pid, 'SIGKILL'); } catch {} }
    }, killWaitMs);
    t.unref?.();
    const freed = targets.reduce((a, p) => a + (p.pss ?? p.rss), 0);
    const entry = { at: Date.now(), pid: tree.pid, category: tree.category, cmd: tree.cmd.slice(0, 160), rss: freed, count: targets.length, reason };
    append(entry);
    log(`reaper: killed ${tree.category} pid ${tree.pid} (${targets.length} process${targets.length > 1 ? 'es' : ''}, ${mb(freed)} MB): ${entry.cmd.slice(0, 80)}`, 'warn');
    return entry;
  }

  // Automatic reaping. dryRun (or mode 'dry') only records what would be killed, once per process.
  function reap({ dryRun = mode === 'dry', reason = 'auto' } = {}) {
    if (mode === 'off') return [];
    const s = sample(), out = [];
    for (const t of candidates(s)) {
      if (dryRun) {
        const key = `${t.pid}:${t.procs.find((p) => p.pid === t.pid)?.start}`;
        const entry = { at: Date.now(), pid: t.pid, category: t.category, cmd: t.cmd.slice(0, 160), rss: t.pss, count: t.count, reason, dryRun: true };
        if (!dryLogged.has(key)) { dryLogged.add(key); append(entry); } // reaper.jsonl only: a dry run kills nothing
        out.push(entry);
        continue;
      }
      const e = killTree(t, s, { reason, allow: (c) => c === t.category && REAP[c] != null });
      if (e) out.push(e);
    }
    return out;
  }

  // Owner-initiated kill of pid and its same-category descendants.
  function killPid(pid) {
    const s = sample(), p = s.procs.get(Number(pid));
    if (!p) return { status: 404, error: 'No such process' };
    const cat = s.cats.get(p.pid);
    if (p.uid !== uid) return { status: 403, error: 'Not owned by this user' };
    if (cat.startsWith('task:')) return { status: 409, error: `Belongs to running task #${cat.slice(5)}: pause the task instead` };
    if (!manualKillable(cat)) return { status: 403, error: `Refusing to kill a ${cat} process` };
    const procs = [p], seen = new Set([p.pid]);
    for (let i = 0; i < procs.length; i++) {
      for (const c of s.procs.values()) if (c.ppid === procs[i].pid && !seen.has(c.pid) && s.cats.get(c.pid) === cat) { seen.add(c.pid); procs.push(c); }
    }
    const tree = { pid: p.pid, pgid: p.pgid, category: cat, cmd: p.argv.join(' ') || `[${p.comm}]`, procs };
    const entry = killTree(tree, s, { reason: 'manual', allow: (c) => c === cat && manualKillable(c) });
    return entry ? { ok: true, killed: entry } : { status: 403, error: 'Nothing killable' };
  }

  function recentLog(n = 50) {
    if (!logFile) return [];
    const text = read(logFile) || '';
    return text.trim().split('\n').slice(-n).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).reverse();
  }

  // The API view: system summary, trees grouped by category with their top processes, reclaimable estimate, reaper log.
  function summary() {
    const s = snap(), sys = s.system;
    const view = (t) => ({
      pid: t.pid, pgid: t.pgid, category: t.category, cmd: t.cmd, cwd: t.cwd, ageSec: t.ageSec, count: t.count, rss: t.rss, pss: t.pss,
      cpu: Math.round(t.cpu * 10) / 10, reapable: eligible(t), killable: manualKillable(t.category),
      top: [...t.procs].sort((a, b) => b.rss - a.rss).slice(0, 5).map((p) => ({
        pid: p.pid, ppid: p.ppid, cmd: (p.argv.join(' ') || `[${p.comm}]`).slice(0, 200), rss: p.rss, pss: p.pss, cpu: Math.round((s.cpu.get(p.pid) || 0) * 10) / 10,
        ageSec: sys.uptime ? Math.max(0, Math.round(sys.uptime - p.start / CLK)) : null, cwd: p.cwd,
      })),
    });
    const groups = new Map();
    for (const t of s.trees) {
      const key = t.category.startsWith('task:') ? 'task' : t.category;
      if (!groups.has(key)) groups.set(key, { category: key, count: 0, rss: 0, pss: 0, cpu: 0, trees: [] });
      const g = groups.get(key);
      g.count += t.count; g.rss += t.rss; g.pss += t.pss; g.cpu += t.cpu; g.trees.push(t);
    }
    const leftovers = s.trees.filter((t) => REAP[t.category] != null && (t.category !== 'login session' || !loginActive()));
    const now = candidates(s);
    return {
      at: s.at, mode,
      system: {
        memTotal: sys.memTotal, memAvailable: sys.memAvailable, swapTotal: sys.swapTotal, swapUsed: sys.swapTotal != null ? sys.swapTotal - (sys.swapFree || 0) : null,
        load: sys.load, cpuPct: sys.cpuPct, cores: sys.cpus.length, processes: s.procs.size,
      },
      groups: [...groups.values()].sort((a, b) => b.pss - a.pss).map((g) => ({
        ...g, cpu: Math.round(g.cpu * 10) / 10, trees: g.trees.sort((a, b) => b.pss - a.pss).slice(0, 20).map(view),
      })),
      reclaimable: { bytes: leftovers.reduce((a, t) => a + t.pss, 0), trees: leftovers.length, nowBytes: now.reduce((a, t) => a + t.pss, 0), now: now.length },
      reaper: recentLog(),
    };
  }

  function start() {
    if (timer) return;
    const run = () => { try { mode === 'off' ? sample() : reap(); } catch (e) { console.error('[resources] sample failed', e); } };
    run();
    timer = setInterval(run, intervalMs);
    timer.unref?.();
  }
  const stop = () => { clearInterval(timer); timer = null; };

  return { sample, snapshot: snap, candidates, reap, killPid, summary, recentLog, start, stop };
}
const mb = (b) => Math.round((b || 0) / 1024 ** 2);
