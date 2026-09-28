// Skills, MCP servers, subagents and personas the owner adds from the UI (Settings → Skills & tools).
// Skills and subagents live where the CLIs discover them, so every Claude/Codex session on this machine (chats, tasks,
// the web terminal) sees them and ones installed by hand show up too:
//   skills    ~/.claude/skills/<name>/SKILL.md (Claude) and ~/.codex/skills/<name>/SKILL.md (Codex), plus any other files
//   subagents ~/.claude/agents/<name>.md (Claude only; Codex has no file-defined subagents)
// MCP servers and personas are agent-orch's own (<DATA>/extensions/, 0600). MCP servers are handed to every run agent-orch
// starts, through 0600 files so env values and headers never sit on a command line (`ps`): Claude gets
// `--mcp-config <DATA>/extensions/claude-mcp.json`, codex `-p agent-orch` (~/.codex/agent-orch.config.toml, a profile
// layered on the owner's config.toml). The terminal's own CLI sessions don't load them. A persona is a named set of instructions a chat picks, appended to its system prompt and to the
// system prompt of its project's planner and task runs.
// A server's `outbound` tools are held for the owner in task runs (gate.mjs): a stdio or http server runs behind
// gate-proxy.mjs, but the proxy doesn't speak sse, so a gated run leaves out an sse server with outbound tools
// (mcpFor's run.onWithheld hears why).
// Cluster workers get the same skills, subagents and enabled MCP servers: syncBundle() here, applyBundle() on the worker.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { runHelper } from './helpers.mjs';
import { fileURLToPath } from 'node:url';
import { EXT_ENTRY_RE, EXT_MAX_BYTES, extBundleError, extHash } from './cluster-protocol.mjs';
import { MCP_SERVER as BROWSER_MCP, browserServer } from './browser.mjs';

const GATE_PROXY = fileURLToPath(new URL('./gate-proxy.mjs', import.meta.url));
export const WITHHELD_REASON = 'connector with outbound tools over sse cannot be gated; add it as http or a stdio command';

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/; // new skills and subagents (Claude's skill-name rule)
export const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/; // a bare TOML key for codex, and part of Claude's mcp__<name>__<tool>
const SEG_RE = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/; // an existing entry's folder/file name (installed by hand)
export const SECRET = '••••••'; // env/header values as the API shows them; saving it back keeps the stored value
const SKILL_AGENTS = ['claude', 'codex'], MCP_TYPES = ['stdio', 'http', 'sse'];
const MAX_SKILL_BYTES = 20 << 20, MAX_SKILL_FILES = 1000, MAX_TEXT = 200_000;

// ---------- frontmatter (the subset SKILL.md and agent files use: key: value, quoted, and > / | block scalars)
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text || ''));
  if (!m) return { meta: {}, body: String(text || '') };
  const meta = {}, lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) { // block scalar: the indented lines after it (> folds them into one line)
      const block = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim());
      while (block.length && !block.at(-1)) block.pop();
      v = v[0] === '>' ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n');
    } else if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } }
    else if (v.startsWith("'")) v = v.slice(1, v.endsWith("'") ? -1 : undefined).replace(/''/g, "'");
    else v = v.replace(/\s+#.*$/, '');
    meta[kv[1]] = v;
  }
  return { meta, body: String(text).slice(m[0].length).replace(/^\s*\n/, '') };
}
// A plain YAML scalar when it is safe to leave unquoted, else a double-quoted one (JSON's escapes are valid YAML).
const yamlStr = (s) => (/^[A-Za-z0-9(][^\n:#"'`{}[\]]*$/.test(s) && !/\s$/.test(s) ? s : JSON.stringify(s));
export function frontmatter(meta, body) {
  const head = Object.entries(meta).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${yamlStr(String(v))}`);
  return `---\n${head.join('\n')}\n---\n\n${String(body || '').trim()}\n`;
}

// "npx -y @scope/pkg --flag 'a b'" → ['npx', '-y', '@scope/pkg', '--flag', 'a b'] (single/double quotes, backslash escapes).
export function splitCommand(s) {
  const out = [];
  let cur = '', quote = null, any = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { quote = c; any = true; }
    else if (c === '\\' && i + 1 < s.length) { cur += s[++i]; any = true; }
    else if (/\s/.test(c)) { if (cur || any) out.push(cur); cur = ''; any = false; }
    else cur += c;
  }
  if (quote) throw new Error('Unclosed quote in the command');
  if (cur || any) out.push(cur);
  return out;
}
export const joinCommand = (parts) => parts.map((p) => (p && /^[\w@%+=:,./-]+$/.test(p) ? p : `'${String(p).replace(/'/g, `'\\''`)}'`)).join(' ');

// A TOML value for codex's config: JSON strings/arrays are valid TOML; objects become inline tables.
const tomlVal = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}=${JSON.stringify(String(x))}`).join(',')}}`
  : JSON.stringify(v));

const text = (v, max, what) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length > max) throw new Error(`${what} is too long (max ${max} characters)`);
  return s;
};
const pickAgents = (v, all) => {
  const list = Array.isArray(v) ? all.filter((a) => v.includes(a)) : all;
  if (!list.length) throw new Error('Pick at least one agent');
  return list;
};
// "KEY=value" (env) or "Name: value" (headers) lines ↔ an object. A value of SECRET keeps what was stored.
function parsePairs(v, sep, prev = {}, what) {
  if (v && typeof v === 'object' && !Array.isArray(v)) v = Object.entries(v).map(([k, x]) => `${k}${sep}${x}`).join('\n');
  const out = {};
  for (const raw of String(v || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(sep);
    const k = (i < 0 ? line : line.slice(0, i)).trim(), val = i < 0 ? '' : line.slice(i + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k)) throw new Error(`Bad ${what} name: ${k.slice(0, 40)}`);
    out[k] = val === SECRET && k in prev ? prev[k] : val;
  }
  return out;
}
const masked = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, v ? SECRET : '']));

function writeAtomic(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
function countFiles(dir, cap = MAX_SKILL_FILES + 1) {
  let n = 0, bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (n >= cap || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { n++; bytes += fs.statSync(p).size; }
    }
  };
  try { walk(dir); } catch {}
  return { n, bytes };
}

