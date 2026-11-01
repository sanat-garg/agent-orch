// Deploy API (owner, 2026-11-01): a Claude (or anything) on another machine ships code to this server and gets a live https
// site back. It only drives what the head already has: projects (a folder + chat + private GitHub repo), previews.mjs
// (address, Caddy, certificate, process) and the commit that follows. server.mjs passes that in as `ops`.
//   POST /mcp                       MCP (streamable HTTP, stateless, JSON answers only): the TOOLS below. Bearer token.
//   GET  /api/deploy/tools          the same tools for plain HTTP; POST /api/deploy/tools/<name> {args} runs one. Bearer token.
//   PUT|POST /api/deploy/upload/<ticket>  a .tar.gz body; the ticket comes from prepare_upload (one use, 15 min), so the token
//                                   never lands in a command line. …/upload?name=&address=&start_command=&replace_existing=1
//                                   does the same with a bearer token (CI). Answers with the deploy's result.
// Tokens are made in Live previews (signed-in admin only: /api/deploy/tokens in server.mjs), kept hashed, and revocable. A token
// can run code as this server's user (that's what deploying is), so treat it like an SSH key.
// A snapshot (upload, deploy_files) lands in the project's main tree as a commit, under the orchestrator's git lock:
//   - the snapshot's own .gitignore applies, and SKIP (.git, node_modules, .env*, agent-orch's notes…) never comes across;
//   - with `mirror`, files git tracks that the snapshot no longer has are deleted. Ignored and untracked files (a database,
//     uploads, .env, node_modules) are never touched, and old versions stay in git history;
//   - replacing a project that deploys didn't create needs replace_existing, so a name clash can't overwrite a chat's work;
//   - agent-orch's own folder can never be a target (ops.find leaves it out).
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { bearerToken, hashSecret, secretMatches } from './cluster-protocol.mjs';
import { APEX, normalizeSlug, parseEnv } from './previews.mjs';

const execFileP = promisify(execFile);
export const UPLOAD_MAX = 1024 ** 3, UNPACKED_MAX = 4 * 1024 ** 3, JSON_MAX = 64 * 1024 * 1024;
export const TICKET_MS = 15 * 60e3;
const WAIT_MS = 170e3, CERT_WAIT_MS = 60e3, LOG_TAIL = 40;
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const TAR_EXCLUDES = ['.git', 'node_modules', '.env', '.env.*', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.DS_Store', '.agent-orch'];
const SKIP = /(^|\/)(\.git|node_modules|\.venv|__pycache__|\.DS_Store)(\/|$)|^\.agent-orch(\/|$)|(^|\/)\.env(?!\.example$)(\.[^/]*)?$/;
const KEEP = /^\.agent-orch\/|^\.gitignore$|(^|\/)\.env(\.[^/]*)?$/; // tracked files a mirror never deletes
const IGNORES = ['.env', '.env.*', '!.env.example', 'node_modules/', '.venv/', '__pycache__/'];

class ToolError extends Error {}

// ---------- tokens ----------
export function createDeployTokens(file) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(list, null, 2), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
  const shown = ({ hash, ...t }) => t;
  return {
    list: () => list.map(shown),
    create(name) {
      const token = `aod_${crypto.randomBytes(32).toString('base64url')}`;
      const t = { id: crypto.randomBytes(6).toString('hex'), name: String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'My computer', hash: hashSecret(token), createdAt: Date.now(), lastUsedAt: null };
      list.push(t);
      save();
      return { token, ...shown(t) };
    },
    revoke(id) { const n = list.length; list = list.filter((t) => t.id !== id); if (list.length !== n) save(); return list.length !== n; },
    verify(token) {
      const t = list.find((x) => secretMatches(token, x.hash));
      if (t && Date.now() - (t.lastUsedAt || 0) > 60e3) { t.lastUsedAt = Date.now(); save(); }
      return t || null;
    },
  };
}

