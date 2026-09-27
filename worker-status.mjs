// A worker's terminal status view (BRIEF goal 11: the only local UI; .agent-orch/CLUSTER.md "Status view"). The daemon
// answers on a unix socket in its home (worker.sock, 0600 in a 0700 dir: only its own user; no TCP port), one JSON
// request per line: {op: 'status'} → its snapshot, {op: 'reload'} → re-read the local cap from config.json (worker.mjs
// limit). `node worker.mjs status` draws the snapshot with plain ANSI every second until q or Ctrl-C; --once (or a
// stdout that isn't a terminal) prints one. No deps.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { capText, fmtCores, fmtGB } from './cap.mjs';

export const SOCKET = 'worker.sock';
export const socketPath = (home) => path.join(home, SOCKET);
const MAX_LINE = 64 * 1024;
// A unix socket's path holds ~104 bytes (macOS; 108 on Linux). A longer one (a deep test home) is bound and dialled by
// its name relative to the home instead: listen() binds and connect() dials synchronously, so the cwd moves only for that.
const LONG = 100;
function inDir(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return fn(); } finally { process.chdir(prev); }
}

// One request → its answer (rejects when nobody listens: ENOENT, ECONNREFUSED).
export function request(home, req, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const file = socketPath(home);
    let sock, buf = '';
    try { sock = file.length > LONG ? inDir(home, () => net.connect(SOCKET)) : net.connect(file); } catch (e) { return reject(e); }
    const timer = setTimeout(() => { sock.destroy(); reject(Object.assign(new Error('the worker did not answer'), { code: 'ETIMEDOUT' })); }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      sock.end();
      try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.on('close', () => { clearTimeout(timer); reject(Object.assign(new Error('the worker closed the connection'), { code: 'ECONNRESET' })); });
  });
}

// The daemon's side: answer(req) → the reply (may be a promise). A socket file left by a daemon that died is replaced;
// one that answers means another daemon runs with this home, and this one must not start.
export async function serveStatus({ home, answer, log = () => {} }) {
  const file = socketPath(home), open = new Set();
  const onConn = (sock) => {
    let buf = '', chain = Promise.resolve();
    open.add(sock);
    sock.on('close', () => open.delete(sock));
    sock.setEncoding('utf8');
    sock.setTimeout(120_000, () => sock.destroy());
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d;
      if (buf.length > MAX_LINE) return sock.destroy();
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let req = null;
        try { req = JSON.parse(line); } catch {}
        chain = chain.then(() => answer(req)).catch((e) => ({ ok: false, error: e.message }))
          .then((res) => { if (!sock.destroyed) sock.write(`${JSON.stringify(res)}\n`); });
      }
    });
  };
  const listen = () => new Promise((resolve, reject) => {
    const server = net.createServer(onConn);
    server.maxConnections = 16;
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      server.on('error', (e) => log(`status socket: ${e.message}`, 'warn'));
      try { fs.chmodSync(file, 0o600); } catch {}
      resolve(server);
    });
    const mask = process.umask(0o177); // created 0600
    try { if (file.length > LONG) inDir(home, () => server.listen(SOCKET)); else server.listen(file); } finally { process.umask(mask); }
  });
  let server;
  try { server = await listen(); } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    if (await request(home, { op: 'ping' }, { timeoutMs: 2000 }).then(() => true, () => false)) {
      throw new Error(`another worker daemon already runs with ${home} (it answers on ${file})`);
    }
    fs.rmSync(file, { force: true });
    server = await listen();
  }
  // Closing drops any client still connected (a status view left open), so a stopping daemon doesn't wait for it.
  return { file, close: () => new Promise((r) => { server.close(() => r()); for (const c of open) c.destroy(); fs.rmSync(file, { force: true }); }) };
}

// ---------------------------------------------------------------- the view

