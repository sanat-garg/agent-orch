// Storage (the head's Machines → Storage tab; admin only). Where the disk went, and a way to remove what isn't needed.
// Nothing here runs on a timer: a scan starts only when the owner opens the tab or presses Rescan, at the lowest CPU and
// I/O priority, one at a time (concurrent callers share it). sudo -n is used for read-only `du`, when it works, so root's
// folders count too; removal never uses it.
//   overview({fresh}) → {at, ms, disk: {total, used, free}, categories: [{id, label, hint, bytes, items, more}],
//     cleanups: [{id, title, why, bytes, memory (frees RAM, not disk), items: [{path, label, bytes, touched, restore} | {clean, label, bytes}]}], reclaimable}
//   dir(path) → {path, bytes, entries: [{path, name, bytes, dir, why}], more}: one folder measured live, for the drill-down
//   remove(paths) → {removed: [{path, bytes}], skipped: [{path, reason}], freed, disk}
//   clean(id) → the same, for what has no single path: finished tasks' transcripts, apt's cache, the systemd journal
// whyNot(path) is the one gate for every path, checked again at removal: it names why a path can't go, or returns null.
// What it refuses: anything outside the home dir and temp dirs; agent-orch and its data; project folders and anything
// holding one (deleteProject is their way out); task worktrees; sign-ins, chat history and settings of the agent CLIs;
// .git, .env and PROTECTED secrets; whatever a running program has as its folder, binary or a path argument, plus the
// node_modules, build output or virtualenv of a project something is running from.
// Suggested cleanups only list what can come back by itself or has sat untouched: caches, old temp files, the
// node_modules of idle projects (with a lockfile to restore them from), transcripts of tasks whose worktree is gone.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSecret } from './files.mjs';

const MB = 2 ** 20, DAY = 864e5;
export const CATEGORIES = [
  ['projects', 'Projects', 'Your project folders'],
  ['agents', 'Claude Code and Codex', 'Chat history, plugins and downloaded versions'],
  ['system', 'System', 'Ubuntu and installed programs'],
  ['caches', 'Caches', 'Programs rebuild these when they need them'],
  ['temp', 'Temporary files', 'Left behind in the temp folders'],
  ['swap', 'Swap', 'Overflow for memory, reserved ahead of time'],
  ['data', 'Databases and logs', 'What services keep in /var'],
  ['tools', 'Tools and settings', 'Hidden folders in your home'],
  ['app', 'agent-orch', 'This app: its code, chats and task logs'],
  ['other', 'Not counted', 'File system overhead, and deleted files still held open'],
];
const CACHE_KEEP = new Set(['ms-playwright', 'claude-cli-nodejs']); // agent-orch's browser and Claude's own: slow or unsafe to lose
const RUNTIME = new Set(['node_modules', '.next', 'dist', 'build', 'out', '.venv', 'venv']);
const LOCKS = [['package-lock.json', 'npm ci'], ['pnpm-lock.yaml', 'pnpm install'], ['yarn.lock', 'yarn install'], ['bun.lockb', 'bun install'], ['bun.lock', 'bun install']];

const under = (p, dir) => p === dir || p.startsWith(dir === '/' ? '/' : dir + path.sep);
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { maxBuffer: 256 * MB, timeout: 300e3, ...opts }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout), stderr: String(stderr) }));
});

