// Users: several people sign in to one agent-orch. The admin (the original owner) manages the others and can cap each
// one's share of every weekly plan window the agent CLIs report (Claude's all-models week and per-model weeks such as
// Fable; codex's weekly), e.g. "Sam may use at most 10% of the Fable week".
//   <DATA>/users.json: [{id, name, role: 'admin'|'user', salt, hash, caps: {'<agent>/<window>': pct}, aliases?, createdAt}]
// The first run migrates the single-password login (auth.json) into the admin account (id 'admin', name 'admin', alias
// 'claude': the old login page's hidden username, which saved passwords carry), so nobody is signed out.
// A user's usage of a window is an estimate: the CLIs only report the whole account's pct, so it is split by each
// user's share of the weighted tokens (input + cached/10 + 5 × output) recorded for that window's models since the
// window began (usage.mjs tokens records carry user and model; older records count as the admin's).
//   createUsers({dataDir, usageLog, now}) → { list, get, byName, check, add, update, remove, view, usage, capBlock }
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ADMIN_ID = 'admin';
export const WEEK_MS = 7 * 86400e3;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') };
}
function passwordOk(u, pw) {
  if (!u?.salt || !u?.hash) return false;
  const got = crypto.scryptSync(String(pw), u.salt, 64), want = Buffer.from(u.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Plan windows that span a week (the five-hour session windows can't be capped as a share of the week).
export const isWeekly = (window) => !['five_hour', '5h'].includes(window);
// Whether a turn on `model` counts toward `window`: account-wide windows take every model; Claude's per-model weeks
// (seven_day_opus, seven_day_sonnet, model-scoped ones named like "Fable") only their own model family.
export function windowCovers(agent, window, model) {
  if (agent !== 'claude' || ['seven_day', 'five_hour'].includes(window)) return true;
  const key = window === 'seven_day_opus' ? 'opus' : window === 'seven_day_sonnet' ? 'sonnet' : String(window).toLowerCase().split(/\s+/)[0];
  return !!key && String(model || '').toLowerCase().includes(key);
}
// A weekly window as people say it: 'Claude · all models', 'Claude · Fable', 'Codex · all models'.
export function windowName(agent, window) {
  const who = agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : agent;
  const what = ['seven_day', 'weekly'].includes(window) ? 'all models' : window === 'seven_day_opus' ? 'Opus'
    : window === 'seven_day_sonnet' ? 'Sonnet' : String(window);
  return `${who} · ${what}`;
}
export const tokenWeight = (r) => (Number(r.input) || 0) + (Number(r.cached) || 0) / 10 + 5 * (Number(r.output) || 0);
// One window's split: {pct (the account's), mine (this user's estimated pct)}; records: usage tokens records.
export function shareOf(records, { user, agent, window, pct, resetsAt }, at = Date.now()) {
  const start = (resetsAt ? resetsAt * 1000 : at) - WEEK_MS;
  let all = 0, own = 0;
  for (const r of records) {
    if (r.kind !== 'tokens' || r.agent !== agent || r.t < start || !windowCovers(agent, window, r.model)) continue;
    const w = tokenWeight(r);
    all += w;
    if ((r.user || ADMIN_ID) === user) own += w;
  }
  return { pct, mine: all > 0 ? (Number(pct) || 0) * own / all : 0 };
}

export function createUsers({ dataDir, usageLog = null, now = Date.now, agents = () => ['claude', 'codex'] }) {
  const file = path.join(dataDir, 'users.json');
  let users = null, mtime = 0;
  // users.json is re-read when another process (set-password) rewrote it. An unreadable file is never overwritten.
  const read = () => {
    let m;
    try { m = fs.statSync(file).mtimeMs; } catch { if (!users) migrate(); return users; }
    if (users && m === mtime) return users;
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(v)) throw new Error('not a list');
      users = v; mtime = m;
    } catch (e) { console.error(`[users] ${file} unreadable: ${e.message}`); }
    return users || [];
  };
  const save = () => {
    fs.writeFileSync(file + '.tmp', JSON.stringify(users, null, 2), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    mtime = fs.statSync(file).mtimeMs;
  };
  function migrate() {
    let auth = null;
    try { auth = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8')); } catch {}
    users = [{ id: ADMIN_ID, name: 'admin', role: 'admin', aliases: ['claude'], ...(auth?.salt && { salt: auth.salt, hash: auth.hash }), caps: {}, createdAt: now() }];
    if (auth?.salt) save(); // no password yet (a fresh install): set-password writes it
  }
  const get = (id) => read().find((u) => u.id === id) || null;
  const byName = (name) => {
    const n = String(name || '').trim().toLowerCase();
    return read().find((u) => u.name === n) || read().find((u) => (u.aliases || []).includes(n)) || null;
  };
  // Sign-in: a blank name is the admin (the old password-only form still posts none).
  const check = (name, pw) => { const u = String(name || '').trim() ? byName(name) : get(ADMIN_ID); return u && passwordOk(u, pw) ? u : null; };
  const view = (u) => u && { id: u.id, name: u.name, role: u.role, caps: u.caps || {}, createdAt: u.createdAt || null };
  const fail = (status, error) => Object.assign(new Error(error), { status });
  const admins = () => read().filter((u) => u.role === 'admin');
  function cleanCaps(caps) {
    if (caps == null) return {};
    if (typeof caps !== 'object' || Array.isArray(caps)) throw fail(400, 'caps must be an object of {"agent/window": percent}');
    const out = {};
    for (const [k, v] of Object.entries(caps)) {
      const [agent, ...rest] = k.split('/'), window = rest.join('/');
      if (!agents().includes(agent) || !window || !isWeekly(window)) throw fail(400, `Not a weekly window: ${k}`);
      if (v == null || v === '') continue; // no cap
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw fail(400, `${k}: a cap is a percent from 0 to 100`);
      out[k] = Math.round(n * 10) / 10;
    }
    return out;
  }
  function add({ name, password, role = 'user', caps } = {}) {
    const n = String(name || '').trim().toLowerCase();
    if (!NAME_RE.test(n)) throw fail(400, 'Username: 1–32 lowercase letters, digits, . _ or -');
    if (byName(n)) throw fail(409, 'That username is taken');
    if (String(password || '').length < 8) throw fail(400, 'Password: at least 8 characters');
    if (!['admin', 'user'].includes(role)) throw fail(400, 'role must be admin or user');
    const u = { id: crypto.randomBytes(6).toString('hex'), name: n, role, ...hashPassword(password), caps: role === 'admin' ? {} : cleanCaps(caps), createdAt: now() };
    read().push(u); save();
    return view(u);
  }
  function update(id, patch = {}) {
    const u = get(id);
    if (!u) throw fail(404, 'No such user');
    if (patch.password != null) {
      if (String(patch.password).length < 8) throw fail(400, 'Password: at least 8 characters');
      Object.assign(u, hashPassword(patch.password));
    }
    if (patch.role != null && patch.role !== u.role) {
      if (!['admin', 'user'].includes(patch.role)) throw fail(400, 'role must be admin or user');
      if (u.role === 'admin' && admins().length < 2) throw fail(409, 'Keep at least one admin');
      u.role = patch.role;
    }
    if (patch.caps !== undefined) u.caps = cleanCaps(patch.caps);
    if (u.role === 'admin') u.caps = {}; // admins are never capped
    save();
    return view(u);
  }
  function remove(id) {
    const u = get(id);
    if (!u) throw fail(404, 'No such user');
    if (u.role === 'admin' && admins().length < 2) throw fail(409, 'Keep at least one admin');
    users = read().filter((x) => x.id !== id); save();
  }
  // Every weekly window the CLIs report now, with this user's estimated share and cap:
  // [{agent, window, pct, mine, cap, resetsAt}]
  function usage(id) {
    const u = get(id);
    if (!u || !usageLog) return [];
    const records = usageLog.tokensSince?.(now() - WEEK_MS) || [];
    return agents().flatMap((agent) => (usageLog.current(agent) || []).filter((w) => isWeekly(w.window)).map((w) => {
      const s = shareOf(records, { user: u.id, agent, window: w.window, pct: w.pct, resetsAt: w.resetsAt }, now());
      return { agent, window: w.window, label: windowName(agent, w.window), pct: w.pct, mine: Math.round(s.mine * 10) / 10, cap: u.caps?.[`${agent}/${w.window}`] ?? null, resetsAt: w.resetsAt ?? null };
    }));
  }
  // The cap this user has reached for a turn on agent/model, or null: {agent, window, cap, mine, resetsAt}.
  function capBlock(id, agent, model) {
    const u = get(id);
    if (!u || u.role === 'admin' || !Object.keys(u.caps || {}).length) return null;
    for (const w of usage(id)) {
      if (w.agent !== agent || w.cap == null || !windowCovers(agent, w.window, model)) continue;
      if (w.mine >= w.cap) return { agent, window: w.window, label: w.label, cap: w.cap, mine: w.mine, resetsAt: w.resetsAt };
    }
    return null;
  }
  // set-password (the admin's, from the CLI).
  function setAdminPassword(pw) { const u = get(ADMIN_ID) || admins()[0]; Object.assign(u, hashPassword(pw)); save(); }
  return { list: () => read().map(view), get, byName, check, add, update, remove, view, usage, capBlock, setAdminPassword, hasPassword: () => read().some((u) => u.hash) };
}
