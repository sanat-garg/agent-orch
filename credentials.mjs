// Credentials (owner, 2026-10-08): the owner keeps each service's logins and keys here instead of in .env files and
// docs, and reads them in the sidebar's Credentials sheet (public/credentials.js). Every user has their own; nobody
// sees anyone else's, the admin included.
//   <DATA>/credentials.json: {v: 1, iv, tag, data} = AES-256-GCM of [{id, owner, name, url, notes, fields: [{label,
//   value, secret}], createdAt, updatedAt}] under the key in <DATA>/credentials.key (both 0600; data/ is never committed).
//   The encryption keeps values out of anything that copies the JSON alone (a log, a grep, a backup of one file).
//   createCredentials({dataDir, now}) → { list(owner), add(owner, body), update(owner, id, body), remove(owner, id), reown(from, to),
//   importProject(owner, dir, entries) }
// Projects add their keys themselves (owner, 2026-10-13): after every commit in a project folder (server.mjs syncGitNow)
// the secrets in its .env files (projectSecrets) go into its owner's card for that project (row.auto = the folder;
// row.seen = label → hash of the value last imported). A value is (re)written only when it differs from the last one
// imported, so the owner's edits and deletions stick until the project's .env changes that key; deleting the card keeps a
// hidden tombstone (row.deleted) for the same reason. Never in list() or the services limit.
// Bodies are {name, url?, notes?, fields: [{label, value, secret?}]}; a bad one throws an Error with status 400, a
// missing or someone else's id 404.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LIMITS = { name: 80, url: 500, notes: 4000, label: 80, value: 8000, fields: 40, services: 500 };

// .env files (root and one folder down) and the keys worth keeping: names that say key/token/secret/password…, or a
// URL with a password in it (DATABASE_URL). Examples, templates and placeholder values are skipped.
const ENV_FILE = /^\.env(\.[\w.-]+)?$/, ENV_SKIP = /\.(example|sample|template|dist|defaults?|schema)$/i;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', 'venv', '__pycache__']);
const SECRET_NAME = /(^|_)(API_?KEY|KEY|KEYS|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|PRIVATE|CREDENTIALS?|AUTH|DSN|WEBHOOK)(_|$)|(SECRET|TOKEN|APIKEY|PASSWORD)/i;
const PLACEHOLDER = /^(x+|\*+|\.+|0+|changeme|change[-_]?me|replace[-_]?me|todo|tbd|placeholder|example|secret|password|test|dummy|null|none|undefined|true|false|(your|my|insert|put|add|enter)[-_ ].*|<.*>|\[.*\]|\{\{.*\}\}|\$\{.*\})$/i;
export function parseEnvText(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^"(.*)"$/.test(v)) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } } else if (/^'(.*)'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out.push({ key: m[1], value: v });
  }
  return out;
}
const worthKeeping = ({ key, value }) => value.length >= 8 && value.length <= LIMITS.value && !PLACEHOLDER.test(value.trim())
  && ((SECRET_NAME.test(key) && !/_(URL|URI|HOST|PORT|ENDPOINT|DOMAIN|REGION|EMAIL)$/i.test(key)) || /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/i.test(value));