const utf8 = () => process.platform === 'darwin' || /utf-?8/i.test(`${process.env.LC_ALL || ''}${process.env.LC_CTYPE || ''}${process.env.LANG || ''}`);
export function dur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
const ago = (ms) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s ago` : `${dur(ms).split(' ')[0]} ago`);
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return n <= 0 ? '' : s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s; };
const pad = (s, n) => clip(s, n).padEnd(n);
function bar(used, total, width, u) {
  const f = total > 0 ? Math.max(0, Math.min(width, Math.round((used / total) * width))) : 0;
  return `[${(u ? '█' : '#').repeat(f)}${(u ? '░' : '.').repeat(width - f)}]`;
}
// A line cut to `width` visible characters (ANSI sequences kept, so colours still reset).
export function fit(line, width) {
  let out = '', n = 0;
  for (let i = 0; i < line.length;) {
    const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(line.slice(i, i + 16));
    if (m) { out += m[0]; i += m[0].length; } else { if (n < width) { out += line[i]; n++; } i++; }
  }
  return out;
}
const STATE = { connected: ['32', '● Connected'], reconnecting: ['33', '◌ Reconnecting'], offline: ['31', '○ Offline'], stopping: ['33', '◌ Stopping'] };
const OUTCOME = { ok: '32', aborted: '33', cancelled: '33', rate_limited: '33', lost: '33' };

// A snapshot (worker.mjs snapshot) → the screen's lines. `down`: the daemon didn't answer ({error, config}).
export function renderStatus(s, { width = 80, color = false, now = s?.at || Date.now(), u = utf8() } = {}) {
  const c = (code, t) => (color && code ? `\x1b[${code}m${t}\x1b[0m` : t);
  const row = (label, text) => `${c('1', label.padEnd(9))}${text}`;
  const lines = [];
  const name = s?.name || s?.config?.name || 'this machine';
  lines.push(`${c('1', `agent-orch worker · ${name}`)}${c('2', `  ${new Date(now).toTimeString().slice(0, 8)}`)}`);
  if (!s?.ok) {
    const cfg = s?.config;
    if (!cfg) {
      return [...lines, row('Worker', `not paired here (no ${s?.home ? path.join(s.home, 'config.json') : 'config.json'})`), row('', c('2', process.platform === 'darwin'
        ? 'a Mac runs its worker as its own user: sudo -u agentorch -H node ~agentorch/agent-orch-worker/worker.mjs status'
        : 'pair it: node worker.mjs pair --controller https://<head> --code <code>'))];
    }
    lines.push(row('Worker', `${c('31', '○ Not running')} ${c('2', `(${s.error || 'no answer'})`)}`),
      row('', c('2', process.platform === 'darwin' ? 'launchd starts it (at boot or login); see the installer\'s log' : 'start it: sudo systemctl start agent-orch-worker (or node worker.mjs run)')),
      row('Head', cfg.controller || '?'), row('Cap', s.cap ? `${capText(s.cap, s.machine)} ${c('2', '(set on this machine)')}` : 'none'));
    return lines;
  }
  const cn = s.connection || {}, [code, label] = STATE[cn.state] || ['2', cn.state || '?'];
  const since = cn.since ? ` · ${cn.state === 'connected' ? 'for' : 'since'} ${cn.state === 'connected' ? dur(now - cn.since) : new Date(cn.since).toTimeString().slice(0, 5)}` : '';
  const retry = cn.state !== 'connected' && cn.retryAt ? ` · retry in ${dur(Math.max(0, cn.retryAt - now))}` : '';
  lines.push(row('Head', `${c(code, label)} ${c('2', `${s.controller}${since}${retry}`)}`));
  if (cn.state !== 'connected' && cn.error) lines.push(row('', c('2', clip(cn.error, width - 9))));
  const m = s.machine || {};
  lines.push(row('Cap', s.cap ? `${capText(s.cap, m)} ${c('2', '(set on this machine)')}` : `none ${c('2', `· lends all ${fmtCores(m.cores || 0)} and ${fmtGB(m.memTotal || 0)} · node worker.mjs limit`)}`));
  if (s.cap && s.limiter) lines.push(row('', c('2', `held by ${s.limiter}`)));
  const us = s.usage || { cpu: 0, mem: 0 }, bw = Math.max(10, Math.min(30, width - 45));
  const cpuMax = s.cap?.cpu ?? m.cores, memMax = s.cap?.mem ?? m.memTotal, of = s.cap ? '' : ' (machine)';
  const hot = (used, max) => (max && used > max ? '31' : max && used / max >= 0.8 ? '33' : '');
  lines.push(row('CPU', `${c(hot(us.cpu, cpuMax), bar(us.cpu, cpuMax, bw, u))}  ${+us.cpu.toFixed(1)} of ${fmtCores(cpuMax || 0)}${of} used by jobs`));
  lines.push(row('RAM', `${c(hot(us.mem, memMax), bar(us.mem, memMax, bw, u))}  ${fmtGB(us.mem)} of ${fmtGB(memMax || 0)}${of} used by jobs`));
  if (s.draining) lines.push(row('Intake', c('33', `none: ${s.draining}`)));
  else if (s.intake && !s.intake.ok) lines.push(row('Intake', c('33', `paused: ${s.intake.text || s.intake.reason}`)));
  // Job rows: #id, title, agent·model, phase, elapsed, last activity; columns sized to what is shown, the activity last.
  const jobs = s.jobs || [], done = s.finished || [], am = (j) => `${j.agent}·${j.model || 'default'}`;
  const aw = Math.min(22, Math.max(0, ...jobs.map((j) => am(j).length)));
  const tw = Math.min(40, Math.max(8, ...[...jobs, ...done].map((j) => String(j.title || '').length)), Math.max(12, width - 53 - aw));
  lines.push(row('Running', `${jobs.filter((j) => j.state !== 'paused').length} of ${s.slots ?? '?'} ${s.slots === 1 ? 'slot' : 'slots'}`));
  for (const j of jobs) {
    const act = j.activity ? `${j.activity}${j.activityAt ? ` (${ago(now - j.activityAt)})` : ''}` : '';
    const line = `  ${pad(`#${j.id}`, 6)}${pad(j.title, tw)} ${pad(am(j), aw)} ${pad(j.state === 'paused' ? 'paused' : j.phase || j.state, 10)} ${pad(dur(now - j.startedAt), 7)} `;
    lines.push(`${line}${c('2', clip(act, width - line.length))}`);
  }
  lines.push(row('Up next', s.queued == null ? c('2', cn.state === 'connected' ? 'not reported by the head' : 'unknown while away from the head')
    : `${s.queued} ${s.queued === 1 ? 'task' : 'tasks'} ready on the head for this machine`));
  lines.push(row('Finished', done.length ? c('2', `last ${done.length}`) : c('2', 'none yet')));
  for (const f of done) {
    lines.push(`  ${pad(`#${f.id}`, 6)}${pad(f.title, tw)} ${c(OUTCOME[f.outcome] || '31', pad(f.outcome, 13))} ${pad(dur(f.ms), 8)} ${c('2', ago(now - f.at))}`);
  }
  return lines;
}

// `node worker.mjs status [--once]`. config: the saved pairing (null = not paired); cap/machine: what it saves.
export async function statusCli({ home, once = false, out = process.stdout, input = process.stdin, config = null, cap = null, machine = null }) {
  const get = () => (config ? request(home, { op: 'status' }) : Promise.reject(new Error('not paired')))
    .catch((e) => ({ ok: false, config, cap, machine, home, error: e.code === 'ENOENT' ? `no status socket at ${socketPath(home)}` : e.code === 'ECONNREFUSED' ? `nobody answers on ${socketPath(home)}` : e.message }));
  const color = !!out.isTTY && !process.env.NO_COLOR, width = () => Math.max(60, out.columns || 100);
  if (once || !out.isTTY || !input.isTTY) {
    out.write(`${renderStatus(await get(), { width: width(), color }).join('\n')}\n`);
    return 0;
  }
  let last = null, busy = false, timer = null;
  const draw = () => {
    if (!last) return;
    const lines = [...renderStatus(last, { width: width(), color, now: last.ok ? undefined : Date.now() }), '', '\x1b[2mq quit\x1b[0m'];
    out.write(`\x1b[H${lines.map((l) => `${fit(l, width())}\x1b[K`).join('\n')}\x1b[J`);
  };
  const tick = async () => { if (busy) return; busy = true; try { last = await get(); } finally { busy = false; } draw(); };
  out.write('\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J'); // the alternate screen, cursor hidden
  input.setRawMode(true);
  input.setEncoding('utf8');
  input.resume();
  return new Promise((resolve) => {
    const quit = () => {
      clearInterval(timer);
      out.off('resize', draw);
      try { input.setRawMode(false); } catch {}
      input.pause();
      out.write('\x1b[?25h\x1b[?1049l');
      resolve(0);
    };
    input.on('data', (k) => { if (['q', 'Q', '\x03', '\x04', '\x1b'].includes(k)) quit(); });
    process.once('SIGTERM', quit);
    process.once('SIGHUP', quit);
    out.on('resize', draw);
    tick();
    timer = setInterval(tick, 1000);
  });
}
