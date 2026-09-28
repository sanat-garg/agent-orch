// Remote sign-in (BRIEF goal 11): the owner signs agents in on a worker machine from the controller's Connections
// window. The controller (createRemoteLogins) turns Connect / code / Cancel / Disconnect into login.* frames; the worker
// (createNodeLogins) runs the same connections.mjs login specs locally and streams login.state back. Status, account,
// models and limits per node come from the node's inventory.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { MSG } from './cluster-protocol.mjs';
import { AGENTS } from './agents.mjs';
import { healthRow, agentAccount } from './health.mjs';
import { SPECS, LOGIN_TIMEOUT, createConnections, onPath, ptyRunner, tmuxRunnerFor } from './connections.mjs';

export const WORKER_SOCKET = 'agent-orch-worker-login';
export const CONTROLLER_LABEL = 'Controller';
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'signed_out']);

// connections.mjs's login view → the wire state.
export function wireState(l) {
  if (l.state !== 'waiting') return l.state;
  if (l.url && l.needsPastedCode) return 'waiting_code';
  return l.url || l.code ? 'url' : 'starting';
}

// The sign-in runner for this machine: tmux when installed, else a `script` pty (macOS without Homebrew's tmux).
export function loginRunner({ env = process.env, platform = process.platform, log = () => {} } = {}) {
  if (onPath('tmux', env)) return tmuxRunnerFor(WORKER_SOCKET);
  log(platform === 'darwin' ? 'tmux not found (install it with `brew install tmux`); sign-ins use a `script` pty instead'
    : 'tmux not found; sign-ins use a `script` pty instead', 'warn');
  return ptyRunner({ platform });
}

// ---------------------------------------------------------------- worker side

// A spec whose absolute binary isn't there (claude outside ~/.local/bin, e.g. Homebrew) runs the one on PATH instead.
const localSpec = (spec) => (spec.start[0].includes('/') && !fs.existsSync(spec.start[0])
  ? { ...spec, start: [spec.start[0].split('/').pop(), ...spec.start.slice(1)], ...(spec.logout ? { logout: [spec.logout[0].split('/').pop(), ...spec.logout.slice(1)] } : {}) }
  : spec);

// send(t, fields): a worker frame. afterChange(agent): a sign-in or sign-out finished (re-check, rediscover, report).
// entries/tmux are injectable for tests; the connections are created on first use so nothing touches tmux before then.
export function createNodeLogins({ send, afterChange = () => {}, log = () => {}, entries, tmux, pollMs, env = process.env }) {
  const byAgent = new Map(); // agent -> the controller's login id
  const sent = new Map(); // login id -> last state signature
  let conns = null;
  const connections = () => conns ||= createConnections({
    entries: entries || Object.values(AGENTS).filter((a) => SPECS[a.id]).map((a) => ({
      id: a.id, label: a.label, installed: () => a.available(), signedIn: () => a.loggedIn(), account: () => agentAccount(a.id),
      envFilter: a.envFilter, spec: localSpec(SPECS[a.id]), afterChange: () => afterChange(a.id),
    })),
    env, tmux: tmux || loginRunner({ env, log }), ...(pollMs ? { pollMs } : {}), onChange: report,
  });

  function state(login, fields) {
    const f = Object.fromEntries(Object.entries({ login, ...fields }).filter(([, v]) => v != null && v !== ''));
    const sig = JSON.stringify(f);
    if (sent.get(login) === sig) return;
    sent.set(login, sig);
    if (TERMINAL.has(f.state)) sent.delete(login);
    send(MSG.LOGIN_STATE, f);
  }
  function report(list) {
    for (const c of list) {
      const login = byAgent.get(c.id);
      if (!login || !c.login) continue;
      const l = c.login, st = wireState(l);
      state(login, { state: st, url: l.url, code: l.code, prompt: l.prompt, message: l.error, account: st === 'done' ? c.account : null });
      if (TERMINAL.has(st)) byAgent.delete(c.id);
    }
  }
  const agentOf = (login) => [...byAgent].find(([, id]) => id === login)?.[0];

  async function handle(msg) {
    switch (msg.t) {
      case MSG.LOGIN_START: {
        const prev = byAgent.get(msg.agent);
        if (prev && prev !== msg.login) sent.delete(prev);
        byAgent.set(msg.agent, msg.login);
        state(msg.login, { state: 'starting' });
        const r = await connections().start(msg.agent);
        if (r.error) { byAgent.delete(msg.agent); return state(msg.login, { state: 'failed', message: r.error }); }
        return report(connections().list());
      }
      case MSG.LOGIN_CODE: {
        const agent = agentOf(msg.login);
        if (!agent) return state(msg.login, { state: 'failed', message: 'No sign-in in progress on this machine' });
        const r = await connections().submitCode(agent, msg.code);
        if (r.error) send(MSG.LOGIN_STATE, { login: msg.login, state: 'waiting_code', message: r.error });
        return;
      }
      case MSG.LOGIN_CANCEL: {
        const agent = agentOf(msg.login);
        if (agent) await connections().cancel(agent);
        byAgent.delete(agent);
        return state(msg.login, { state: 'cancelled' });
      }
      case MSG.LOGIN_LOGOUT: {
        // The owner confirmed on the controller (it shows the warning), so confirm here.
        const r = await connections().logout(msg.agent, { confirm: true });
        return state(msg.login, r.error ? { state: 'failed', message: r.error } : { state: 'signed_out' });
      }
      default:
    }
  }
  return { handle, active: () => !!conns?.active() };
}

