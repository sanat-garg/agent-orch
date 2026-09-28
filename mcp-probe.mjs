// Probes one MCP server as extensions.mjs stores it ({name, type: 'stdio'|'http'|'sse', command, args, env, url, headers}):
// `initialize`, `notifications/initialized`, then `tools/list` (following nextCursor), over stdio or streamable HTTP.
//   probeMcp(server, {timeoutMs, env}) → {ok: true, serverInfo, protocolVersion, tools: [{name, description}], ms}
//                                       | {ok: false, error, ms}   (one line, ≤ 300 chars; stdio adds its last stderr line)
// Never rejects. A stdio server runs through helpers.mjs spawnHelper and its process group is gone before this settles.
// SSE-only servers (the deprecated HTTP+SSE transport) are not probed yet.
import { spawnHelper, killGroup, KILL_GRACE_MS } from './helpers.mjs';

const PROTOCOL = '2025-06-18';
const CLIENT = { name: 'agent-orch', version: 'probe' };
const MAX_PAGES = 20;
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

export async function probeMcp(server, { timeoutMs = 15000, env = process.env } = {}) {
  const t0 = Date.now();
  let r;
  try {
    if (server?.type === 'sse') r = { ok: false, error: 'SSE servers cannot be probed yet' };
    else if (server?.type === 'http') r = await probeHttp(server, timeoutMs);
    else if (server?.type === 'stdio' || (!server?.type && server?.command)) r = await probeStdio(server, timeoutMs, env);
    else r = { ok: false, error: `unknown MCP server type ${JSON.stringify(server?.type ?? null)}` };
  } catch (e) { r = { ok: false, error: e?.message || String(e) }; }
  if (!r.ok) r.error = oneLine(r.error) || 'probe failed';
  return { ...r, ms: Date.now() - t0 };
}

// The shared handshake over rpc(method, params) → result and notify(method).
async function handshake(rpc, notify) {
  const init = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
  if (!init || typeof init !== 'object') throw new Error('initialize answered without a result');
  await notify('notifications/initialized', init.protocolVersion);
  const tools = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await rpc('tools/list', cursor ? { cursor } : {});
    if (!Array.isArray(res?.tools)) throw new Error('tools/list answered without a tools array');
    for (const t of res.tools) tools.push({ name: String(t?.name ?? ''), description: String(t?.description ?? '') });
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return { ok: true, serverInfo: init.serverInfo ?? null, protocolVersion: init.protocolVersion ?? null, tools };
}
const rpcError = (method, err) => new Error(`${method} failed: ${err?.message || JSON.stringify(err)}${err?.code != null ? ` (${err.code})` : ''}`);

function probeStdio(server, timeoutMs, baseEnv) {
  return new Promise((resolve) => {
    let child, done = false, lastErr = '', buf = '', nextId = 1, timer, hard, result;
    const pending = new Map();
    const withStderr = (msg) => lastErr ? `${msg}: ${lastErr}` : msg;
    // Settle only once the process group is gone (or the grace has run out), so nothing outlives the probe.
    const finish = (r) => {
      if (done) return;
      done = true;
      result = r;
      clearTimeout(timer);
      for (const p of pending.values()) p.reject(new Error('probe ended'));
      pending.clear();
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return settle();
      try { child.stdin.end(); } catch {}
      killGroup(child.pid);
      hard = setTimeout(settle, KILL_GRACE_MS + 500);
    };
    const settle = () => { clearTimeout(hard); resolve(result); };
    const fail = (msg) => finish({ ok: false, error: withStderr(msg) });
    try {
      child = spawnHelper(server.command, (server.args || []).map(String), {
        env: { ...baseEnv, ...(server.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) { return resolve({ ok: false, error: `cannot start ${server.command}: ${e.message}` }); }
    child.on('error', (e) => fail(e.code === 'ENOENT' ? `cannot start ${server.command}: command not found (${e.message})` : `cannot start ${server.command}: ${e.message}`));
    // 'close' comes after the last stdout/stderr chunk (spawnHelper kills the group's leftovers on exit).
    child.on('close', (code, sig) => (done ? settle() : fail(`${server.command} exited (${sig || `code ${code}`}) before answering`)));
    child.stdin.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      const lines = d.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length) lastErr = lines.at(-1).slice(0, 200);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { return fail(`malformed JSON from ${server.command}: ${line.slice(0, 80)}`); }
        if (m?.method && m.id != null) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
        else if (m?.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p.settle(m); }
      }
    });
    const send = (msg) => { if (!done) child.stdin.write(`${JSON.stringify(msg)}\n`); };
    const rpc = (method, params) => new Promise((ok, reject) => {
      const id = nextId++;
      pending.set(id, { reject, settle: (m) => (m.error ? reject(rpcError(method, m.error)) : ok(m.result)) });
      send({ jsonrpc: '2.0', id, method, params });
    });
    const notify = async (method) => send({ jsonrpc: '2.0', method });
    timer = setTimeout(() => fail(`timed out after ${timeoutMs} ms waiting for ${server.command}`), timeoutMs);
    handshake(rpc, notify).then(finish, (e) => { if (!done) fail(e.message); });
  });
}