// GitHub folder links: https://github.com/<owner>/<repo>[/tree|blob/<ref>/<path>] → { repo, ref, dir }.
export function parseGitHubUrl(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { throw new Error('Paste a GitHub link to a skill folder'); }
  if (u.protocol !== 'https:' || !/^(www\.)?github\.com$/i.test(u.hostname)) throw new Error('Only https://github.com links can be imported');
  const [owner, repo, kind, ref, ...rest] = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (!owner || !repo || ![owner, repo].every((s) => SEG_RE.test(s))) throw new Error('That is not a GitHub repository link');
  if (kind && !['tree', 'blob'].includes(kind)) throw new Error('Link a folder (…/tree/<branch>/<path>) or a SKILL.md file');
  let dir = rest.join('/');
  if (kind === 'blob') dir = /(^|\/)SKILL\.md$/i.test(dir) ? path.posix.dirname(dir).replace(/^\.$/, '') : (() => { throw new Error('Link the SKILL.md file or its folder'); })();
  if (dir.split('/').some((s) => s === '..' || s === '.') || (ref && !/^[\w./-]{1,200}$/.test(ref))) throw new Error('That link has an unsupported path');
  return { repo: `https://github.com/${owner}/${repo.replace(/\.git$/, '')}.git`, ref: ref || null, dir };
}

// A raw SKILL.md link: https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>/SKILL.md → { owner, repo, ref, dir, url };
// null for any other host.
export function parseRawGitHubUrl(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return null; }
  if (!/^raw\.githubusercontent\.com$/i.test(u.hostname)) return null;
  if (u.protocol !== 'https:') throw new Error('Only https links can be imported');
  const [owner, repo, ref, ...rest] = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (!owner || !repo || !ref || ![owner, repo].every((s) => SEG_RE.test(s)) || !/^[\w.-]{1,200}$/.test(ref)) throw new Error('That is not a raw GitHub file link');
  if (rest.at(-1) !== 'SKILL.md') throw new Error('Link the SKILL.md file or its folder');
  if (rest.some((s) => s === '..' || s === '.')) throw new Error('That link has an unsupported path');
  return { owner, repo, ref, dir: rest.slice(0, -1).join('/'), url: u.href };
}

// A zip archive's entries (no zip64 or encryption): [{ name, dir, symlink, exec, size, data() }]. data() inflates on demand,
// capped at the size the central directory states.
export function readZip(buf) {
  const bad = (why) => new Error(`That is not a readable .zip or .skill file (${why})`);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad('no zip directory');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff) throw bad('zip64 is not supported');
  const out = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw bad('broken directory');
    const flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10), csize = buf.readUInt32LE(at + 20), size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32);
    const attrs = buf.readUInt32LE(at + 38) >>> 16, local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw bad('encrypted');
    const fileType = attrs & 0o170000;
    out.push({ name, size, dir: name.endsWith('/') || fileType === 0o040000, symlink: fileType === 0o120000, exec: !!(attrs & 0o100),
      data: () => {
        if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad(`no data for ${name}`);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), raw = buf.subarray(start, start + csize);
        if (method === 0) return raw;
        if (method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
        throw bad(`compression method ${method}`);
      } });
  }
  return out;
}

export const CODEX_PROFILE = 'agent-orch';