// ---------------------------------------------------------------- controller side

const sameAccount = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

// cluster: createCluster's hub. local(): the controller's own connections.list() rows (for the shared-account note).
// onChange(nodeId): a remote login changed (the server pushes that node's rows).
export function createRemoteLogins({ cluster, local = () => [], onChange = () => {}, timeoutMs = LOGIN_TIMEOUT + 30_000, logoutWaitMs = 20_000 }) {
  const logins = new Map(); // `${node}:${agent}` -> login
  const byId = new Map(); // login id -> login
  const waiters = new Map(); // login id -> resolve (sign-outs)
  const key = (node, agent) => `${node}:${agent}`;
  const changed = (node) => { try { onChange(node); } catch {} };
  const view = (l) => l && { state: l.state, url: l.url, code: l.code, needsPastedCode: l.needsPastedCode, error: l.error,
    ...(l.prompt ? { prompt: l.prompt } : {}), startedAt: l.startedAt };

  function end(l, state, error = null) {
    if (l.state !== 'waiting') return;
    Object.assign(l, { state, error });
    clearTimeout(l.deadline);
    changed(l.node);
  }

  const off = cluster.onMessage((node, msg) => {
    if (msg.t !== MSG.LOGIN_STATE) return;
    const w = waiters.get(msg.login);
    if (w) { waiters.delete(msg.login); return w(msg); }
    const l = byId.get(msg.login);
    if (!l || l.node !== node || l.state !== 'waiting') return;
    if (TERMINAL.has(msg.state)) return end(l, msg.state === 'signed_out' ? 'done' : msg.state, msg.state === 'failed' ? msg.message || 'sign-in failed' : null);
    Object.assign(l, { url: msg.url || null, code: msg.code || null, prompt: msg.prompt || null, error: null,
      needsPastedCode: msg.state === 'waiting_code' || l.needsPastedCode });
    changed(node);
  });

  // Every machine (by display name) where `agent` is signed in with `account`, except `node`.
  function sharedWith(node, agent, account) {
    if (!account) return [];
    const out = [];
    if (node !== 'controller' && local().some((c) => c.id === agent && c.signedIn && sameAccount(c.account, account))) out.push(CONTROLLER_LABEL);
    for (const n of cluster.listNodes()) {
      if (n.local || n.id === node) continue;
      if ((n.inventory?.agents || []).some((a) => a.id === agent && a.signedIn && sameAccount(a.account, account))) out.push(n.name);
    }
    return out;
  }
  // The controller's own rows with the shared-account note.
  const annotate = (rows) => rows.map((c) => (c.signedIn && AGENTS[c.id] ? { ...c, sharedWith: sharedWith('controller', c.id, c.account) } : c));

  // One node's Connections rows, shaped like connections.list() so the same UI renders them.
  function list(node) {
    const n = cluster.node(node);
    if (!n || n.local) return null;
    const inv = n.inventory || {};
    return (inv.agents || []).filter((a) => AGENTS[a.id]).map((a) => {
      const l = logins.get(key(node, a.id));
      if (l?.state === 'waiting' && !n.connected) end(l, 'failed', `${n.name} went offline`);
      const installed = !!a.installed, signedIn = installed && !!a.signedIn, account = signedIn ? a.account || null : null;
      const spec = SPECS[a.id];
      // shared: signed in with the head's own sign-in (agent-share.mjs), so there is nothing to sign in or out here.
      // Unshared, the row says where to share it; signing this machine in to an account of its own still works (more quota).
      const shared = signedIn && !!a.shared;
      const ui = shared ? { on: 'From the head: nothing to sign in on this machine' }
        : { off: a.id === 'claude' ? 'Not shared yet: on this server, Connections → Claude for your machines → Share with machines'
          : 'Sign in to Codex on this server: machines get it automatically' };
      return {
        id: a.id, label: AGENTS[a.id].label, installed, signedIn, account, node, connected: n.connected, shared, ui,
        canLogin: !!spec && n.connected && !shared, canLogout: !!spec?.logout && n.connected && !shared,
        ...(spec?.logoutWarning ? { logoutWarning: `Tasks placed on ${n.name} with ${AGENTS[a.id].label} stop until it is signed in again.` } : {}),
        health: healthRow(a.id, { installed, signedIn, account, version: a.version || null,
          models: { models: a.models || [], error: a.modelsError || null, at: null }, limits: inv.limits?.[a.id] }),
        sharedWith: signedIn ? sharedWith(node, a.id, account) : [],
        login: view(l) || null,
      };
    });
  }

  const needNode = (node, agent) => {
    const n = cluster.node(node);
    if (!n || n.local) return { status: 404, error: 'No such machine' };
    if (!AGENTS[agent] || !SPECS[agent]) return { status: 404, error: 'No such connection' };
    if (!n.connected) return { status: 409, error: `${n.name} is offline` };
    return { n };
  };

  function start(node, agent) {
    const { n, ...err } = needNode(node, agent);
    if (!n) return err;
    const cur = logins.get(key(node, agent));
    if (cur?.state === 'waiting') return { status: 200, login: view(cur) };
    const l = { id: `l_${crypto.randomBytes(6).toString('hex')}`, node, agent, state: 'waiting', url: null, code: null, prompt: null,
      needsPastedCode: !!SPECS[agent].needsPastedCode, error: null, startedAt: Date.now() };
    if (!cluster.send(node, { t: MSG.LOGIN_START, login: l.id, agent })) return { status: 409, error: `${n.name} is not connected` };
    if (cur) byId.delete(cur.id);
    logins.set(key(node, agent), l);
    byId.set(l.id, l);
    l.deadline = setTimeout(() => end(l, 'failed', 'timed out'), timeoutMs);
    l.deadline.unref?.();
    changed(node);
    return { status: 200, login: view(l) };
  }

  function submitCode(node, agent, code) {
    const l = logins.get(key(node, agent));
    if (!l || l.state !== 'waiting') return { status: 409, error: 'No sign-in in progress' };
    code = String(code || '').trim();
    if (!code || code.length > 4096 || /[\r\n]/.test(code)) return { status: 400, error: 'Invalid code' };
    if (!cluster.send(node, { t: MSG.LOGIN_CODE, login: l.id, code })) return { status: 409, error: 'the machine is not connected' };
    return { status: 200, login: view(l) };
  }

  function cancel(node, agent) {
    const l = logins.get(key(node, agent));
    if (!l) return { status: 200, ok: true, login: null };
    cluster.send(node, { t: MSG.LOGIN_CANCEL, login: l.id });
    end(l, 'cancelled');
    return { status: 200, ok: true, login: view(l) };
  }

  async function logout(node, agent, { confirm = false } = {}) {
    const { n, ...err } = needNode(node, agent);
    if (!n) return err;
    const warning = `Tasks placed on ${n.name} with ${AGENTS[agent].label} stop until it is signed in again.`;
    if (SPECS[agent].logoutWarning && confirm !== true) return { status: 409, error: warning, needsConfirm: true };
    const id = `l_${crypto.randomBytes(6).toString('hex')}`;
    const reply = new Promise((resolve) => {
      waiters.set(id, resolve);
      setTimeout(() => { if (waiters.delete(id)) resolve(null); }, logoutWaitMs).unref?.();
    });
    if (!cluster.send(node, { t: MSG.LOGIN_LOGOUT, login: id, agent })) { waiters.delete(id); return { status: 409, error: `${n.name} is not connected` }; }
    const r = await reply;
    changed(node);
    if (!r) return { status: 504, error: `${n.name} did not answer` };
    return r.state === 'signed_out' ? { status: 200, ok: true } : { status: 500, error: r.message || 'sign-out failed' };
  }

  // The Connections Refresh for a node: rediscover the models of its signed-in agents (the worker re-sends inventory).
  function refresh(node) {
    const n = cluster.node(node);
    if (!n || n.local) return { status: 404, error: 'No such machine' };
    for (const a of n.inventory?.agents || []) if (a.signedIn && AGENTS[a.id]) cluster.send(node, { t: MSG.MODELS_REFRESH, agent: a.id });
    return { status: 200, connections: list(node) };
  }

  return { list, annotate, sharedWith, start, submitCode, cancel, logout, refresh, close: () => { off(); for (const l of byId.values()) clearTimeout(l.deadline); } };
}
