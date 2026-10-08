// Credentials (owner, 2026-10-08): the owner keeps each service's logins and keys here instead of in .env files and
// docs, and reads them in the sidebar's Credentials sheet (public/credentials.js). Every user has their own; nobody
// sees anyone else's, the admin included.
//   <DATA>/credentials.json: {v: 1, iv, tag, data} = AES-256-GCM of [{id, owner, name, url, notes, fields: [{label,
//   value, secret}], createdAt, updatedAt}] under the key in <DATA>/credentials.key (both 0600; data/ is never committed).
//   The encryption keeps values out of anything that copies the JSON alone (a log, a grep, a backup of one file).
//   createCredentials({dataDir, now}) → { list(owner), add(owner, body), update(owner, id, body), remove(owner, id), reown(from, to) }
// Bodies are {name, url?, notes?, fields: [{label, value, secret?}]}; a bad one throws an Error with status 400, a
// missing or someone else's id 404.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LIMITS = { name: 80, url: 500, notes: 4000, label: 80, value: 8000, fields: 40, services: 500 };

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
  const view = ({ owner, ...s }) => s;
  const mine = (owner, id) => {
    const s = load().find((x) => x.id === id && x.owner === owner);
    if (!s) throw fail(404, 'No such service');
    return s;
  };

  return {
    // Newest change first.
    list: (owner) => load().filter((s) => s.owner === owner).sort((a, b) => b.updatedAt - a.updatedAt).map(view),
    add(owner, body) {
      const s = cleanService(body);
      if (load().filter((x) => x.owner === owner).length >= LIMITS.services) throw fail(400, `At most ${LIMITS.services} services`);
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
      items = items.filter((x) => x !== row);
      save();
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
