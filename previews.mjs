// Live previews: each project can be served at https://<slug>.<domain>, on any of the owner's domains (each with wildcard
// DNS to this head; the list lives in previews.json, first = default). The head runs the project's main tree and Caddy
// proxies the subdomain to it:
//   - Caddy: agent-orch owns ONE file, /etc/caddy/agent-orch-previews.caddy, regenerated from previews.json, and adds
//     `import <that file>` to the owner's Caddyfile once (backed up first). The owner's own site blocks are never edited.
//     Every change is `caddy validate`d first; a failure restores the previous files and reports the error.
//   - Running (detectKind): package.json with a start script → `npm start` with PORT (built first if it has a build
//     script); a build script only → static files from dist/, build/ or out/; index.html (or public/index.html) → static,
//     served in-process; index.php → `php -S`. Ports come from PORTS and stay with the project. Processes are detached,
//     tagged AGENT_ORCH_PREVIEW=<host>, restarted on a crash with backoff, and killed/restarted when the server boots.
//   - Redeploy: `redeploy(dir)` after every commit/merge to the project's main tree (server.mjs syncGit), debounced, and
//     skipped when HEAD hasn't moved since the last healthy deploy. `restart(dir)` always redeploys.
// API: createPreviews({dataDir, domain (the first default), caddyfile, includeFile, exec, forbid, onChange, …}) →
//   {domains(), addDomain(d), removeDomain(d), check(slug, dir, domain), set(dir, slug, domain), remove(dir), view(dir), list(),
//    redeploy(dir), restart(dir), logs(dir), startAll(), stopAll()}.
// Tests inject `exec` (no real sudo/caddy) and `caddyfile`/`includeFile` paths in a temp dir.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { spawn, execFile } from 'node:child_process';

export const PORTS = [4400, 4999];
export const RESERVED = ['www', 'files', 'shell', 'api', 'admin', 'mail', 'smtp', 'imap', 'ftp', 'ns1', 'ns2', 'mx', 'cdn', 'static', 'app', 'agent-orch'];
const LOG_LINES = 200;
const HEALTH_MS = 30000;
const INSTALL_MS = 10 * 60000;

// Lowercase a-z0-9 and single hyphens, 3-40 chars, no leading/trailing hyphen ('' when nothing usable is left).
export function normalizeSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

// Hostnames under `domain` that the Caddyfile already serves (the owner's own sites): their first label is taken.
export function caddySubdomains(text, domain) {
  const out = new Set();
  let depth = 0;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (depth === 0 && line.endsWith('{')) {
      for (const addr of line.slice(0, -1).split(/[\s,]+/)) {
        const host = addr.replace(/^https?:\/\//, '').replace(/[:/].*$/, '').toLowerCase();
        if (host === domain) out.add('');
        else if (host.endsWith(`.${domain}`)) out.add(host.slice(0, -domain.length - 1).split('.').pop());
      }
    }
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
  }
  return out;
}

// The include file Caddy imports: one site block per preview ({slug, domain, port}).
export function renderCaddy(entries) {
  const head = '# Managed by agent-orch (previews.mjs): live previews. Regenerated on every change; edits here are overwritten.\n';
  return head + entries.map((e) => [`${e.slug}.${e.domain}`, e.port]).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([host, port]) => `\n${host} {\n\tencode gzip\n\treverse_proxy 127.0.0.1:${port}\n}\n`).join('');
}
// A bare hostname such as example.com (lowercase, at least two labels).
export function normalizeDomain(d) {
  const v = String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^\*\./, '').replace(/[/:].*$/, '').replace(/\.$/, '');
  return /^(?=.{3,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v) ? v : '';
}

// What the project folder serves, or null when there's nothing yet.
export function detectKind(dir) {
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {}
  const scripts = pkg?.scripts || {};
  if (scripts.start) return { kind: 'node', install: true, build: !!scripts.build };
  if (scripts.build) return { kind: 'static', install: true, build: true, roots: ['dist', 'build', 'out'] };
  for (const r of ['.', 'public']) if (fs.existsSync(path.join(dir, r, 'index.html'))) return { kind: 'static', install: false, build: false, roots: [r] };
  if (fs.existsSync(path.join(dir, 'index.php'))) return { kind: 'php', install: false, build: false };
  return null;
}
export const NOTHING_TO_SERVE = 'Nothing to serve yet: add an index.html, or a package.json "start" script that listens on $PORT.';

// sudo commands for the real head; tests pass their own.
function defaultExec(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 60000 }, (err, stdout, stderr) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') })));
}