async function probeHttp(server, timeoutMs) {
  let url;
  try { url = new URL(server.url); } catch { return { ok: false, error: `invalid URL ${server.url}` }; }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let session = null, version = null, nextId = 1;
  const headers = () => {
    const h = new Headers(server.headers || {});
    h.set('content-type', 'application/json');
    h.set('accept', 'application/json, text/event-stream');
    if (session) h.set('mcp-session-id', session);
    if (version) h.set('mcp-protocol-version', version);
    return h;
  };
  const post = async (msg) => {
    const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(msg), signal: ac.signal });
    session = res.headers.get('mcp-session-id') || session;
    if (res.status >= 400) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} from ${url.origin}${body.trim() ? `: ${body.trim().slice(0, 150)}` : ''}`);
    }
    return res;
  };
  const rpc = async (method, params) => {
    const id = nextId++;
    const res = await post({ jsonrpc: '2.0', id, method, params });
    const m = /text\/event-stream/i.test(res.headers.get('content-type') || '') ? await fromEvents(res, id) : fromJson(await res.text(), id);
    if (!m) throw new Error(`${method}: no answer in the response`);
    if (m.error) throw rpcError(method, m.error);
    if (method === 'initialize') version = m.result?.protocolVersion || PROTOCOL;
    return m.result;
  };
  const notify = async (method) => { const res = await post({ jsonrpc: '2.0', method }); await res.body?.cancel().catch(() => {}); };
  try {
    return await handshake(rpc, notify);
  } catch (e) {
    return { ok: false, error: ac.signal.aborted ? `timed out after ${timeoutMs} ms waiting for ${url.origin}` : e?.cause?.message ? `${e.message}: ${e.cause.message}` : e.message };
  } finally {
    clearTimeout(timer);
    // Best effort: end the session so the server can drop it.
    if (session) fetch(url, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(2000) }).then((r) => r.body?.cancel(), () => {}).catch(() => {});
  }
}

function fromJson(text, id) {
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`malformed JSON in the response: ${text.trim().slice(0, 80)}`); }
  return (Array.isArray(body) ? body : [body]).find((m) => m?.id === id) || null;
}

// Reads SSE events until the one answering `id`; the stream may stay open after it.
async function fromEvents(res, id) {
  const dec = new TextDecoder();
  let buf = '', data = [];
  const reader = res.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      buf += done ? dec.decode() + '\n\n' : dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) { data.push(line.slice(5).replace(/^ /, '')); continue; }
        if (line || !data.length) continue;
        const text = data.join('\n');
        data = [];
        let m;
        try { m = JSON.parse(text); } catch { throw new Error(`malformed JSON in the event stream: ${text.slice(0, 80)}`); }
        const hit = (Array.isArray(m) ? m : [m]).find((x) => x?.id === id);
        if (hit) return hit;
      }
      if (done) return null;
    }
  } finally { reader.cancel().catch(() => {}); }
}