// [{label, value, file}] for one project folder: a key found in several files with different values is labelled with
// the file (e.g. "STRIPE_KEY (web/.env.local)"); the same value twice is kept once.
export function projectSecrets(dir) {
  const files = [];
  const scan = (sub) => {
    let ents;
    try { ents = fs.readdirSync(path.join(dir, sub), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isFile() && ENV_FILE.test(e.name) && !ENV_SKIP.test(e.name)) files.push(path.join(sub, e.name));
      else if (!sub && e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) scan(e.name);
    }
  };
  scan('');
  files.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
  const out = [];
  for (const file of files) {
    let text;
    try { if (fs.statSync(path.join(dir, file)).size > 256e3) continue; text = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { continue; }
    for (const e of parseEnvText(text).filter(worthKeeping)) {
      const same = out.filter((o) => o.key === e.key);
      if (same.some((o) => o.value === e.value)) continue;
      out.push({ key: e.key, value: e.value, file, label: same.length ? `${e.key} (${file})` : e.key });
    }
  }
  return out.slice(0, LIMITS.fields).map(({ label, value, file }) => ({ label, value, file }));
}
const digest = (v) => crypto.createHash('sha256').update(v).digest('base64').slice(0, 22);

const fail = (status, message) => Object.assign(new Error(message), { status });
const str = (v, max, what) => {
  const s = String(v ?? '').trim();
  if (s.length > max) throw fail(400, `${what} is too long (at most ${max} characters)`);
  return s;
};

// A request body as a stored service (id and timestamps are the caller's).
export function cleanService(body = {}) {
  const name = str(body.name, LIMITS.name, 'The name');
  if (!name) throw fail(400, 'Give the service a name');
  let url = str(body.url, LIMITS.url, 'The link');
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  if (url) { try { new URL(url); } catch { throw fail(400, 'The link is not a valid address'); } }
  const raw = Array.isArray(body.fields) ? body.fields : [];
  if (raw.length > LIMITS.fields) throw fail(400, `At most ${LIMITS.fields} fields per service`);
  const fields = raw
    .map((f) => ({ label: str(f?.label, LIMITS.label, 'A field name'), value: String(f?.value ?? ''), secret: !!f?.secret }))
    .filter((f) => f.label || f.value);
  for (const f of fields) {
    if (!f.label) throw fail(400, 'Every value needs a name, e.g. "API key"');
    if (f.value.length > LIMITS.value) throw fail(400, `${f.label} is too long (at most ${LIMITS.value} characters)`);
  }
  return { name, url, notes: str(body.notes, LIMITS.notes, 'The notes'), fields };
}

export function createCredentials({ dataDir, now = Date.now }) {
  const file = path.join(dataDir, 'credentials.json'), keyFile = path.join(dataDir, 'credentials.key');
  let key = null, items = null;

  function getKey() {
    if (key) return key;
    try { key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64'); } catch {}
    if (key?.length !== 32) {
      if (fs.existsSync(file)) throw fail(500, `credentials.key is missing or damaged, so ${file} can't be read`);
      key = crypto.randomBytes(32);
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(keyFile, key.toString('base64') + '\n', { mode: 0o600 });
    }
    return key;
  }
  function load() {
    if (items) return items;
    let box;
    try { box = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') return (items = []);
      throw fail(500, `credentials.json can't be read: ${e.message}`);
    }
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    items = JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
    return items;
  }
  function save() {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const data = Buffer.concat([c.update(JSON.stringify(items), 'utf8'), c.final()]);
    const box = { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(box), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  const view = ({ owner, auto, seen, deleted, ...s }) => (auto ? { ...s, auto: path.basename(auto) } : s);
  const live = (owner) => load().filter((s) => s.owner === owner && !s.deleted);
  const mine = (owner, id) => {
    const s = load().find((x) => x.id === id && x.owner === owner && !x.deleted);
    if (!s) throw fail(404, 'No such service');
    return s;
  };

  return {
    // Newest change first.
    list: (owner) => live(owner).sort((a, b) => b.updatedAt - a.updatedAt).map(view),
    add(owner, body) {
      const s = cleanService(body);
      if (live(owner).length >= LIMITS.services) throw fail(400, `At most ${LIMITS.services} services`);
      const t = now(), row = { id: crypto.randomUUID(), owner, ...s, createdAt: t, updatedAt: t };
      items.push(row);
      save();
      return view(row);
    },
    update(owner, id, body) {
      const row = Object.assign(mine(owner, id), cleanService(body), { updatedAt: now() });
      save();
      return view(row);
    },
    remove(owner, id) {
      const row = mine(owner, id);
      if (row.auto) Object.assign(row, { deleted: true, fields: [], notes: '', updatedAt: now() });
      else items = items.filter((x) => x !== row);
      save();
    },
    // A project's .env secrets ([{label, value, file}], projectSecrets) into `owner`'s card for the folder `dir`, created
    // on the first one. Only values that changed since the last import are written. → the labels added or changed.
    importProject(owner, dir, entries) {
      let row = load().find((x) => x.owner === owner && x.auto === dir);
      const fresh = entries.filter((e) => row?.seen?.[e.label] !== digest(e.value));
      if (!fresh.length) return [];
      if (!row) {
        if (live(owner).length >= LIMITS.services) return [];
        const name = path.basename(dir).slice(0, LIMITS.name);
        row = { id: crypto.randomUUID(), owner, name, url: '', notes: `Saved automatically from the ${name} project's .env files. Edit or delete anything here: a key comes back only when its value in the project changes.`,
          fields: [], auto: dir, seen: {}, createdAt: now() };
        items.push(row);
      }
      if (row.deleted) Object.assign(row, { deleted: false, notes: `Saved automatically from the ${row.name} project's .env files.` });
      const changed = [];
      for (const e of fresh) {
        row.seen[e.label] = digest(e.value);
        const f = row.fields.find((x) => x.label === e.label);
        if (f) { if (f.value === e.value) continue; f.value = e.value; }
        else if (row.fields.length < LIMITS.fields) row.fields.push({ label: e.label, value: e.value, secret: true });
        else continue;
        changed.push(e.label);
      }
      if (changed.length) row.updatedAt = now();
      save();
      return changed;
    },
    // A deleted user's services go to whoever takes over their chats.
    reown(from, to) {
      let n = 0;
      for (const s of load()) if (s.owner === from) { s.owner = to; n++; }
      if (n) save();
      return n;
    },
  };
}