const TYPES = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
  json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  ico: 'image/x-icon', txt: 'text/plain; charset=utf-8', woff: 'font/woff', woff2: 'font/woff2', wasm: 'application/wasm', map: 'application/json',
  webmanifest: 'application/manifest+json', mp4: 'video/mp4', mp3: 'audio/mpeg', pdf: 'application/pdf', xml: 'application/xml' };
// A small static file server (SPA-friendly: an extensionless miss serves index.html).
function staticServer(root) {
  return http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
    let file = path.resolve(root, '.' + rel);
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch {}
    if (!fs.existsSync(file) && !path.extname(rel)) file = path.join(root, 'index.html');
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  });
}

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
  s.listen(port, '127.0.0.1');
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Any HTTP answer below 500 means the app is up.
const probe = (port) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
  req.on('error', () => resolve(false)).on('timeout', () => { req.destroy(); resolve(false); });
});
const gitHead = (dir) => new Promise((resolve) => execFile('git', ['rev-parse', 'HEAD'], { cwd: dir, timeout: 10000 }, (err, out) => resolve(err ? null : String(out).trim())));

export function createPreviews({
  dataDir, domain = 'greygoose.baby', caddyfile = '/etc/caddy/Caddyfile', includeFile = '/etc/caddy/agent-orch-previews.caddy',
  exec = defaultExec, forbid = [], onChange = () => {}, log = () => {}, ports = PORTS, debounceMs = 2000, healthMs = HEALTH_MS,
  spawnFn = spawn,
} = {}) {
  const file = path.join(dataDir, 'previews.json');
  const logDir = path.join(dataDir, 'previews');
  fs.mkdirSync(logDir, { recursive: true });
  let store = {}, domainList = [domain];
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    store = saved.entries || {};
    if (saved.domains?.length) domainList = saved.domains;
  } catch {}
  for (const e of Object.values(store)) e.domain ||= domainList[0];
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify({ domains: domainList, entries: store }, null, 2)); fs.renameSync(file + '.tmp', file); };
  const live = new Map(); // dir -> { status, kind, error, updatedAt, child, server, gen, timer, crashes, head, busy }
  const st = (dir) => { if (!live.has(dir)) live.set(dir, { status: 'stopped', gen: 0, crashes: 0 }); return live.get(dir); };
  const url = (slug, d) => `https://${slug}.${d}`;
  const hostOf = (e) => `${e.slug}.${e.domain}`;
  const logFile = (e) => path.join(logDir, `${hostOf(e)}.log`);

  function setStatus(dir, status, extra = {}) {
    Object.assign(st(dir), { status, error: null, ...extra, updatedAt: Date.now() });
    onChange(dir);
  }
  function appendLog(e, text) {
    try { fs.appendFileSync(logFile(e), `[agent-orch ${new Date().toISOString()}] ${text}\n`); } catch {}
  }

  function check(raw, dir = null, dom = null) {
    const slug = normalizeSlug(raw), d = dom || store[dir]?.domain || domainList[0];
    const bad = (error) => ({ ok: false, slug, domain: d, url: slug ? url(slug, d) : null, error });
    if (!domainList.includes(d)) return bad(`${d} isn't one of your preview domains.`);
    if (slug.length < 3) return bad('Use at least 3 letters or digits.');
    if (dir && forbid.some((f) => path.resolve(dir) === f || path.resolve(dir).startsWith(f + path.sep))) return bad("agent-orch can't preview its own folder.");
    if (RESERVED.includes(slug)) return bad('That name is reserved.');
    let caddy = '';
    try { caddy = fs.readFileSync(caddyfile, 'utf8'); } catch {}
    if (caddySubdomains(caddy, d).has(slug)) return bad('Already used by another site on this server.');
    const owner = Object.entries(store).find(([k, e]) => e.slug === slug && e.domain === d && k !== dir);
    if (owner) return bad(`Taken by ${path.basename(owner[0])}.`);
    return { ok: true, slug, domain: d, url: url(slug, d) };
  }

  // ---- Caddy: write the include, make sure the Caddyfile imports it, validate, reload; roll back on failure.
  let caddyChain = Promise.resolve();
  const readOr = (f, d = null) => { try { return fs.readFileSync(f, 'utf8'); } catch { return d; } };
  async function writeRoot(dest, content) {
    const tmp = path.join(dataDir, `.caddy-${process.pid}-${path.basename(dest)}`);
    fs.writeFileSync(tmp, content);
    const r = await exec('sudo', ['install', '-m', '644', tmp, dest]);
    fs.rmSync(tmp, { force: true });
    if (r.code) throw new Error(`Couldn't write ${dest}: ${r.stderr.trim()}`);
  }
  function applyCaddy() {
    const next = caddyChain.then(async () => {
      const content = renderCaddy(Object.values(store));
      const prevInclude = readOr(includeFile), prevMain = readOr(caddyfile, '');
      const importLine = `import ${includeFile}`;
      const needsImport = !prevMain.split('\n').some((l) => l.trim() === importLine);
      if (prevInclude === content && !needsImport) return { ok: true, changed: false };
      if (needsImport) {
        const bak = `${caddyfile}.bak-agent-orch`;
        if (!fs.existsSync(bak)) {
          const r = await exec('sudo', ['cp', '-p', caddyfile, bak]);
          if (r.code) throw new Error(`Couldn't back up ${caddyfile}: ${r.stderr.trim()}`);
        }
      }
      await writeRoot(includeFile, content);
      if (needsImport) await writeRoot(caddyfile, `${prevMain.replace(/\n*$/, '\n')}\n# Live previews managed by agent-orch\n${importLine}\n`);
      const v = await exec('sudo', ['caddy', 'validate', '--config', caddyfile, '--adapter', 'caddyfile']);
      if (v.code) {
        if (prevInclude == null) await exec('sudo', ['rm', '-f', includeFile]); else await writeRoot(includeFile, prevInclude);
        if (needsImport) await writeRoot(caddyfile, prevMain);
        const msg = (v.stderr + v.stdout).split('\n').filter((l) => /error/i.test(l)).pop() || v.stderr.trim().split('\n').pop() || 'caddy validate failed';
        throw new Error(`Caddy rejected the config (rolled back): ${msg.slice(0, 400)}`);
      }
      const r = await exec('sudo', ['systemctl', 'reload', 'caddy']);
      if (r.code) throw new Error(`Caddy reload failed: ${r.stderr.trim().slice(0, 400)}`);
      log(`caddy: ${Object.keys(store).length} preview(s) applied`);
      return { ok: true, changed: true };
    });
    caddyChain = next.catch(() => {});
    return next;
  }

  // ---- Ports
  async function pickPort(dir) {
    const used = new Set(Object.entries(store).filter(([d]) => d !== dir).map(([, e]) => e.port));
    for (let p = ports[0]; p <= ports[1]; p++) if (!used.has(p) && (await portFree(p))) return p;
    throw new Error('No free preview port left.');
  }

  // ---- Processes
  function killGroup(pid, sig = 'SIGTERM') { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} } }
  // A pid saved by an earlier server run, if it is still our preview (its environment carries the tag).
  function staleOurs(pid, e) {
    if (!pid) return false;
    try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`AGENT_ORCH_PREVIEW=${hostOf(e)}`); } catch { return false; }
  }
  async function stop(dir) {
    const s = st(dir), e = store[dir];
    s.gen++;
    clearTimeout(s.restartTimer);
    if (s.server) { const srv = s.server; s.server = null; await new Promise((r) => srv.close(() => r())); }
    if (s.child) {
      const child = s.child; s.child = null;
      if (child.exitCode == null) {
        killGroup(child.pid);
        await Promise.race([new Promise((r) => child.once('exit', r)), sleep(4000)]);
        if (child.exitCode == null) killGroup(child.pid, 'SIGKILL');
      }
    }
    if (e?.pid) { if (staleOurs(e.pid, e)) { killGroup(e.pid); await sleep(500); killGroup(e.pid, 'SIGKILL'); } e.pid = null; save(); }
  }
  // Run a setup step (install/build) into the log, resolving to its exit code.
  function step(dir, e, cmd, args, env) {
    appendLog(e, `$ ${cmd} ${args.join(' ')}`);
    return new Promise((resolve) => {
      const fd = fs.openSync(logFile(e), 'a');
      const child = spawnFn(cmd, args, { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd] });
      fs.closeSync(fd);
      const t = setTimeout(() => child.kill('SIGKILL'), INSTALL_MS);
      child.once('error', (err) => { clearTimeout(t); appendLog(e, err.message); resolve(1); });
      child.once('exit', (code) => { clearTimeout(t); resolve(code ?? 1); });
    });
  }
  const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  function needsInstall(dir) {
    const pkg = path.join(dir, 'package.json'), nm = path.join(dir, 'node_modules');
    try { const p = JSON.parse(fs.readFileSync(pkg, 'utf8')); if (!Object.keys({ ...p.dependencies, ...p.devDependencies }).length) return false; } catch { return false; }
    return !fs.existsSync(nm) || Math.max(mtime(pkg), mtime(path.join(dir, 'package-lock.json'))) > mtime(nm);
  }

  async function deploy(dir) {
    const e = store[dir];
    if (!e) return;
    await stop(dir);
    const s = st(dir), gen = s.gen, port = e.port;
    const stale = () => s.gen !== gen || store[dir] !== e;
    s.head = await gitHead(dir);
    const kind = fs.existsSync(dir) ? detectKind(dir) : null;
    if (!kind) return setStatus(dir, 'waiting', { kind: null, error: NOTHING_TO_SERVE });
    fs.writeFileSync(logFile(e), '');
    setStatus(dir, 'building', { kind: kind.kind });
    try {
      if (kind.install && needsInstall(dir)) {
        const lock = fs.existsSync(path.join(dir, 'package-lock.json'));
        if (await step(dir, e, 'npm', [lock ? 'ci' : 'install', '--no-audit', '--no-fund'], {})) throw new Error('npm install failed');
        if (stale()) return;
      }
      if (kind.build) {
        if (await step(dir, e, 'npm', ['run', 'build'], {})) throw new Error('npm run build failed');
        if (stale()) return;
      }
      if (kind.kind === 'static') {
        const root = kind.roots.map((r) => path.join(dir, r)).find((r) => fs.existsSync(path.join(r, 'index.html')));
        if (!root) throw new Error(`The build made no index.html in ${kind.roots.join('/, ')}/.`);
        const srv = staticServer(path.resolve(root));
        await new Promise((resolve, reject) => srv.once('error', reject).listen(port, '127.0.0.1', resolve));
        if (stale()) { srv.close(); return; }
        s.server = srv;
        appendLog(e, `serving ${path.relative(dir, root) || '.'}/ on port ${port}`);
      } else {
        const [cmd, args] = kind.kind === 'php' ? ['php', ['-S', `127.0.0.1:${port}`, '-t', dir]] : ['npm', ['start']];
        launch(dir, e, cmd, args, gen);
      }
      const until = Date.now() + healthMs;
      while (!(await probe(port))) {
        if (stale()) return;
        if (s.child === null && kind.kind !== 'static') throw new Error('The app exited during start-up.');
        if (Date.now() > until) throw new Error(`Nothing answered on port ${port} within ${Math.round(healthMs / 1000)} s (web apps must listen on process.env.PORT).`);
        await sleep(500);
      }
      if (stale()) return;
      s.crashes = 0;
      setStatus(dir, 'running', { kind: kind.kind, healthyHead: s.head });
    } catch (err) {
      if (stale()) return;
      appendLog(e, err.message);
      setStatus(dir, 'error', { kind: kind.kind, error: err.message });
    }
  }
  function launch(dir, e, cmd, args, gen) {
    const s = st(dir);
    const fd = fs.openSync(logFile(e), 'a');
    const child = spawnFn(cmd, args, { cwd: dir, detached: true, stdio: ['ignore', fd, fd],
      env: { ...process.env, PORT: String(e.port), AGENT_ORCH_PREVIEW: hostOf(e) } });
    fs.closeSync(fd);
    s.child = child;
    e.pid = child.pid; save();
    child.once('error', (err) => appendLog(e, err.message));
    child.once('exit', (code, sig) => {
      if (s.gen !== gen || s.child !== child) return; // stopped on purpose
      s.child = null;
      appendLog(e, `exited (${sig || code})`);
      if (s.status !== 'running') return; // deploy() reports the start-up failure
      s.crashes++;
      if (s.crashes > 5) return setStatus(dir, 'error', { error: `Crashed ${s.crashes} times in a row; press Restart after fixing it.` });
      setStatus(dir, 'building', { error: `Crashed (${sig || `exit ${code}`}); restarting…` });
      s.restartTimer = setTimeout(() => { if (s.gen === gen) deploy(dir); }, Math.min(60000, 1000 * 2 ** s.crashes));
    });
  }

  // One deploy at a time per project; requests during one queue a single re-run.
  function queueDeploy(dir) {
    const s = st(dir);
    if (s.busy) { s.again = true; return s.busy; }
    s.busy = (async () => {
      try { do { s.again = false; await deploy(dir); } while (s.again && store[dir]); }
      catch (err) { log(`deploy ${dir} failed: ${err.message}`); }
      finally { s.busy = null; }
    })();
    return s.busy;
  }

  function view(dir) {
    const e = store[dir];
    if (!e) return null;
    const s = st(dir);
    return { slug: e.slug, domain: e.domain, url: url(e.slug, e.domain), port: e.port, status: s.status, kind: s.kind ?? null, error: s.error ?? null, updatedAt: s.updatedAt ?? null };
  }

  return {
    domains: () => domainList.map((d) => ({ domain: d, previews: Object.values(store).filter((e) => e.domain === d).length })),
    // A new domain for previews. Its wildcard DNS is looked up so the UI can say whether *.<domain> reaches a server.
    async addDomain(raw) {
      const d = normalizeDomain(raw);
      if (!d) return { error: 'Enter a domain such as example.com.' };
      if (!domainList.includes(d)) { domainList.push(d); save(); }
      let ips = [];
      try { ips = await dns.resolve4(`agent-orch-check.${d}`); } catch {}
      onChange(null);
      return { ok: true, domain: d, wildcard: ips };
    },
    removeDomain(raw) {
      const d = normalizeDomain(raw);
      if (!domainList.includes(d)) return { error: 'No such domain.' };
      const n = Object.values(store).filter((e) => e.domain === d).length;
      if (n) return { error: `${n} preview${n > 1 ? 's use' : ' uses'} ${d}: move or remove ${n > 1 ? 'them' : 'it'} first.` };
      if (domainList.length === 1) return { error: 'Keep at least one domain.' };
      domainList = domainList.filter((x) => x !== d);
      save();
      onChange(null);
      return { ok: true };
    },
    setDefaultDomain(raw) {
      const d = normalizeDomain(raw);
      if (!domainList.includes(d)) return { error: 'No such domain.' };
      domainList = [d, ...domainList.filter((x) => x !== d)];
      save();
      onChange(null);
      return { ok: true };
    },
    check,
    view,
    list: () => Object.keys(store).map((dir) => ({ dir, ...view(dir) })),
    // Give `dir` the address `slug`.`domain` (a new one, or a move). Resolves to {ok, ...view} or {error}.
    async set(dir, raw, dom = null) {
      const c = check(raw, dir, dom);
      if (!c.ok) return { error: c.error };
      const prev = store[dir];
      if (prev?.slug === c.slug && prev.domain === c.domain) return { ok: true, ...view(dir) };
      const port = prev?.port || (await pickPort(dir));
      if (prev) await stop(dir); // while store[dir] still names the old host (its process tag)
      store[dir] = { slug: c.slug, domain: c.domain, port, pid: null };
      save(); // before the reload, so the entry survives if this process dies during it
      try { await applyCaddy(); } catch (err) {
        if (prev) { store[dir] = prev; queueDeploy(dir); } else delete store[dir];
        save();
        return { error: err.message };
      }
      if (prev) fs.rmSync(logFile(prev), { force: true });
      queueDeploy(dir);
      onChange(dir);
      return { ok: true, ...view(dir) };
    },
    async remove(dir) {
      const e = store[dir];
      if (!e) return { ok: true };
      await stop(dir);
      delete store[dir];
      save();
      live.delete(dir);
      fs.rmSync(logFile(e), { force: true });
      try { await applyCaddy(); } catch (err) { log(err.message); }
      onChange(dir);
      return { ok: true };
    },
    // After a commit/merge: debounced; a no-op when HEAD is where the running deploy already is.
    redeploy(dir) {
      if (!store[dir]) return;
      const s = st(dir);
      clearTimeout(s.timer);
      s.timer = setTimeout(async () => {
        if (s.status === 'running' && s.healthyHead && s.healthyHead === (await gitHead(dir))) return;
        queueDeploy(dir);
      }, debounceMs);
    },
    restart: (dir) => (store[dir] ? (st(dir).crashes = 0, queueDeploy(dir)) : Promise.resolve()),
    logs(dir) {
      const e = store[dir];
      if (!e) return null;
      return (readOr(logFile(e), '') || '').split('\n').slice(-LOG_LINES - 1).join('\n');
    },
    // Boot: make sure Caddy has every preview, kill what an earlier run left behind, then start them all.
    async startAll() {
      // Also when the store is empty but the include isn't, so hosts orphaned by a crash are dropped.
      if (Object.keys(store).length || readOr(includeFile)) await applyCaddy().catch((err) => log(err.message));
      await Promise.all(Object.keys(store).map((dir) => queueDeploy(dir)));
    },
    async stopAll() { await Promise.all(Object.keys(store).map((dir) => stop(dir))); },
    applyCaddy,
  };
}