export function createExtensions({ dataDir, home = os.homedir(), claudeDir, codexDir, gitBin = 'git', importTimeoutMs = 120_000, fetch: fetchImpl = globalThis.fetch } = {}) {
  const claude = claudeDir || process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), codexHome = codexDir || path.join(home, '.codex');
  const roots = { claude: path.join(claude, 'skills'), codex: path.join(codexHome, 'skills') };
  const agentsDir = path.join(claude, 'agents');
  const extDir = path.join(dataDir, 'extensions');
  const mcpFile = path.join(extDir, 'mcp.json'), personasFile = path.join(extDir, 'personas.json');
  const claudeMcpFile = path.join(extDir, 'claude-mcp.json'), codexMcpFile = path.join(codexHome, `${CODEX_PROFILE}.config.toml`);
  const listeners = new Set();
  const changed = (kind) => { for (const fn of listeners) { try { fn(kind); } catch (e) { console.error('[ext] listener failed', e); } } };

  // ---------- skills
  // Skills the owner's Claude account syncs down (~/.claude/skills/synced/<bucket>/[<sub>/]<skill>/SKILL.md; dot entries
  // like .bucket-* and .last-complete-round are the sync's own) are listed read-only: the next sync would undo an edit.
  // Claude Code only, and they stay on this machine (syncInfo leaves them out): a worker signed in to the same account
  // gets them from its own sync, and one on another account shouldn't get this account's skills.
  const syncedRoot = path.join(roots.claude, 'synced');
  function readSkill(dir, folder) {
    const file = path.join(dir, 'SKILL.md');
    if (!isFile(file)) return null;
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
    const { meta, body } = parseFrontmatter(raw);
    return { folder, name: meta.name || folder, description: meta.description || '', body, files: countFiles(dir).n };
  }
  function listSynced() {
    const out = [], seen = new Set();
    const walk = (dir, rel, depth) => {
      let entries = [];
      try { entries = fs.readdirSync(dir).sort(); } catch { return; }
      for (const e of entries) {
        if (e.startsWith('.') || !SEG_RE.test(e)) continue;
        const p = path.join(dir, e), s = readSkill(p, e);
        if (s) { if (!seen.has(e)) { seen.add(e); out.push({ ...s, agents: ['claude'], source: 'synced', readOnly: true, path: `synced/${rel}${e}` }); } }
        else if (depth < 2 && isDir(p)) walk(p, `${rel}${e}/`, depth + 1);
      }
    };
    walk(syncedRoot, '', 0);
    return out.sort((a, b) => (a.folder < b.folder ? -1 : 1));
  }
  function listLocal() {
    const by = new Map();
    for (const agent of SKILL_AGENTS) {
      let entries = [];
      try { entries = fs.readdirSync(roots[agent]); } catch {}
      for (const folder of entries.sort()) {
        if (folder.startsWith('.') || !SEG_RE.test(folder)) continue; // .system (Codex's bundled skills)
        const s = readSkill(path.join(roots[agent], folder), folder);
        if (!s) continue;
        const cur = by.get(folder);
        if (cur) cur.agents.push(agent);
        else by.set(folder, { ...s, agents: [agent], source: 'local' });
      }
    }
    return [...by.values()];
  }
  const listSkills = () => [...listLocal(), ...listSynced()];
  const readOnlyError = (folder) => new Error(`${folder} is synced from your Claude account, so it can't be changed or deleted here. Change it in Claude and it syncs back.`);
  // The local skill named `folder`; a synced one of that name is refused.
  function localSkill(folder) {
    const s = listLocal().find((x) => x.folder === folder);
    if (!s && listSynced().some((x) => x.folder === folder)) throw readOnlyError(folder);
    return s || null;
  }
  const syncedName = (name) => listSynced().some((s) => s.folder === name);
  const skillDir = (agent, folder) => {
    if (!SEG_RE.test(folder)) throw new Error('Bad skill name');
    return path.join(roots[agent], folder);
  };
  // Symlinks (which could point anywhere on the machine) and .git are left behind.
  const copySkill = (from, to) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, filter: (p) => path.basename(p) !== '.git' && !fs.lstatSync(p).isSymbolicLink() });
  };
  // New: {name, description, body, agents}. Editing (prev = its folder) rewrites SKILL.md and keeps the other files;
  // an agent added later gets a copy of the whole folder, one dropped loses its copy.
  function saveSkill(b = {}) {
    const prev = b.prev ? String(b.prev) : null;
    const old = prev ? localSkill(prev) : null;
    if (prev && !old) throw new Error('That skill no longer exists');
    const name = text(b.name, 64, 'Name').toLowerCase();
    if (!NAME_RE.test(name)) throw new Error('Name: lowercase letters, numbers and hyphens (max 64)');
    const description = text(b.description, 1024, 'Description').replace(/\s+/g, ' ');
    if (!description) throw new Error('Add a description: it tells the agent when to use the skill');
    const body = text(b.body, MAX_TEXT, 'Instructions');
    if (!body) throw new Error('Add the instructions');
    const agents = pickAgents(b.agents, SKILL_AGENTS);
    if (name !== prev && listLocal().some((s) => s.folder === name)) throw new Error(`A skill named ${name} already exists`);
    if (name !== prev && syncedName(name)) throw new Error(`A skill named ${name} is already synced from your Claude account`);
    // Kept copies move first (a rename), new ones copy a kept (or about-to-go) copy, dropped ones go last.
    const had = old?.agents || [], kept = agents.filter((a) => had.includes(a));
    for (const agent of kept) if (old.folder !== name) fs.renameSync(skillDir(agent, old.folder), skillDir(agent, name));
    const source = kept.length ? skillDir(kept[0], name) : had.length ? skillDir(had[0], old.folder) : null;
    for (const agent of agents) {
      const dest = skillDir(agent, name);
      if (!had.includes(agent) && source) copySkill(source, dest);
      fs.mkdirSync(dest, { recursive: true });
      writeAtomic(path.join(dest, 'SKILL.md'), frontmatter({ name, description }, body), 0o644);
    }
    for (const agent of had) if (!agents.includes(agent)) fs.rmSync(skillDir(agent, old.folder), { recursive: true, force: true });
    changed('skills');
    return listLocal().find((s) => s.folder === name);
  }
  function removeSkill(folder) {
    const s = localSkill(folder);
    if (!s) throw new Error('No such skill');
    for (const agent of s.agents) fs.rmSync(skillDir(agent, folder), { recursive: true, force: true });
    changed('skills');
  }

  // ---------- adding a skill: previewSkill stages it (a GitHub link or a .zip/.skill upload) and says what it holds;
  // installSkill({id, agents, replace}) copies the staged folder into each agent's skills folder. importSkill does both.
  const tmpRoot = path.join(extDir, 'tmp');
  const stageDir = (id) => {
    if (!/^[0-9a-f]{16}$/.test(String(id || ''))) throw new Error('Bad preview id');
    return path.join(tmpRoot, `stage-${id}`);
  };
  const tooBig = (n, bytes) => new Error(`That skill is too big (${n} files, ${Math.round(bytes / 1048576)} MB; max ${MAX_SKILL_FILES} files, ${MAX_SKILL_BYTES >> 20} MB)`);
  // The one skill folder under `dir` (dir itself, or the only folder below it, up to 3 levels, with a SKILL.md).
  function findSkillRoot(dir, what) {
    if (isFile(path.join(dir, 'SKILL.md'))) return dir;
    const found = [];
    const walk = (d, depth) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === '__MACOSX') continue;
        const p = path.join(d, e.name);
        if (isFile(path.join(p, 'SKILL.md'))) found.push(p);
        else if (depth < 2) walk(p, depth + 1);
      }
    };
    walk(dir, 0);
    const names = found.map((p) => path.basename(p)).sort();
    if (found.length !== 1) throw new Error(found.length ? `That ${what} holds ${found.length} skills (${names.slice(0, 8).join(', ')}${found.length > 8 ? ', …' : ''}). ${what === 'upload' ? 'Upload' : 'Link'} one of them.` : `No SKILL.md in that ${what}`);
    return found[0];
  }
  // GitHub's API (public repos, no git needed): the tree of `ref`, then each file of the skill folder from raw.githubusercontent.com.
  // An API failure (private repo, rate limit, offline) is marked `fallback` so a github.com link tries git instead.
  async function fetchGitHub({ owner, repo, ref, dir }, dest) {
    const get = async (url, kind = 'json') => {
      let r;
      try { r = await fetchImpl(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-orch' }, signal: AbortSignal.timeout(importTimeoutMs) }); }
      catch (e) { throw Object.assign(new Error(`GitHub didn't answer: ${e.message}`), { fallback: true }); }
      if (!r.ok) throw Object.assign(new Error(`GitHub answered ${r.status}`), { fallback: true });
      return kind === 'json' ? r.json() : Buffer.from(await r.arrayBuffer());
    };
    const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    if (!ref) ref = (await get(api)).default_branch;
    if (!ref || !/^[\w./-]{1,200}$/.test(ref)) throw Object.assign(new Error('No branch to read'), { fallback: true });
    const tree = await get(`${api}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (!Array.isArray(tree?.tree) || tree.truncated) throw Object.assign(new Error('That repository is too big to list'), { fallback: true });
    const prefix = dir ? `${dir}/` : '';
    const safe = (p) => p.split('/').every((s) => SEG_RE.test(s) && !s.startsWith('.git'));
    const under = tree.tree.filter((e) => e.path.startsWith(prefix) && safe(e.path));
    if (dir && !under.length) throw new Error(`No folder ${dir} in that repository`);
    const blobs = under.filter((e) => e.type === 'blob' && e.mode !== '120000'); // not symlinks or submodules
    let root;
    if (blobs.some((e) => e.path === `${prefix}SKILL.md`)) root = dir;
    else {
      const found = blobs.filter((e) => /\/SKILL\.md$/.test(e.path) && !e.path.slice(prefix.length).split('/').some((s) => s.startsWith('.'))).map((e) => path.posix.dirname(e.path));
      const names = found.map((p) => path.posix.basename(p)).sort();
      if (found.length !== 1) throw new Error(found.length ? `That folder holds ${found.length} skills (${names.slice(0, 8).join(', ')}${found.length > 8 ? ', …' : ''}). Link one of them.` : 'No SKILL.md in that folder');
      root = found[0];
    }
    const rootPrefix = root ? `${root}/` : '';
    const files = blobs.filter((e) => e.path.startsWith(rootPrefix));
    const bytes = files.reduce((n, e) => n + (e.size || 0), 0);
    if (files.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) throw tooBig(files.length, bytes);
    for (const e of files) {
      const buf = await get(`https://raw.githubusercontent.com/${[owner, repo, ...ref.split('/'), ...e.path.split('/')].map(encodeURIComponent).join('/')}`, 'buf');
      const p = path.join(dest, ...e.path.slice(rootPrefix.length).split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf, { mode: e.mode === '100755' ? 0o755 : 0o644 });
    }
  }
  // A shallow, sparse git clone of just that folder (private repos work through git's gh credentials).
  async function cloneGitHub(src, dest) {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'import-'));
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' };
    const git = async (args) => {
      const r = await runHelper(gitBin, args, { env, timeoutMs: importTimeoutMs, cwd: tmp });
      if (r.code !== 0) throw new Error(r.timedOut ? 'GitHub took too long to answer' : /not found|could not read|Authentication/i.test(r.stderr)
        ? 'Could not read that repository (is it private to another account?)' : `git failed: ${String(r.stderr).trim().split('\n').pop() || r.error?.message || r.code}`);
    };
    try {
      await git(['clone', '--depth', '1', '--filter=blob:none', ...(src.dir ? ['--sparse'] : []), ...(src.ref ? ['--branch', src.ref] : []), '--', src.repo, 'repo']);
      const repo = path.join(tmp, 'repo');
      if (src.dir) await git(['-C', repo, 'sparse-checkout', 'set', '--', src.dir]);
      const dir = path.join(repo, src.dir);
      if (!isDir(dir)) throw new Error(`No folder ${src.dir} in that repository`);
      const root = findSkillRoot(dir, 'folder');
      const { n, bytes } = countFiles(root);
      if (n > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) throw tooBig(n, bytes);
      copySkill(root, dest);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  // A .zip or .skill (a zip of one skill folder): stored and deflated entries; symlinks, dot-git and __MACOSX left out.
  function unzipTo(buf, dest) {
    let files = 0, bytes = 0;
    for (const e of readZip(buf)) {
      const parts = e.name.split('/').filter(Boolean);
      if (e.dir || e.symlink || !parts.length || parts[0] === '__MACOSX' || parts.at(-1) === '.DS_Store' || parts.includes('.git')) continue;
      if (e.name.startsWith('/') || e.name.includes('\\') || parts.some((s) => s === '..' || s === '.' || !SEG_RE.test(s))) throw new Error(`The archive has an unsafe path: ${e.name.slice(0, 80)}`);
      if (++files > MAX_SKILL_FILES || (bytes += e.size) > MAX_SKILL_BYTES) throw tooBig(files, bytes);
      const p = path.join(dest, ...parts);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, e.data(), { mode: e.exec ? 0o755 : 0o644 });
    }
    if (!files) throw new Error('That archive is empty');
  }
  // Staged skills older than an hour (a preview never installed) are swept.
  function sweepStages(maxAgeMs = 3_600_000) {
    let names = [];
    try { names = fs.readdirSync(tmpRoot); } catch {}
    for (const n of names) {
      const p = path.join(tmpRoot, n);
      try { if (/^stage-/.test(n) && Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
  }
  // {url} (a GitHub repo, a folder in one, or a SKILL.md: github.com …/blob/… or raw.githubusercontent.com) or {zip} (a Buffer).
  // → { id, folder, name, description, files: [paths], exists: 'local'|'synced'|null } for the owner to check before installing.
  async function previewSkill(b = {}) {
    sweepStages();
    fs.mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
    const id = crypto.randomBytes(8).toString('hex'), stage = stageDir(id), dest = path.join(stage, 'skill');
    fs.mkdirSync(stage, { mode: 0o700 });
    try {
      let dir = dest;
      if (b.zip) {
        const tmp = path.join(stage, 'zip');
        unzipTo(Buffer.isBuffer(b.zip) ? b.zip : Buffer.from(String(b.zip), 'base64'), tmp);
        fs.renameSync(findSkillRoot(tmp, 'upload'), dest);
      } else {
        const raw = parseRawGitHubUrl(b.url);
        if (raw) {
          try { await fetchGitHub(raw, dest); } catch (e) {
            if (!e.fallback) throw e;
            // Just that file, when its folder can't be listed.
            let r;
            try { r = await fetchImpl(raw.url, { headers: { 'user-agent': 'agent-orch' }, signal: AbortSignal.timeout(importTimeoutMs) }); } catch (err) { throw new Error(`Could not fetch that file: ${err.message}`); }
            if (!r.ok) throw new Error(`Could not fetch that file (${r.status})`);
            fs.rmSync(dest, { recursive: true, force: true });
            fs.mkdirSync(dest);
            fs.writeFileSync(path.join(dest, 'SKILL.md'), Buffer.from(await r.arrayBuffer()), { mode: 0o644 });
          }
        } else {
          const src = parseGitHubUrl(b.url);
          const [, owner, repo] = /^https:\/\/github\.com\/([^/]+)\/(.+)\.git$/.exec(src.repo);
          try { await fetchGitHub({ owner, repo, ref: src.ref, dir: src.dir }, dest); } catch (e) {
            if (!e.fallback) throw e;
            fs.rmSync(dest, { recursive: true, force: true });
            await cloneGitHub(src, dest);
          }
        }
      }
      if (!isFile(path.join(dir, 'SKILL.md'))) throw new Error('No SKILL.md found');
      const { meta } = parseFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
      if (!String(meta.name || '').trim() || !String(meta.description || '').trim()) throw new Error('SKILL.md needs a name and a description in its frontmatter (--- name: … description: … ---)');
      const folder = String(meta.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
      if (!NAME_RE.test(folder)) throw new Error('The skill has no usable name');
      const files = skillFiles(dir).map((f) => f.path);
      const exists = listLocal().some((s) => s.folder === folder) ? 'local' : syncedName(folder) ? 'synced' : null;
      return { id, folder, name: meta.name, description: String(meta.description).replace(/\s+/g, ' ').trim(), files, exists };
    } catch (e) {
      fs.rmSync(stage, { recursive: true, force: true });
      throw e;
    }
  }
  function installSkill(b = {}) {
    const stage = stageDir(b.id), dir = path.join(stage, 'skill');
    if (!isDir(dir)) throw new Error('That preview has expired; add the skill again');
    const agents = pickAgents(b.agents, SKILL_AGENTS);
    const s = readSkill(dir, 'skill');
    const name = String(s?.name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    if (!NAME_RE.test(name)) throw new Error('The skill has no usable name');
    if (syncedName(name)) throw new Error(`A skill named ${name} is already synced from your Claude account`);
    if (listLocal().some((x) => x.folder === name) && !b.replace) throw Object.assign(new Error(`A skill named ${name} already exists`), { exists: name });
    for (const agent of SKILL_AGENTS) {
      const dest = skillDir(agent, name);
      if (b.replace || agents.includes(agent)) fs.rmSync(dest, { recursive: true, force: true });
      if (agents.includes(agent)) copySkill(dir, dest);
    }
    fs.rmSync(stage, { recursive: true, force: true });
    changed('skills');
    return listLocal().find((x) => x.folder === name);
  }
  async function importSkill(b = {}) {
    const p = await previewSkill(b);
    try { return installSkill({ ...b, id: p.id }); }
    finally { fs.rmSync(stageDir(p.id), { recursive: true, force: true }); }
  }

  // ---------- subagents (Claude): ~/.claude/agents/<name>.md, frontmatter name/description/tools/model + the prompt
  function listAgents() {
    let files = [];
    try { files = fs.readdirSync(agentsDir); } catch {}
    const out = [];
    for (const f of files.sort()) {
      if (!f.endsWith('.md') || !SEG_RE.test(f)) continue;
      let raw;
      try { raw = fs.readFileSync(path.join(agentsDir, f), 'utf8'); } catch { continue; }
      const { meta, body } = parseFrontmatter(raw);
      out.push({ file: f.slice(0, -3), name: meta.name || f.slice(0, -3), description: meta.description || '', tools: meta.tools || '', model: meta.model || '', prompt: body });
    }
    return out;
  }
  function saveAgent(b = {}) {
    const prev = b.prev ? String(b.prev) : null;
    const name = text(b.name, 64, 'Name').toLowerCase();
    if (!NAME_RE.test(name)) throw new Error('Name: lowercase letters, numbers and hyphens (max 64)');
    const description = text(b.description, 1024, 'Description').replace(/\s+/g, ' ');
    if (!description) throw new Error('Add a description: it tells Claude when to hand work to this agent');
    const prompt = text(b.prompt, MAX_TEXT, 'Instructions');
    if (!prompt) throw new Error("Add the agent's instructions");
    const tools = text(b.tools, 1000, 'Tools').split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
    if (tools.some((t) => !/^[\w*:.()-]+$/.test(t) && !/^\w+\(.*\)$/.test(t))) throw new Error('Tools: tool names separated by commas, e.g. Read, Grep, Bash');
    const model = text(b.model, 100, 'Model');
    if (model && !/^[\w.[\]-]+$/.test(model)) throw new Error('Model: an alias (sonnet, opus, haiku, inherit) or a model id');
    const existing = listAgents();
    if (prev && !existing.some((a) => a.file === prev)) throw new Error('That agent no longer exists');
    if (name !== prev && existing.some((a) => a.file === name)) throw new Error(`An agent named ${name} already exists`);
    writeAtomic(path.join(agentsDir, `${name}.md`), frontmatter({ name, description, tools: tools.join(', '), model }, prompt), 0o644);
    if (prev && prev !== name) fs.rmSync(path.join(agentsDir, `${prev}.md`), { force: true });
    changed('agents');
    return listAgents().find((a) => a.file === name);
  }
  function removeAgent(file) {
    if (!SEG_RE.test(file) || !listAgents().some((a) => a.file === file)) throw new Error('No such agent');
    fs.rmSync(path.join(agentsDir, `${file}.md`), { force: true });
    changed('agents');
  }

  // ---------- MCP servers (agent-orch's own list, handed to each run)
  const readMcp = () => { const j = readJson(mcpFile, null); return Array.isArray(j?.servers) ? j.servers : []; };
  const writeMcp = (servers) => writeAtomic(mcpFile, JSON.stringify({ servers }, null, 2));
  const publicMcp = (s) => ({ ...s, env: masked(s.env), headers: masked(s.headers), commandLine: s.type === 'stdio' ? joinCommand([s.command, ...(s.args || [])]) : '',
    gated: s.type !== 'sse' && !!(s.browser || s.outbound?.length), ungatedOutbound: s.type === 'sse' && !!s.outbound?.length });
  function saveMcp(b = {}) {
    const servers = readMcp();
    const prev = b.prev ? String(b.prev) : null, old = prev ? servers.find((s) => s.name === prev) : null;
    if (prev && !old) throw new Error('That server no longer exists');
    const name = text(b.name, 64, 'Name');
    if (!MCP_NAME_RE.test(name)) throw new Error('Name: letters, numbers, - and _ (max 64)');
    if (name !== prev && servers.some((s) => s.name === name)) throw new Error(`A server named ${name} already exists`);
    const type = MCP_TYPES.includes(b.type) ? b.type : 'stdio';
    const s = { name, type, enabled: !!(b.enabled ?? old?.enabled ?? true), agents: pickAgents(b.agents, type === 'sse' ? ['claude'] : SKILL_AGENTS) };
    if (type === 'stdio') {
      const parts = Array.isArray(b.args) && b.command ? [String(b.command), ...b.args.map(String)] : splitCommand(text(b.commandLine ?? b.command, 4000, 'Command'));
      if (!parts[0]) throw new Error('Add the command that starts the server, e.g. npx -y @playwright/mcp@latest');
      Object.assign(s, { command: parts[0], args: parts.slice(1), env: parsePairs(b.env, '=', old?.env, 'variable') });
    } else {
      const url = text(b.url, 2000, 'URL');
      try { if (!/^https?:$/.test(new URL(url).protocol)) throw 0; } catch { throw new Error('Add the server URL (http or https)'); }
      Object.assign(s, { url, headers: parsePairs(b.headers, ':', old?.headers, 'header') });
    }
    // A connector: its tools named here (or ending in *) are outbound and held for the owner in task runs (gate.mjs).
    // A stdio or http connector is gated (gate-proxy.mjs); an sse one keeps its list and stays out of gated runs.
    const outbound = (Array.isArray(b.outbound) ? b.outbound : String(b.outbound ?? (old?.outbound || []).join(', ')).split(/[\s,]+/))
      .map((x) => String(x).trim()).filter((x) => /^[\w.-]{1,120}\*?$/.test(x)).slice(0, 200);
    if (outbound.length) s.outbound = outbound;
    const next = servers.filter((x) => x.name !== prev && x.name !== name);
    const at = prev ? servers.findIndex((x) => x.name === prev) : -1;
    next.splice(at < 0 ? next.length : at, 0, s);
    writeMcp(next);
    changed('mcp');
    return publicMcp(s);
  }
  function removeMcp(name) {
    const servers = readMcp();
    if (!servers.some((s) => s.name === name)) throw new Error('No such server');
    writeMcp(servers.filter((s) => s.name !== name));
    changed('mcp');
  }
  function setMcpEnabled(name, enabled) {
    const servers = readMcp(), s = servers.find((x) => x.name === name);
    if (!s) throw new Error('No such server');
    s.enabled = !!enabled;
    writeMcp(servers);
    changed('mcp');
    return publicMcp(s);
  }
  // The servers a run on `agent` gets: Claude → an SDK/--mcp-config mcpServers record, codex → config.toml tables; null for none.
  // run.browser ({identity, outputDir, home?, headed?}, a task with the browser capability) adds the Playwright MCP on
  // that identity's persistent profile (browser.mjs), replacing an owner server of the same name; codex waits its
  // startupSec for it (startup_timeout_sec). run.gate ({dir, task,
  // rules, ttlMs, hook}, a task run) puts that server and every connector (stdio or http servers with `outbound` tools)
  // behind the approval gate: gate-proxy.mjs runs or connects to them, from a 0600 config in the run's gate dir, and the run
  // gets a stdio entry for the proxy. gate-proxy.mjs doesn't speak sse, so a gated run leaves out an sse server with
  // `outbound` tools and tells run.onWithheld (or run.gate.onWithheld) (name, reason).
  function mcpFor(agent, run = null) {
    let on = readMcp().filter((s) => s.enabled !== false && (s.agents || SKILL_AGENTS).includes(agent) && (agent !== 'codex' || s.type !== 'sse'));
    if (run?.browser) on = [...on.filter((s) => s.name !== BROWSER_MCP), { name: BROWSER_MCP, env: {}, browser: true, ...browserServer({ home, ...run.browser }) }];
    if (run?.gate) {
      on = on.filter((s) => {
        if (s.type !== 'sse' || !s.outbound?.length) return true;
        (run.onWithheld ?? run.gate.onWithheld)?.(s.name, WITHHELD_REASON);
        return false;
      }).map((s) => (s.browser || s.outbound?.length ? gated(s, run.gate) : s));
    }
    if (!on.length || !SKILL_AGENTS.includes(agent)) return null;
    if (agent === 'codex') {
      const toml = on.map((s) => [`[mcp_servers.${s.name}]`, ...(s.type === 'stdio'
        ? [`command = ${tomlVal(s.command)}`, `args = ${tomlVal(s.args || [])}`, ...(Object.keys(s.env || {}).length ? [`env = ${tomlVal(s.env)}`] : []),
          ...(s.holdSec ? [`tool_timeout_sec = ${s.holdSec}`] : []), ...(s.startupSec ? [`startup_timeout_sec = ${s.startupSec}`] : [])]
        : [`url = ${tomlVal(s.url)}`, ...(Object.keys(s.headers || {}).length ? [`http_headers = ${tomlVal(s.headers)}`] : [])])].join('\n'));
      return `# Written by agent-orch (Settings → Skills & tools) for its codex runs (codex -p ${CODEX_PROFILE}). Changes here are overwritten.\n\n${toml.join('\n\n')}\n`;
    }
    return Object.fromEntries(on.map((s) => [s.name, s.type === 'stdio'
      ? { type: 'stdio', command: s.command, args: s.args || [], ...(Object.keys(s.env || {}).length && { env: s.env }) }
      : { type: s.type, url: s.url, ...(Object.keys(s.headers || {}).length && { headers: s.headers }) }]));
  }
  function gated(s, g) {
    const file = path.join(g.dir, `proxy-${s.name}.json`);
    writeAtomic(file, JSON.stringify({ dir: g.dir, server: s.name, kind: s.browser ? 'browser' : 'connector', task: g.task ?? null, rules: g.rules || [],
      ttlMs: g.ttlMs, hook: !!g.hook, upstream: s.type === 'http' ? { url: s.url, headers: s.headers || {} } : { command: s.command, args: s.args || [], env: s.env || {} },
      ...(!s.browser && { connector: { outbound: s.outbound } }) }));
    // codex gives up on a tool call after 60 s by default: a held one waits for the owner (up to the approval TTL).
    return { name: s.name, type: 'stdio', command: process.execPath, args: [GATE_PROXY, '--config', file], env: {}, holdSec: Math.ceil(((g.ttlMs || 86_400_000) + 900_000) / 1000),
      ...(s.startupSec && { startupSec: s.startupSec }) };
  }
  // What a run passes (writing the file first when it changed): Claude → the --mcp-config file, codex → the profile name.
  // A browser run gets its own file / profile (named by a hash of its config), and ones a day old are swept.
  function mcpRun(agent, run = null) {
    if (!SKILL_AGENTS.includes(agent)) return null;
    const cfg = mcpFor(agent, run);
    let file = agent === 'codex' ? codexMcpFile : claudeMcpFile, profile = CODEX_PROFILE;
    if ((run?.browser || run?.gate) && cfg) {
      const key = crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 12);
      profile = `${CODEX_PROFILE}-run-${key}`;
      file = agent === 'codex' ? path.join(codexHome, `${profile}.config.toml`) : path.join(extDir, 'runs', `claude-mcp-${key}.json`);
      sweepRunFiles();
    }
    const text = cfg == null ? null : agent === 'codex' ? cfg : JSON.stringify({ mcpServers: cfg }, null, 2);
    let cur = null;
    try { cur = fs.readFileSync(file, 'utf8'); } catch {}
    if (text == null) { if (cur != null) fs.rmSync(file, { force: true }); return null; }
    if (cur !== text) writeAtomic(file, text);
    else if (run?.browser || run?.gate) fs.utimesSync(file, new Date(), new Date());
    return agent === 'codex' ? profile : file;
  }
  function sweepRunFiles(maxAgeMs = 86_400_000) {
    const old = (f) => { try { return Date.now() - fs.statSync(f).mtimeMs > maxAgeMs; } catch { return false; } };
    const ls = (d, re) => { try { return fs.readdirSync(d).filter((n) => re.test(n)).map((n) => path.join(d, n)); } catch { return []; } };
    for (const f of [...ls(path.join(extDir, 'runs'), /^claude-mcp-[0-9a-f]+\.json$/), ...ls(codexHome, new RegExp(`^${CODEX_PROFILE}-run-[0-9a-f]+\\.config\\.toml$`))]) {
      if (old(f)) fs.rmSync(f, { force: true });
    }
  }

  // ---------- personas
  const readPersonas = () => { const j = readJson(personasFile, null); return Array.isArray(j?.personas) ? j.personas : []; };
  const writePersonas = (personas) => writeAtomic(personasFile, JSON.stringify({ personas }, null, 2));
  function savePersona(b = {}) {
    const list = readPersonas();
    const id = b.id ? String(b.id) : null, old = id ? list.find((p) => p.id === id) : null;
    if (id && !old) throw new Error('That persona no longer exists');
    const name = text(b.name, 60, 'Name').replace(/\s+/g, ' ');
    if (!name) throw new Error('Name the persona');
    if (list.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) throw new Error(`A persona named ${name} already exists`);
    const prompt = text(b.prompt, 20_000, 'Instructions');
    if (!prompt) throw new Error('Describe how the persona works and talks');
    const p = { id: id || crypto.randomBytes(5).toString('hex'), name, description: text(b.description, 200, 'Summary'), prompt, createdAt: old?.createdAt || Date.now(), updatedAt: Date.now() };
    writePersonas(old ? list.map((x) => (x.id === id ? p : x)) : [...list, p]);
    changed('personas');
    return p;
  }
  function removePersona(id) {
    const list = readPersonas();
    if (!list.some((p) => p.id === id)) throw new Error('No such persona');
    writePersonas(list.filter((p) => p.id !== id));
    changed('personas');
  }
  const persona = (id) => (id ? readPersonas().find((p) => p.id === id) || null : null);
  // The system-prompt block for a persona id (null when none or deleted).
  function personaPrompt(id) {
    const p = persona(id);
    return p ? `## Persona: ${p.name}\nThe owner chose this persona for this project. Work and reply as it describes, within the rules above:\n${p.prompt}` : null;
  }

  // ---------- cluster workers (the extension bundle, cluster-protocol.mjs extBundleError). The controller's syncBundle()
  // holds its skills, subagents and enabled MCP servers (rebuilt only when a file's size/mtime or the MCP list changes).
  // A worker's applyBundle() writes it into that machine's ~/.claude and ~/.codex and its own mcp.json, touching only
  // entries an earlier sync wrote (synced.json): skills and subagents installed there by hand stay as they are.
  const syncedFile = path.join(extDir, 'synced.json');
  const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  // A skill folder's files, as copySkill copies them (no .git, no symlinks).
  function skillFiles(dir) {
    const out = [];
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
        if (e.name === '.git' || e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(p, r);
        else if (e.isFile()) { const st = fs.statSync(p); out.push({ path: r, abs: p, size: st.size, mtime: st.mtimeMs, x: !!(st.mode & 0o100) }); }
      }
    };
    walk(dir, '');
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  let built = null; // { key, info, where: sha -> a file with that content }
  function syncInfo() {
    const skills = listLocal().filter((s) => EXT_ENTRY_RE.test(s.folder)).flatMap((s) => s.agents.map((agent) => ({ agent, name: s.folder, files: skillFiles(skillDir(agent, s.folder)) })));
    const agents = listAgents().filter((a) => EXT_ENTRY_RE.test(a.file)).map((a) => {
      const abs = path.join(agentsDir, `${a.file}.md`), st = fs.statSync(abs);
      return { name: a.file, abs, size: st.size, mtime: st.mtimeMs };
    });
    const mcp = readMcp().filter((s) => s.enabled !== false);
    const key = JSON.stringify([skills.map((s) => [s.agent, s.name, s.files.map((f) => [f.path, f.size, f.mtime, f.x])]), agents.map((a) => [a.name, a.size, a.mtime]), mcp]);
    if (built?.key === key) return built.info;
    const where = new Map(), skipped = [];
    let bytes = 0;
    // Subagents first (small), then skills in name order until EXT_MAX_BYTES (a file shared by entries counts once).
    const fits = (kind, name, files) => {
      const fresh = new Map(files.filter((f) => !where.has(f.sha)).map((f) => [f.sha, f]));
      const add = [...fresh.values()].reduce((n, f) => n + f.size, 0);
      if (bytes + add > EXT_MAX_BYTES) { skipped.push({ kind, name, reason: `the bundle is full (${EXT_MAX_BYTES >> 20} MB)` }); return false; }
      for (const [sha, f] of fresh) where.set(sha, f.abs);
      bytes += add;
      return true;
    };
    const withSha = (f) => { const buf = fs.readFileSync(f.abs); return { ...f, sha: sha256(buf), size: buf.length }; };
    const info = { v: 1, hash: null, bytes: 0, skills: [], agents: [], mcp, skipped };
    for (const a of agents) {
      const f = withSha(a);
      if (fits('agent', a.name, [f])) info.agents.push({ name: a.name, sha: f.sha });
    }
    for (const s of skills) {
      const total = s.files.reduce((n, f) => n + f.size, 0);
      // Past the import limits (a skill copied in by hand can be anything), or only symlinks: it stays on the controller.
      const why = s.files.length > MAX_SKILL_FILES || total > MAX_SKILL_BYTES ? `too big (${s.files.length} files, ${Math.ceil(total / 1048576)} MB)` : !s.files.length ? 'only symlinks' : null;
      if (why) { skipped.push({ kind: 'skill', name: `${s.agent}/${s.name}`, reason: why }); continue; }
      const files = s.files.map(withSha);
      if (fits('skill', `${s.agent}/${s.name}`, files)) info.skills.push({ agent: s.agent, name: s.name, files: files.map((f) => ({ path: f.path, sha: f.sha, ...(f.x && { x: true }) })) });
    }
    Object.assign(info, { hash: extHash(info), bytes });
    built = { key, info, where };
    return info;
  }
  // The whole bundle, with each file's content (base64). A file that changed since syncInfo read it rebuilds it once.
  function syncBundle(retry = true) {
    const info = syncInfo(), blobs = {};
    for (const [sha, file] of built.where) {
      let buf = null;
      try { buf = fs.readFileSync(file); } catch {}
      if (!buf || sha256(buf) !== sha) {
        if (!retry) throw new Error(`${file} keeps changing`);
        built = null;
        return syncBundle(false);
      }
      blobs[sha] = buf.toString('base64');
    }
    return { ...info, blobs };
  }

  const lexists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
  const synced = () => {
    const j = readJson(syncedFile, null);
    return { hash: j?.hash || null, skills: { claude: { ...j?.skills?.claude }, codex: { ...j?.skills?.codex } }, agents: { ...j?.agents }, kept: j?.kept || [] };
  };
  // Worker side: writes a bundle (checked first) here. Returns what it did; `kept` = entries installed here by hand
  // under a name the controller also uses (left alone). A failure part-way still records what was written.
  function applyBundle(b) {
    const err = extBundleError(b);
    if (err) throw new Error(err);
    const next = { ...synced(), hash: null, kept: [] };
    const blob = (sha) => Buffer.from(b.blobs[sha], 'base64');
    try {
      for (const agent of SKILL_AGENTS) {
        const root = roots[agent], mine = next.skills[agent], want = new Map(b.skills.filter((s) => s.agent === agent).map((s) => [s.name, s]));
        fs.mkdirSync(root, { recursive: true });
        for (const e of fs.readdirSync(root)) if (e.startsWith('.agent-orch-sync-')) fs.rmSync(path.join(root, e), { recursive: true, force: true });
        for (const name of Object.keys(mine)) {
          if (want.has(name)) continue;
          if (EXT_ENTRY_RE.test(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
          delete mine[name];
        }
        for (const s of want.values()) {
          const dest = path.join(root, s.name), digest = sha256(JSON.stringify(s.files));
          if (!(s.name in mine) && lexists(dest)) { next.kept.push(`${agent} skill ${s.name}`); continue; }
          if (mine[s.name] === digest && isDir(dest)) continue;
          // Written beside it, then swapped in: a run starting meanwhile sees the old or the new skill, never half of one.
          const tmp = path.join(root, `.agent-orch-sync-${s.name}-${crypto.randomBytes(4).toString('hex')}`);
          for (const f of s.files) {
            const p = path.join(tmp, ...f.path.split('/'));
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, blob(f.sha), { mode: f.x ? 0o755 : 0o644 });
          }
          fs.rmSync(dest, { recursive: true, force: true });
          fs.renameSync(tmp, dest);
          mine[s.name] = digest;
        }
      }
      const want = new Map(b.agents.map((a) => [a.name, a]));
      for (const name of Object.keys(next.agents)) {
        if (want.has(name)) continue;
        if (EXT_ENTRY_RE.test(name)) fs.rmSync(path.join(agentsDir, `${name}.md`), { force: true });
        delete next.agents[name];
      }
      for (const a of want.values()) {
        const dest = path.join(agentsDir, `${a.name}.md`);
        if (!(a.name in next.agents) && lexists(dest)) { next.kept.push(`subagent ${a.name}`); continue; }
        if (next.agents[a.name] !== a.sha || !isFile(dest)) writeAtomic(dest, blob(a.sha), 0o644);
        next.agents[a.name] = a.sha;
      }
      writeMcp(b.mcp);
      for (const agent of SKILL_AGENTS) mcpRun(agent); // the run files, now rather than at the next run
      next.hash = b.hash;
    } finally {
      writeAtomic(syncedFile, JSON.stringify(next, null, 1));
    }
    return { hash: b.hash, skills: b.skills.length, agents: b.agents.length, mcp: b.mcp.length, kept: next.kept };
  }

  // Every kind (and where skills and subagents are saved), or just {[kind]: [...]}.
  function list(kind) {
    const all = { skills: listSkills, agents: listAgents, mcp: () => readMcp().map(publicMcp), personas: readPersonas };
    if (kind) return { [kind]: all[kind]() };
    return { ...Object.fromEntries(Object.entries(all).map(([k, fn]) => [k, fn()])), paths: { claudeSkills: roots.claude, codexSkills: roots.codex, agents: agentsDir } };
  }

  return {
    list, listSkills, saveSkill, removeSkill, importSkill, previewSkill, installSkill, listAgents, saveAgent, removeAgent,
    saveMcp, removeMcp, setMcpEnabled, mcpFor, mcpRun, savePersona, removePersona, persona, personaPrompt,
    syncInfo, syncBundle, applyBundle, synced,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