// ---------- snapshots ----------
const git = (cwd, args) => execFileP('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, timeout: 120e3 }).then((r) => r.stdout);
const nulList = (s) => s.split('\0').filter(Boolean);
const inside = (p, root) => p === root || p.startsWith(root + path.sep);

// A folder's files by its own .gitignore, relative paths.
async function snapshotFiles(src) {
  fs.rmSync(path.join(src, '.git'), { recursive: true, force: true }); // ours below, never one that came with the code
  await git(src, ['init', '-q']);
  return nulList(await git(src, ['ls-files', '-coz', '--exclude-standard']));
}

// src's files into the project `dir` (rules at the top of this file). → {written, deleted, skipped}
export async function applySnapshot(src, dir, { mirror = false } = {}) {
  const all = await snapshotFiles(src), files = [], skipped = [];
  for (const f of all) (f.endsWith('/') || SKIP.test(f) ? skipped : files).push(f.replace(/\/$/, ''));
  const incoming = new Set(files);
  let deleted = 0;
  if (mirror && fs.existsSync(path.join(dir, '.git'))) {
    for (const f of nulList(await git(dir, ['ls-files', '-z']))) {
      if (incoming.has(f) || KEEP.test(f)) continue;
      const at = path.join(dir, f);
      fs.rmSync(at, { force: true });
      deleted++;
      for (let up = path.dirname(at); up !== dir; up = path.dirname(up)) { try { fs.rmdirSync(up); } catch { break; } }
    }
  }
  const root = fs.realpathSync(dir);
  for (const f of files) {
    const from = path.join(src, f), to = path.join(dir, f), st = fs.lstatSync(from);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (!inside(fs.realpathSync(path.dirname(to)), root)) { skipped.push(f); continue; } // a link in the project that leads out of it
    const had = fs.lstatSync(to, { throwIfNoEntry: false });
    if (had?.isDirectory()) throw new ToolError(`${f} is a file in this deploy but a folder on the server (with files git ignores). Remove that folder first.`);
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(from);
      if (path.isAbsolute(target) || !inside(path.resolve(path.dirname(to), target), path.resolve(dir))) { skipped.push(f); continue; }
      if (had) fs.rmSync(to, { force: true });
      fs.symlinkSync(target, to);
    } else if (st.isFile()) {
      if (had?.isSymbolicLink()) fs.rmSync(to, { force: true });
      fs.copyFileSync(from, to);
      fs.chmodSync(to, st.mode & 0o777);
    } else skipped.push(f);
  }
  ensureIgnores(dir);
  return { written: files.length - skipped.filter((f) => incoming.has(f)).length, deleted, skipped };
}