export function createStorage({ root = '/', home = os.homedir(), appRoot, dataDir, workspace = path.join(home, 'workspace'), tmpDirs = ['/tmp', '/var/tmp'],
  projects = () => [], served = () => [], sudo: useSudo = true, minItem = 20 * MB, tempIdleDays = 3, cacheIdleDays = 1, depsIdleDays = 14, transcriptIdleDays = 14 } = {}) {
  const at = (...p) => path.join(root, ...p);
  const cli = [path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, '.config'), path.join(home, '.gemini')];
  const worktrees = [path.join(home, '.agent-orch-worktrees'), path.join(workspace, '.agent-orch-worktrees')];
  const keep = [appRoot, dataDir, path.join(home, '.ssh'), ...worktrees, ...[...CACHE_KEEP].map((n) => path.join(home, '.cache', n))].filter(Boolean);
  const ruleOf = new Map([[root, 'system'], [at('var'), 'data'], [at('var', 'cache'), 'caches'], [at('swapfile'), 'swap'],
    [path.join(home, '.cache'), 'caches'], [path.join(home, '.npm'), 'caches'], [path.join(home, '.claude'), 'agents'], [path.join(home, '.codex'), 'agents'],
    ...tmpDirs.map((t) => [t, 'temp']), ...[appRoot, dataDir].filter(Boolean).map((p) => [p, 'app'])]);

  // ---- running things at low priority ----
  let sudoOk = null, ionice = null;
  const hasSudo = async () => {
    if (!useSudo) return false;
    return sudoOk ??= !(await run('sudo', ['-n', 'true'], { timeout: 5000 })).error;
  };
  const low = async (cmd, args, { elevated = false, ...opts } = {}) => {
    ionice ??= fs.existsSync('/usr/bin/ionice');
    const sudo = elevated && await hasSudo();
    return run('nice', ['-n', '19', ...(ionice ? ['ionice', '-c3'] : []), ...(sudo ? ['sudo', '-n'] : []), cmd, ...args], opts);
  };
  // du's lines ('<bytes>\t<path>\0'): allocated bytes, like df; one file system; its exit code only says something was unreadable.
  const du = async (p, depth, threshold = 1) => {
    const r = await low('du', ['-0xaB1', `--max-depth=${depth}`, `--threshold=${threshold}`, '--', p], { elevated: true });
    const rows = [];
    for (const line of r.stdout.split('\0')) {
      const i = line.indexOf('\t');
      if (i > 0) rows.push({ path: line.slice(i + 1), bytes: Number(line.slice(0, i)) });
    }
    if (!rows.length) throw new Error(r.error?.killed ? 'Measuring took too long' : `Could not measure ${p}: ${r.stderr.split('\n')[0] || 'no output from du'}`);
    return rows;
  };
  const diskNow = () => {
    const f = fs.statfsSync(root);
    return { total: f.blocks * f.bsize, used: (f.blocks - f.bfree) * f.bsize, free: f.bavail * f.bsize };
  };
  // Newest change inside a folder, stopping at the first one after `since`. Too many entries to check counts as touched.
  async function touchedSince(p, since, budget = { left: 20000 }) {
    let st;
    try { st = await fs.promises.lstat(p); } catch { return false; }
    if (st.mtimeMs >= since) return true;
    if (!st.isDirectory()) return false;
    let names;
    try { names = await fs.promises.readdir(p); } catch { return false; }
    for (const name of names) {
      if (--budget.left < 0 || await touchedSince(path.join(p, name), since, budget)) return true;
    }
    return false;
  }

  // ---- who is using what ----
  let procCache = null;
  async function procs() {
    if (procCache && Date.now() - procCache.at < 5000) return procCache.list;
    const links = [];
    if (await hasSudo()) {
      const r = await run('sudo', ['-n', 'find', '/proc', '-mindepth', '2', '-maxdepth', '2', '(', '-name', 'cwd', '-o', '-name', 'exe', ')', '-printf', '%p\t%l\\0'], { timeout: 15000 });
      for (const line of r.stdout.split('\0')) {
        const m = line.match(/^\/proc\/(\d+)\/\w+\t(.+)$/);
        if (m) links.push([m[1], m[2]]);
      }
    } else {
      for (const pid of fs.existsSync('/proc') ? fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)) : []) {
        for (const l of ['cwd', 'exe']) { try { links.push([pid, fs.readlinkSync(`/proc/${pid}/${l}`)]); } catch {} }
      }
    }
    const list = links.map(([pid, target]) => ({ pid, target: target.replace(/ \(deleted\)$/, '') }));
    for (const pid of fs.existsSync('/proc') ? fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)) : []) {
      try { for (const a of fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')) if (a.startsWith('/')) list.push({ pid, target: a }); } catch {}
    }
    procCache = { at: Date.now(), list };
    return list;
  }
  const commOf = (pid) => { try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim().replace(/ \(.*$/, ''); } catch { return 'a program'; } };

  // ---- the gate ----
  async function whyNot(p) {
    const abs = path.resolve(String(p ?? ''));
    let real = realOr(abs);
    if (!real) { try { fs.lstatSync(abs); real = abs; } catch { return 'Not found'; } } // a broken link is still removable
    const roots = [home, ...tmpDirs].map((r) => realOr(r) || r), projs = projects().map((d) => realOr(d) || d);
    if (![...roots, ...projs].some((r) => under(real, r)) || roots.includes(real)) return 'Part of the system';
    if (real === (realOr(workspace) || workspace)) return 'Where your projects live';
    const holds = (k) => under(k, real) || under(real, k);
    if (keep.some((k) => holds(realOr(k) || k))) return worktrees.some((w) => holds(w)) ? 'Task worktrees: the orchestrator manages these' : 'Part of agent-orch';
    if (projs.some((d) => under(d, real))) return "A project folder: use Delete project on its chat, which also handles its repo and preview";
    if (cli.some((c) => under(real, realOr(c) || c) || under(c, real))) return 'Sign-ins, chat history and settings of your agents';
    const rel = path.relative(realOr(home) || home, real).split(path.sep), parts = real.split(path.sep);
    if (rel[0] !== '..' && rel[0].startsWith('.') && !['.cache', '.npm'].includes(rel[0])) return 'Installed tools and settings';
    if (parts.includes('.git')) return 'Version history';
    if (parts.includes('.agent-orch')) return "The project's notes for its agents";
    if (isSecret(abs, real) || /^\.env(\.(?!example$|sample$)|$)/.test(path.basename(real))) return 'Holds credentials';
    const parent = path.dirname(abs);
    try {
      fs.accessSync(parent, fs.constants.W_OK);
      const st = fs.lstatSync(abs), dir = fs.statSync(parent);
      if ((dir.mode & 0o1000) && st.uid !== process.getuid?.()) return 'Owned by another user';
    } catch { return 'Owned by another user'; }
    // A running app's folder is its project, but it still needs these at run time: they count as in use with it.
    const runtime = parts.findIndex((x) => RUNTIME.has(x)), busyIn = runtime > 0 ? parts.slice(0, runtime).join(path.sep) || path.sep : real;
    const hit = (await procs()).find((x) => under(x.target, busyIn));
    if (hit) return `In use by ${commOf(hit.pid)}`;
    return null;
  }

  // ---- the scan ----
  function tree(rows) {
    const nodes = new Map(rows.map((r) => [r.path, { ...r, kids: [] }]));
    for (const n of nodes.values()) if (n.path !== root) nodes.get(path.dirname(n.path))?.kids.push(n);
    return nodes;
  }
  const isOwnMount = (p) => { try { return fs.statSync(p).dev !== fs.statSync(root).dev; } catch { return false; } };
  // Each folder goes whole to the first category rule on the way down; a folder with a rule further down is split, and
  // what its listed children don't explain stays with it. Hidden things in the home dir are tools, the rest are projects.
  function bifurcate(nodes) {
    const bytes = Object.fromEntries(CATEGORIES.map(([id]) => [id, 0])), items = Object.fromEntries(CATEGORIES.map(([id]) => [id, []]));
    const rules = [...ruleOf.keys()];
    const ruleBelow = (p) => p === home || rules.some((k) => k !== p && under(k, p));
    const walk = (n, cat) => {
      const c = ruleOf.get(n.path) || (path.dirname(n.path) === home ? (path.basename(n.path).startsWith('.') ? 'tools' : 'projects') : cat);
      if (!ruleBelow(n.path)) { bytes[c] += n.bytes; items[c].push(n); return; }
      let rest = n.bytes;
      for (const k of n.kids) { rest -= k.bytes; walk(k, c); }
      if (rest > 0) bytes[c] += rest;
    };
    const top = nodes.get(root);
    if (top) walk(top, 'system');
    return { bytes, items };
  }
  // A category's list: its folders by size, opening any that alone is most of it (~/workspace → the projects inside).
  function itemsOf(list, total) {
    let out = [...list];
    for (let i = 0; i < 2; i++) {
      const big = out.reduce((a, b) => (b.bytes > (a?.bytes || 0) ? b : a), null);
      if (!big?.kids.length || big.bytes < total * 0.5) break;
      out = [...out.filter((x) => x !== big), ...big.kids];
    }
    return out.sort((a, b) => b.bytes - a.bytes);
  }
  async function rowOf(n) {
    let dir = n.kids?.length > 0;
    try { dir = fs.lstatSync(n.path).isDirectory(); } catch {}
    return { path: n.path, name: path.basename(n.path) || n.path, bytes: n.bytes, dir, why: await whyNot(n.path) };
  }
  async function findDeps(base, out, budget = { left: 200000 }) {
    let list;
    try { list = await fs.promises.readdir(base, { withFileTypes: true }); } catch { return out; }
    for (const e of list) {
      if (!e.isDirectory() || e.name.startsWith('.') || --budget.left < 0) continue;
      const p = path.join(base, e.name);
      if (e.name === 'node_modules') out.push(p);
      else if (!keep.includes(p)) await findDeps(p, out, budget);
    }
    return out;
  }
  async function depsItems() {
    const out = [], since = Date.now() - depsIdleDays * DAY, live = served().map((d) => realOr(d) || d);
    for (const p of await findDeps(home, [])) {
      const dir = path.dirname(p), lock = LOCKS.find(([f]) => fs.existsSync(path.join(dir, f)));
      if (!lock || live.some((d) => under(p, d) || under(d, p)) || await whyNot(p)) continue;
      const times = [dir, p, ...['package.json', lock[0], '.git/index', '.git/HEAD', 'node_modules/.package-lock.json'].map((f) => path.join(dir, f))]
        .map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } });
      const touched = Math.max(...times);
      if (touched >= since) continue;
      const bytes = (await du(p, 0).catch(() => [{ bytes: 0 }])).at(-1).bytes;
      if (bytes >= minItem) out.push({ path: p, label: path.relative(home, p), bytes, touched, restore: `${lock[1]} in ~/${path.relative(home, dir)}` });
    }
    return out;
  }
  // Transcripts Claude Code keeps per folder, for task worktrees that are gone. The encoded name is the folder's path with
  // every other character as '-', so a worktree still on disk is matched by encoding it.
  const encode = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
  async function transcriptDirs() {
    const base = path.join(home, '.claude', 'projects'), since = Date.now() - transcriptIdleDays * DAY, live = new Set();
    for (const w of worktrees) { try { for (const n of fs.readdirSync(w)) live.add(encode(path.join(w, n))); } catch {} }
    let names;
    try { names = fs.readdirSync(base); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!n.includes('-agent-orch-worktrees-') || [...live].some((l) => n === l || n.startsWith(l + '-'))) continue;
      const p = path.join(base, n);
      if (!await touchedSince(p, since)) out.push(p);
    }
    return out;
  }
  const sizeOfAll = async (paths) => {
    let total = 0;
    for (let i = 0; i < paths.length; i += 200) {
      const r = await low('du', ['-0sxcB1', '--', ...paths.slice(i, i + 200)]);
      const last = r.stdout.split('\0').filter(Boolean).at(-1);
      total += Number(last?.split('\t')[0]) || 0;
    }
    return total;
  };
  async function cleanups(nodes) {
    const groups = [];
    const old = async (list, days) => {
      const since = Date.now() - days * DAY, out = [];
      for (const n of list) {
        if (n.bytes < minItem || await whyNot(n.path) || (days && await touchedSince(n.path, since))) continue;
        let touched = 0;
        try { touched = fs.lstatSync(n.path).mtimeMs; } catch {}
        out.push({ path: n.path, label: n.path.startsWith(home) ? path.relative(home, n.path) : n.path, bytes: n.bytes, touched });
      }
      return out;
    };
    const kidsOf = (p) => nodes.get(p)?.kids || [];
    const caches = [
      ...await old(kidsOf(path.join(home, '.npm')).filter((n) => path.basename(n.path) === '_cacache'), 0),
      ...await old(kidsOf(path.join(home, '.cache')).filter((n) => !CACHE_KEEP.has(path.basename(n.path))), cacheIdleDays),
    ];
    if (caches.length) groups.push({ id: 'caches', title: 'Caches', why: 'Programs download or rebuild these the next time they need them, a little slower that one time.', items: caches });
    // A temp dir on its own mount (a tmpfs /tmp) isn't on this disk: it costs memory instead, so it's its own group and never counts as disk to win back.
    const onDisk = tmpDirs.filter((t) => !isOwnMount(t)), inRam = tmpDirs.filter(isOwnMount);
    const temp = await old(onDisk.flatMap(kidsOf), tempIdleDays);
    if (temp.length) groups.push({ id: 'temp', title: 'Old temporary files', why: `Nothing has changed in these for ${tempIdleDays} days. They don't come back: check any you may still want.`, items: temp });
    const ramKids = [];
    for (const t of inRam) ramKids.push(...tree(await du(t, 1, MB).catch(() => [])).get(t)?.kids || []);
    const ram = await old(ramKids, tempIdleDays);
    if (ram.length) groups.push({ id: 'ram', memory: true, title: 'Old temporary files in memory', why: `${inRam.join(', ')} lives in RAM here, so removing these frees memory, not disk. Nothing has changed in them for ${tempIdleDays} days, and they don't come back.`, items: ram });
    const deps = await depsItems();
    if (deps.length) groups.push({ id: 'deps', title: 'Dependencies of idle projects', why: `node_modules in projects untouched for ${depsIdleDays} days. Reinstall from the lockfile when you pick one up again.`, items: deps });
    const dirs = await transcriptDirs();
    if (dirs.length) {
      const bytes = await sizeOfAll(dirs);
      if (bytes >= minItem) groups.push({ id: 'transcripts', title: 'Transcripts of finished tasks', why: "Claude Code's session files for task worktrees that no longer exist. Each task's own log in agent-orch stays.",
        items: [{ clean: 'transcripts', label: `${dirs.length.toLocaleString('en-US')} finished ${dirs.length === 1 ? 'task' : 'tasks'}`, bytes }] });
    }
    if (await hasSudo()) {
      const sys = [], size = (p) => nodes.get(p)?.bytes || 0;
      const apt = size(at('var', 'cache', 'apt'));
      if (apt >= 50 * MB) sys.push({ clean: 'apt', label: 'Downloaded apt packages', bytes: apt });
      const journal = await low('du', ['-sB1', '/var/log/journal'], { elevated: true });
      const jb = parseInt(journal.stdout, 10) || 0;
      if (jb >= 100 * MB) sys.push({ clean: 'journal', label: 'System logs beyond the newest 50 MB', bytes: jb - 50 * MB });
      if (sys.length) groups.push({ id: 'system', title: 'System leftovers', why: 'Packages already installed and old log entries. Nothing depends on them.', items: sys });
    }
    for (const g of groups) { g.items.sort((a, b) => b.bytes - a.bytes); g.bytes = g.items.reduce((a, x) => a + x.bytes, 0); }
    return groups.sort((a, b) => b.bytes - a.bytes);
  }
  async function scan() {
    const t0 = Date.now(), depth = path.relative(root, home).split(path.sep).length + 3;
    const nodes = tree(await du(root, depth, MB));
    const { bytes, items } = bifurcate(nodes), disk = diskNow();
    const counted = Object.values(bytes).reduce((a, b) => a + b, 0);
    bytes.other = Math.max(0, disk.used - counted);
    const categories = [];
    for (const [id, label, hint] of CATEGORIES) {
      if (bytes[id] < (id === 'other' ? 50 * MB : MB)) continue;
      const list = itemsOf(items[id], bytes[id]);
      categories.push({ id, label, hint, bytes: bytes[id], items: await Promise.all(list.slice(0, 30).map(rowOf)), more: Math.max(0, list.length - 30) });
    }
    categories.sort((a, b) => (a.id === 'other') - (b.id === 'other') || b.bytes - a.bytes);
    const groups = await cleanups(nodes);
    return { at: Date.now(), ms: Date.now() - t0, disk, categories, cleanups: groups, reclaimable: groups.reduce((a, g) => a + (g.memory ? 0 : g.bytes), 0) };
  }
  let last = null, running = null;
  async function overview({ fresh = false } = {}) {
    if (running) return running;
    if (last && !fresh && Date.now() - last.at < 3600e3) return { ...last, disk: diskNow() };
    running = scan().then((r) => (last = r)).finally(() => { running = null; });
    return running;
  }
  const dirs = new Map();
  async function dir(p) {
    const abs = path.resolve(String(p || root));
    const hit = dirs.get(abs);
    if (hit && Date.now() - hit.at < 30e3) return hit.r;
    const rows = await du(abs, 1);
    const self = rows.find((r) => r.path === abs) || rows.at(-1);
    const kids = rows.filter((r) => r !== self).sort((a, b) => b.bytes - a.bytes);
    const r = { path: abs, bytes: self.bytes, entries: await Promise.all(kids.slice(0, 100).map(rowOf)), more: Math.max(0, kids.length - 100) };
    if (dirs.size > 50) dirs.clear();
    dirs.set(abs, { at: Date.now(), r });
    return r;
  }
  const changed = () => { last = null; dirs.clear(); procCache = null; };
  async function remove(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 200) { const e = new Error('Pick up to 200 items'); e.status = 400; throw e; }
    const before = diskNow().free, removed = [], skipped = [];
    for (const raw of paths) {
      const p = path.resolve(String(raw ?? '')), why = String(raw ?? '').startsWith('/') ? await whyNot(p) : 'Not an absolute path';
      if (why) { skipped.push({ path: p, reason: why }); continue; }
      const bytes = (await du(p, 0).catch(() => [{ bytes: 0 }])).at(-1).bytes;
      try { await fs.promises.rm(p, { recursive: true, force: false }); removed.push({ path: p, bytes }); }
      catch (e) { skipped.push({ path: p, reason: e.code === 'EACCES' || e.code === 'EPERM' ? 'Permission denied for part of it' : 'Could not remove it' }); }
      procCache = null;
    }
    changed();
    const disk = diskNow();
    return { removed, skipped, freed: Math.max(0, disk.free - before), disk };
  }
  async function clean(id) {
    const before = diskNow().free, removed = [], skipped = [];
    if (id === 'transcripts') {
      for (const p of await transcriptDirs()) {
        try { await fs.promises.rm(p, { recursive: true, force: false }); removed.push({ path: p, bytes: 0 }); }
        catch { skipped.push({ path: p, reason: 'Could not remove it' }); }
      }
    } else if (id === 'apt' || id === 'journal') {
      if (!await hasSudo()) { const e = new Error('That needs passwordless sudo on this machine'); e.status = 409; throw e; }
      const r = await run('sudo', ['-n', ...(id === 'apt' ? ['apt-get', 'clean'] : ['journalctl', '--vacuum-size=50M'])], { timeout: 120e3 });
      if (r.error) skipped.push({ path: id, reason: r.stderr.split('\n')[0] || 'The command failed' });
      else removed.push({ path: id, bytes: 0 });
    } else { const e = new Error('Unknown cleanup'); e.status = 404; throw e; }
    changed();
    const disk = diskNow();
    return { removed, skipped, freed: Math.max(0, disk.free - before), disk };
  }
  return { overview, dir, remove, clean, whyNot };
}