// The rules no deployed project goes without, so a project's own .gitignore can't get its secrets or dependencies committed.
export function ensureIgnores(dir) {
  const gi = path.join(dir, '.gitignore');
  let cur = '';
  try { cur = fs.readFileSync(gi, 'utf8'); } catch {}
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const add = IGNORES.filter((l) => !have.has(l));
  if (add.length) fs.writeFileSync(gi, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
}

// Secrets into the project's .env (mode 600): set keeps other lines in place, unset removes keys. → the keys now there.
export function mergeEnv(dir, set = {}, unset = []) {
  const file = path.join(dir, '.env');
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch {}
  while (lines.length && !lines.at(-1)) lines.pop();
  const keyOf = (l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1];
  const quote = (v) => (/^[\w@%+=:,./-]*$/.test(v) ? v : JSON.stringify(v));
  const pending = new Map(Object.entries(set).map(([k, v]) => [k, `${k}=${quote(String(v))}`]));
  lines = lines.filter((l) => !unset.includes(keyOf(l))).map((l) => {
    const k = keyOf(l);
    if (!pending.has(k)) return l;
    const next = pending.get(k);
    pending.delete(k);
    return next;
  });
  fs.writeFileSync(file, [...lines, ...pending.values()].join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  ensureIgnores(dir);
  return Object.keys(parseEnv(fs.readFileSync(file, 'utf8')));
}

// Inline files (deploy_files) into the temp folder `into`.
export function writeInlineFiles(files, into) {
  if (!Array.isArray(files) || !files.length) throw new ToolError('files must be a non-empty list of {path, content}.');
  for (const f of files) {
    const rel = String(f?.path || '').replace(/^\.\//, '');
    if (!rel || path.isAbsolute(rel) || rel.includes('\0') || rel.split('/').some((s) => s === '..' || s === '')) throw new ToolError(`Bad file path: ${f?.path}`);
    if (typeof f.content !== 'string') throw new ToolError(`${rel}: content must be a string.`);
    const at = path.join(into, rel);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : f.content);
  }
}

// A .tar.gz into `into`; its unpacked size is counted first, so an archive bomb stops before anything lands on disk.
export async function unpack(file, into) {
  let n = 0;
  const count = new Transform({ transform(c, _, cb) { n += c.length; cb(n > UNPACKED_MAX ? new ToolError('This archive unpacks to more than 4 GB.') : null); } });
  try { await pipeline(fs.createReadStream(file), zlib.createGunzip(), count); } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError('The upload is not a gzipped tar (expected `tar -czf - …`).');
  }
  try { await execFileP('tar', ['-xzf', file, '-C', into, '--no-same-owner', '--no-same-permissions'], { timeout: 300e3, maxBuffer: 16 * 1024 * 1024 }); }
  catch (e) { throw new ToolError(`Could not unpack the archive: ${String(e.stderr || e.message).trim().split('\n')[0]}`); }
}

// ---------- the API ----------
const ADDRESS = { type: 'string', description: 'Public address: a subdomain like "shop", or a full one on one of the server\'s domains like "shop.example.com" or "example.com". Leave out to keep the current address, or for a new project to use its name on the default domain.' };
const START = { type: 'string', description: 'Shell command that starts the app and listens on $PORT, for anything that isn\'t detected automatically (e.g. "gunicorn app:app -b 127.0.0.1:$PORT"). Saved for later deploys; "" clears it. A requirements.txt gets a .venv and pip install first. Detected without this: index.html, package.json with a start or build script, index.php.' };
const NAME = { type: 'string', description: 'Project name (its folder on the server). A new name creates the project.' };
const REPLACE = { type: 'boolean', description: 'Allow writing over a project that was not created through this API. Only set it when the user means that project.' };
const MESSAGE = { type: 'string', description: 'One line saying what changed; becomes the commit message.' };
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const RO = { readOnlyHint: true }, WRITE = { readOnlyHint: false, destructiveHint: false }, DESTROY = { readOnlyHint: false, destructiveHint: true };
export const INSTRUCTIONS = 'Deploys code to the user\'s own server and returns a live https site. To ship a project folder: call prepare_upload, run the command it returns from the project\'s root, and read the JSON it prints. Use deploy_files for a few files or small edits, and deploy_from_github when the code is already on GitHub. Web apps must listen on process.env.PORT and read their public address from PREVIEW_URL. Results carry the url, a status (running | building | waiting | error) and, when something went wrong, the log tail: fix the code and deploy again. Secrets go through set_env, never in deployed files.';

export function createDeployApi({ dataDir, previews, ops, log = () => {} }) {
  const tokens = createDeployTokens(path.join(dataDir, 'deploy-tokens.json'));
  const tmpRoot = path.join(dataDir, 'deploy-tmp');
  fs.rmSync(tmpRoot, { recursive: true, force: true }); // whatever a restart cut short
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tickets = new Map(), chains = new Map();
  // One deploy per project at a time.
  const serial = (key, job) => {
    const p = (chains.get(key) || Promise.resolve()).catch(() => {}).then(job);
    chains.set(key, p);
    p.finally(() => chains.get(key) === p && chains.delete(key)).catch(() => {});
    return p;
  };
  const keyOf = (name) => {
    const key = normalizeSlug(name);
    if (!key) throw new ToolError('Give the project a name (letters, digits and hyphens).');
    return key;
  };
  const project = (name) => {
    const dir = ops.find(keyOf(name));
    if (!dir) throw new ToolError(`No project named "${name}". list_projects shows them.`);
    return dir;
  };
  const live = (name) => {
    const dir = project(name);
    if (!previews.view(dir)) throw new ToolError(`"${name}" has no live site yet.`);
    return dir;
  };
  // "shop", "shop.example.com" or "example.com" → [slug, domain] (domain null = the default).
  function parseAddress(address) {
    const a = String(address).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const domains = previews.domains().map((d) => d.domain);
    if (domains.includes(a)) return [APEX, a];
    const d = domains.find((x) => a.endsWith(`.${x}`));
    if (d) return [a.slice(0, -d.length - 1), d];
    if (a.includes('.')) throw new ToolError(`${a} isn't on this server's domains (${domains.join(', ')}). The owner adds domains under Live previews.`);
    return [a, null];
  }
  const tail = (dir) => (previews.logs(dir) || '').trimEnd().split('\n').slice(-LOG_TAIL).join('\n');
  const report = (dir, extra = {}) => {
    const v = previews.view(dir);
    return { project: path.basename(dir), ...(v ? { url: v.url, status: v.status, kind: v.kind, start_command: v.start, certificate: v.cert, ...(v.error && { error: v.error }) } : { status: 'offline' }), ...extra };
  };
  // Give the project its address and get the commit running, then answer once it's up, failed or has taken too long.
  async function publish(dir, name, { address, start_command: start } = {}, extra = {}) {
    const cur = previews.view(dir);
    let deploying = false;
    const want = address != null && String(address).trim() ? parseAddress(address) : null;
    if (cur && start !== undefined) previews.setStart(dir, String(start).trim());
    if (!cur) {
      const r = want ? await previews.set(dir, want[0], want[1], { start: start ? String(start).trim() : undefined }) : await ops.autoAddress(dir, name, { start: start ? String(start).trim() : undefined });
      if (r.error) throw new ToolError(r.error);
      deploying = true;
    } else if (want && (![cur.slug, normalizeSlug(cur.slug)].includes(want[0] === APEX ? APEX : normalizeSlug(want[0])) || (want[1] && want[1] !== cur.domain))) {
      const r = await previews.set(dir, want[0], want[1] || cur.domain);
      if (r.error) throw new ToolError(r.error);
      if (r.moved) extra = { ...extra, moved_from: r.moved.from };
      deploying = true;
    }
    const done = deploying ? previews.settled(dir) : previews.deployNow(dir);
    const timedOut = await Promise.race([Promise.resolve(done).then(() => false), new Promise((r) => { const t = setTimeout(() => r(true), WAIT_MS); t.unref?.(); })]);
    for (const end = Date.now() + CERT_WAIT_MS; !timedOut && previews.view(dir)?.status === 'running' && previews.view(dir)?.cert === 'pending' && Date.now() < end;) await new Promise((r) => setTimeout(r, 1000));
    const r = report(dir, extra);
    r.ok = r.status === 'running' || r.status === 'building';
    if (r.status !== 'running') r.logs = tail(dir);
    if (r.status === 'building') r.next = 'Still building: check project_status in a minute.';
    if (r.status === 'waiting') r.next = 'Nothing to run was found. Add an index.html or a package.json start script, or pass start_command.';
    return r;
  }
  // A snapshot in `tree` becomes the project's code and goes live. Runs in the project's turn.
  const shipTree = (args, who, tree, mirror) => {
    const key = keyOf(args.name);
    return serial(key, async () => {
      let dir = ops.find(key);
      if (dir && !ops.isDeployed(dir) && !args.replace_existing) throw new ToolError(`A project named "${key}" already exists and wasn't created by a deploy. Use another name, or pass replace_existing if the user wants this code to replace it (its old versions stay in git).`);
      if (dir && ops.busy(dir)) throw new ToolError(`A chat in "${key}" is replying right now and may be editing these files. Try again in a minute.`);
      dir ||= await ops.create(key);
      const files = await ops.lock(dir, () => applySnapshot(tree, dir, { mirror }));
      ops.markDeployed(dir, key);
      const commit = await ops.commit(dir, `Deploy from ${who}: ${String(args.message || `${files.written} file${files.written === 1 ? '' : 's'}`).replace(/\s+/g, ' ').slice(0, 200)}`);
      const r = await publish(dir, key, args, { commit: commit ? commit.slice(0, 8) : 'no change', files: { written: files.written, deleted: files.deleted, ...(files.skipped.length && { skipped: files.skipped.slice(0, 30) }) } });
      ops.notify(dir, r.status === 'error' ? `A deploy from ${who} failed: ${r.error}` : `Deployed from ${who}: ${r.url}`);
      return r;
    });
  };
  const withTmp = async (job) => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'job-'));
    try { return await job(tmp); } finally { fs.rm(tmp, { recursive: true, force: true }, () => {}); }
  };

  const TOOLS = {
    list_projects: {
      description: 'List the projects on the server with their live address and status, plus the domains new addresses can use.',
      inputSchema: obj({}), annotations: RO,
      run: () => ({ domains: previews.domains().map((d) => d.domain), projects: ops.list().map((dir) => report(dir)) }),
    },
    prepare_upload: {
      description: 'Start deploying a whole project folder (the normal way). Returns a shell command: run it from the project\'s root on this machine. It uploads the folder (skipping .git, node_modules, .env and whatever .gitignore lists), then replaces the project\'s code, builds, starts it and prints the result as JSON, including the live url and any error logs. Files removed locally are removed on the server too; data the app keeps in ignored files stays. A build can take minutes. The command works once and for 15 minutes.',
      inputSchema: obj({ name: NAME, address: ADDRESS, start_command: START, replace_existing: REPLACE, message: MESSAGE }, ['name']), annotations: WRITE,
      run(args, ctx) {
        const key = keyOf(args.name);
        if (args.address != null && String(args.address).trim()) parseAddress(args.address);
        const ticket = crypto.randomBytes(24).toString('hex');
        tickets.set(ticket, { args: { ...args, name: key }, who: ctx.who, until: Date.now() + TICKET_MS });
        for (const [t, v] of tickets) if (v.until < Date.now()) tickets.delete(t);
        const excl = TAR_EXCLUDES.map((x) => `--exclude='${x}'`).join(' ');
        return { project: key, command: `COPYFILE_DISABLE=1 tar -czf - ${excl} . | curl -sS -T - -H 'Content-Type: application/gzip' '${ctx.base}/api/deploy/upload/${ticket}'`, expires_in_seconds: TICKET_MS / 1000 };
      },
    },
    deploy_files: {
      description: 'Deploy by sending files directly: for small sites and quick edits, or when you can\'t run a shell command. By default only these files change and the rest of the project stays; replace_all makes them the whole project. Then it builds, starts and answers with the live url and status. Use prepare_upload for whole projects.',
      inputSchema: obj({
        name: NAME,
        files: { type: 'array', description: 'The files.', items: obj({ path: { type: 'string', description: 'Relative path, e.g. "src/app.js".' }, content: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'base64 for binary files; default utf8.' } }, ['path', 'content']) },
        replace_all: { type: 'boolean', description: 'Delete tracked files that aren\'t in this list.' },
        address: ADDRESS, start_command: START, replace_existing: REPLACE, message: MESSAGE,
      }, ['name', 'files']), annotations: WRITE,
      run: (args, ctx) => withTmp(async (tmp) => { writeInlineFiles(args.files, tmp); return shipTree(args, ctx.who, tmp, !!args.replace_all); }),
    },
    deploy_from_github: {
      description: 'Deploy a GitHub repository the server\'s GitHub account can read. The first time it clones it as a new project; after that it pulls the latest commits and redeploys, so "git push, then call this" ships an update. Then it builds, starts and answers with the live url and status.',
      inputSchema: obj({ repo: { type: 'string', description: 'owner/name or the repo\'s URL.' }, name: { type: 'string', description: 'Project name for a first deploy; defaults to the repo\'s name.' }, address: ADDRESS, start_command: START }, ['repo']), annotations: WRITE,
      async run(args, ctx) {
        const repoName = String(args.repo).replace(/\.git$/, '').split(/[/:]/).pop();
        const key = keyOf(args.name || repoName);
        return serial(key, async () => {
          let dir = ops.findRepo(args.repo), extra = {};
          if (dir) {
            if (ops.busy(dir)) throw new ToolError(`A chat in "${path.basename(dir)}" is replying right now. Try again in a minute.`);
            const r = await ops.lock(dir, () => ops.pull(dir));
            if (!r.ok) throw new ToolError(`Could not pull from GitHub: ${r.error || 'unknown error'}`);
            extra = { pulled_commits: r.pulled || 0 };
          } else {
            if (ops.find(key)) throw new ToolError(`A project named "${key}" already exists with different code. Pass another name.`);
            dir = await ops.clone(args.repo, key);
          }
          ops.markDeployed(dir, key);
          const r = await publish(dir, key, args, extra);
          ops.notify(dir, r.status === 'error' ? `A deploy from ${ctx.who} failed: ${r.error}` : `Deployed from ${ctx.who} (GitHub): ${r.url}`);
          return r;
        });
      },
    },
    project_status: {
      description: 'One project\'s live address, status, last error and certificate.',
      inputSchema: obj({ name: NAME }, ['name']), annotations: RO,
      run: (args) => report(project(args.name)),
    },
    project_logs: {
      description: 'The newest lines of a project\'s build and app log, up to 200 by default. Use it to see why a deploy failed or what the running app prints.',
      inputSchema: obj({ name: NAME, lines: { type: 'integer', minimum: 1, maximum: 200 } }, ['name']), annotations: RO,
      run(args) {
        const n = Math.min(200, Math.max(1, Number(args.lines) || 200));
        return { project: args.name, logs: (previews.logs(live(args.name)) || '').trimEnd().split('\n').slice(-n).join('\n') };
      },
    },
    restart_project: {
      description: 'Rebuild and restart a project from its current code, and wait for the result.',
      inputSchema: obj({ name: NAME }, ['name']), annotations: WRITE,
      run: (args) => { const dir = live(args.name); return serial(keyOf(args.name), () => publish(dir, keyOf(args.name))); },
    },
    set_env: {
      description: 'Set or remove a project\'s environment variables (API keys, database URLs). They go in its .env on the server, never in git, and reach its build and app; the app restarts unless restart is false. Values are not shown back.',
      inputSchema: obj({ name: NAME, set: { type: 'object', description: 'KEY: value pairs.', additionalProperties: { type: 'string' } }, unset: { type: 'array', items: { type: 'string' }, description: 'Keys to remove.' }, restart: { type: 'boolean' } }, ['name']), annotations: WRITE,
      run(args) {
        const dir = project(args.name), set = args.set || {}, unset = args.unset || [];
        for (const k of [...Object.keys(set), ...unset]) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new ToolError(`Bad variable name: ${k}`);
          if (['PORT', 'PREVIEW_URL', 'AGENT_ORCH_PREVIEW'].includes(k)) throw new ToolError(`${k} is set by the server.`);
        }
        return serial(keyOf(args.name), async () => {
          const keys = mergeEnv(dir, set, unset);
          await ops.commit(dir, ''); // pushes nothing new, but files the keys under the owner's Credentials
          if (args.restart === false || !previews.view(dir)) return { project: path.basename(dir), keys, restarted: false };
          return { ...(await publish(dir, keyOf(args.name))), keys, restarted: true };
        });
      },
    },
    set_address: {
      description: 'Move a project to a new public address, or give it its first. A move handles everything: DNS is already wildcarded, the certificate is issued, the old address keeps working (visitors are redirected), and the project\'s own files follow.',
      inputSchema: obj({ name: NAME, address: { ...ADDRESS, description: 'The new address: "shop", "shop.example.com" or "example.com".' } }, ['name', 'address']), annotations: WRITE,
      run: (args) => { const dir = project(args.name); return serial(keyOf(args.name), () => publish(dir, keyOf(args.name), { address: args.address })); },
    },
    take_offline: {
      description: 'Stop a project\'s site and free its address. Its code, data and chat stay on the server, and deploying again brings it back.',
      inputSchema: obj({ name: NAME }, ['name']), annotations: DESTROY,
      run: (args) => { const dir = live(args.name); return serial(keyOf(args.name), async () => { await previews.remove(dir); return { project: path.basename(dir), status: 'offline' }; }); },
    },
  };

  async function callTool(name, args, ctx) {
    const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
    if (!tool) throw new ToolError(`Unknown tool: ${name}`);
    return tool.run(args || {}, ctx);
  }
  const toolList = () => Object.entries(TOOLS).map(([name, { description, inputSchema, annotations }]) => ({ name, description, inputSchema, annotations }));

  // ---------- transport ----------
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  async function readJson(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) { // an oversize body is read to its end, so the answer can still go out
      n += c.length;
      if (n <= JSON_MAX) chunks.push(c);
    }
    if (n > JSON_MAX) throw new ToolError('Too much for one request (64 MB). Use prepare_upload.');
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  }
  const baseOf = (req) => `${String(req.headers['x-forwarded-proto'] || 'http').split(',')[0]}://${req.headers.host}`;
  const failText = (e) => {
    if (!(e instanceof ToolError)) log(`failed: ${e.stack || e.message}`);
    return e.message || 'Something went wrong';
  };

  async function mcpOne(m, ctx) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    if (m.id === undefined) return null; // a notification
    const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize': {
        const asked = m.params?.protocolVersion;
        return ok({ protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name: 'agent-orch', version: '1.0.0' }, instructions: INSTRUCTIONS });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: toolList() });
      case 'tools/call': {
        const name = m.params?.name;
        if (!Object.hasOwn(TOOLS, name)) return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        try {
          const r = await callTool(name, m.params.arguments, ctx);
          return ok({ content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: r?.ok === false });
        } catch (e) { return ok({ content: [{ type: 'text', text: failText(e) }], isError: true }); }
      }
      default: return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `No such method: ${m.method}` } };
    }
  }
  async function upload(req, res, args, who) {
    try {
      const r = await withTmp(async (tmp) => {
        const file = path.join(tmp, 'upload.tgz'), tree = path.join(tmp, 'tree');
        let n = 0;
        const cap = new Transform({ transform(c, _, cb) { n += c.length; cb(null, n > UPLOAD_MAX ? undefined : c); } }); // the rest is read and dropped, so the answer can still go out
        await pipeline(req, cap, fs.createWriteStream(file));
        if (n > UPLOAD_MAX) throw new ToolError('The upload is over 1 GB.');
        fs.mkdirSync(tree);
        await unpack(file, tree);
        return shipTree(args, who, tree, true);
      });
      send(res, r.ok === false ? 422 : 200, r);
    } catch (e) {
      if (!res.headersSent) { res.setHeader('Connection', 'close'); send(res, e instanceof ToolError ? 400 : 500, { ok: false, error: failText(e) }); req.resume(); }
    }
  }

  // → true when this was a deploy request (answered here, with no session involved).
  function handle(req, res, url) {
    const p = url.pathname;
    const ticketPath = p.match(/^\/api\/deploy\/upload\/([a-f0-9]{48})$/);
    if (ticketPath && (req.method === 'PUT' || req.method === 'POST')) {
      const t = tickets.get(ticketPath[1]);
      tickets.delete(ticketPath[1]);
      if (!t || t.until < Date.now()) { req.resume(); send(res, 410, { ok: false, error: 'This upload command has expired or was already used. Call prepare_upload again.' }); return true; }
      upload(req, res, t.args, t.who);
      return true;
    }
    const tool = p.match(/^\/api\/deploy\/tools(?:\/([\w-]+))?$/);
    if (p !== '/mcp' && p !== '/api/deploy/upload' && !tool) return false;
    const who = tokens.verify(bearerToken(req.headers));
    if (!who) { req.resume(); send(res, 401, { error: 'A deploy token is required: Authorization: Bearer <token>. Make one under Live previews.' }, { 'WWW-Authenticate': 'Bearer' }); return true; }
    const ctx = { who: who.name, base: baseOf(req) };
    if (p === '/api/deploy/upload') {
      if (req.method !== 'PUT' && req.method !== 'POST') { req.resume(); send(res, 405, { error: 'PUT a .tar.gz' }); return true; }
      const q = url.searchParams;
      const args = { name: q.get('name'), ...(q.has('address') && { address: q.get('address') }), ...(q.has('start_command') && { start_command: q.get('start_command') }), ...(q.has('message') && { message: q.get('message') }), replace_existing: q.get('replace_existing') === '1' };
      upload(req, res, args, who.name);
      return true;
    }
    if (tool) {
      if (!tool[1]) { req.resume(); if (req.method === 'GET') send(res, 200, { tools: toolList(), instructions: INSTRUCTIONS }); else send(res, 405, { error: 'GET' }); return true; }
      if (req.method !== 'POST') { req.resume(); send(res, 405, { error: 'POST {args}' }); return true; }
      readJson(req).then((args) => callTool(tool[1], args, ctx)).then((r) => send(res, r?.ok === false ? 422 : 200, r), (e) => send(res, e instanceof ToolError ? 400 : e instanceof SyntaxError ? 400 : 500, { ok: false, error: failText(e) }));
      return true;
    }
    if (req.method !== 'POST') { req.resume(); send(res, 405, { error: 'This MCP server answers POST only.' }, { Allow: 'POST' }); return true; }
    readJson(req).then(async (body) => {
      const replies = (await Promise.all((Array.isArray(body) ? body : [body]).map((m) => mcpOne(m, ctx)))).filter(Boolean);
      if (!replies.length) { res.writeHead(202); return res.end(); }
      send(res, 200, Array.isArray(body) ? replies : replies[0]);
    }).catch((e) => send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: e instanceof SyntaxError ? 'Parse error' : failText(e) } }));
    return true;
  }

  return { handle, tokens, callTool, toolList };
}
