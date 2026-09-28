#!/usr/bin/env node
// The approval gate's MCP proxy (gate.mjs): `node gate-proxy.mjs --config <file>` speaks stdio MCP to the agent CLI and
// runs the real server (the Playwright MCP, or a connector) as its child. Every tools/call is classified first (element
// targets resolved in a fresh accessibility snapshot); an outbound one is held (approvals/<id>.json in the run's gate dir,
// with a screenshot) until the host answers, and a denial goes back to the agent as a tool error, the call never made.
// Calls run one at a time, in order, so nothing slips past a held one. Every call is appended to <dir>/audit.jsonl.
// Config (JSON, 0600, written by extensions.mjs mcpFor): {dir, server, kind: 'browser'|'connector', upstream: {command,
// args, env} (a stdio child) or {url, headers} (MCP streamable http, below), patterns, connector: {outbound, read, draft},
// ttlMs, task, hook (serve the Claude hook's checks/), snapshotMs,
// callMs (a forwarded call unanswered this long becomes a tool error, its late answer dropped; default 5 min, at least 2 s)}.
// Over http every message is a POST (with Mcp-Session-Id once initialize returned one); the answer is a JSON body (one
// message or a batch) or an SSE stream of them, dispatched exactly like the child's stdout. A failed POST (non-2xx, network
// error, or no answer to a request) becomes a JSON-RPC error `gate: <server> http <status/err>` for that request.
// A page that can't be read (the snapshot errors or times out) makes element tools, key presses and dialogs outbound.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { APPROVAL_TTL_MS, DEFAULT_PATTERNS, appendAudit, ask, callKey, classify, denialText, isBrowserRead, newId, parseSnapshot,
  redactCall, resultText, serve, verdict } from './gate.mjs';

const cfg = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--config') + 1], 'utf8'));
const { dir, server = 'mcp', kind = 'browser', task = null } = cfg;
const patterns = cfg.patterns?.length ? cfg.patterns : DEFAULT_PATTERNS, ttlMs = cfg.ttlMs || APPROVAL_TTL_MS, snapshotMs = cfg.snapshotMs || 60_000;
const callMs = Math.max(2_000, cfg.callMs || 5 * 60_000);
const auditFile = path.join(dir, 'audit.jsonl');

function lines(stream, fn) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!l.trim()) continue;
      let m; try { m = JSON.parse(l); } catch { continue; }
      fn(m);
    }
  });
}
const toClient = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

// The real server: a child over stdio, or an MCP streamable http endpoint. Either feeds what it answers to onMessage.
function stdioUpstream(u, onMessage) {
  const up = spawn(u.command, u.args || [], { env: { ...process.env, ...(u.env || {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
  up.on('error', (e) => { process.stderr.write(`[gate] ${server}: ${e.message}\n`); process.exit(1); });
  up.on('exit', (code) => process.exit(code ?? 1));
  process.on('SIGTERM', () => { up.kill('SIGTERM'); });
  lines(up.stdout, onMessage);
  return { send: (m) => up.stdin.write(`${JSON.stringify(m)}\n`), close: () => up.stdin.end() };
}
function httpUpstream(u, onMessage) {
  const url = new URL(u.url), mod = url.protocol === 'https:' ? https : http;
  let session = null, version = null, inflight = 0, closing = false, ready = Promise.resolve();
  const isRequest = (m) => m.id != null && m.method != null;
  const fail = (m, err) => {
    const message = `gate: ${server} http ${err}`;
    if (isRequest(m)) onMessage({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message } });
    else process.stderr.write(`[gate] ${message}\n`);
  };
  const post = (m) => new Promise((resolve) => {
    const body = JSON.stringify(m);
    let answered = false, settled = false;
    const got = (x) => {
      if (!x || typeof x !== 'object') return;
      if (x.id != null && x.id === m.id && x.method == null) {
        answered = true;
        if (m.method === 'initialize' && typeof x.result?.protocolVersion === 'string') version = x.result.protocolVersion;
      }
      onMessage(x);
    };
    const end = (err) => {
      if (settled) return;
      settled = true;
      if (err != null) fail(m, err);
      else if (isRequest(m) && !answered) fail(m, 'no answer');
      resolve();
    };
    const parse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
    const req = mod.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(u.headers || {}), ...(session && { 'Mcp-Session-Id': session }), ...(version && { 'MCP-Protocol-Version': version }),
      'Content-Length': Buffer.byteLength(body) } }, (res) => {
      res.on('error', (e) => end(e.message));
      if (res.statusCode < 200 || res.statusCode > 299) { res.resume(); return end(res.statusCode); }
      if (m.method === 'initialize' && res.headers['mcp-session-id']) session = String(res.headers['mcp-session-id']);
      res.setEncoding('utf8');
      let buf = '';
      if (/text\/event-stream/i.test(String(res.headers['content-type'] || ''))) {
        // SSE: `data:` lines make up an event, a blank line ends it; each event's data is one message (or a batch).
        let data = [];
        const flush = () => { if (data.length) { const x = parse(data.join('\n')); data = []; for (const y of [].concat(x ?? [])) got(y); } };
        const line = (l) => { if (l.endsWith('\r')) l = l.slice(0, -1); if (!l) flush(); else if (l.startsWith('data:')) data.push(l.slice(5).replace(/^ /, '')); };
        res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } });
        res.on('end', () => { if (buf) line(buf); flush(); end(); });
      } else {
        res.on('data', (d) => { buf += d; });
        res.on('end', () => {
          if (!buf.trim()) return end();
          const x = parse(buf);
          if (x === undefined) return end('bad json');
          for (const y of [].concat(x)) got(y);
          end();
        });
      }
    });
    req.on('error', (e) => end(e.message));
    req.end(body);
  });
  const quit = () => process.stdout.write('', () => process.exit(0));
  const done = () => { if (--inflight === 0 && closing) quit(); };
  return {
    // initialize goes first and alone, so every later POST carries the session id it returns.
    send(m) {
      inflight++;
      const p = ready.then(() => post(m));
      if (m.method === 'initialize') ready = p;
      p.then(done);
    },
    close() { closing = true; if (!inflight) quit(); },
  };
}

// Upstream responses: to the proxy's own calls (snapshot, screenshot), to forwarded tools/calls, or anything else.
// A forwarded call that timed out leaves its id in lateIds (the last 200), so its late answer is dropped, not sent twice.
const own = new Map(), waiting = new Map(), lateIds = new Set();
let seq = 0;
function callUp(name, args = {}, ms = 60_000) {
  const id = `agent-orch-gate-${++seq}`;
  return new Promise((resolve) => {
    const t = setTimeout(() => { own.delete(id); resolve(null); }, ms);
    own.set(id, (m) => { clearTimeout(t); resolve(m); });
    upstream.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  });
}
function fromUp(m) {
  if (m.id != null && m.method == null) {
    if (own.has(m.id)) { const f = own.get(m.id); own.delete(m.id); return f(m); }
    if (waiting.has(m.id)) { const f = waiting.get(m.id); waiting.delete(m.id); return f(m); }
    if (lateIds.delete(m.id)) return;
  }
  toClient(m);
}
const upstream = cfg.upstream.url ? httpUpstream(cfg.upstream, fromUp) : stdioUpstream(cfg.upstream, fromUp);
process.stdin.on('end', () => upstream.close());

let chain = Promise.resolve();
const enqueue = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
lines(process.stdin, (m) => {
  if (m.method === 'tools/call' && m.id != null) enqueue(() => handle(m)).catch((e) => toClient({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: `gate: ${e?.message || e}` } }));
  else upstream.send(m);
});

// A screenshot of the page (jpeg), saved as <dir>/shots/<sha256>.<ext>: its media id, or null.
function saveImage(img) {
  if (!img?.data) return null;
  const buf = Buffer.from(img.data, 'base64'), ext = /png/.test(img.mimeType || '') ? 'png' : /webp/.test(img.mimeType || '') ? 'webp' : 'jpg';
  const id = `${crypto.createHash('sha256').update(buf).digest('hex')}.${ext}`, f = path.join(dir, 'shots', id);
  try { if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, buf, { mode: 0o600 }); } } catch { return null; }
  return id;
}
const imageOf = (res) => (res?.content || []).find((c) => c?.type === 'image' && typeof c.data === 'string');
async function screenshot() {
  const r = await callUp('browser_take_screenshot', { type: 'jpeg' });
  return saveImage(imageOf(r?.result));
}

// Tools whose class depends on what is on the page: without a readable snapshot they can't be told apart from a Send.
const PAGE_TOOLS = new Set(['browser_click', 'browser_type', 'browser_select_option', 'browser_drag', 'browser_handle_dialog',
  'browser_press_key', 'browser_fill_form']);
const needsPage = (tool) => PAGE_TOOLS.has(tool) || /^browser_mouse_\w+_xy$/.test(tool);

// Classifies a call and, when outbound, holds it for the owner. → {allow, c (classify), args (redacted), approval?, v?, shot?}
async function check(tool, args) {
  let snap = null, readable = true;
  if (kind === 'browser' && !isBrowserRead(tool)) {
    const r = await callUp('browser_snapshot', {}, snapshotMs);
    snap = parseSnapshot(r ? resultText(r.result) || r.error?.message || '' : '');
    readable = !!r && !r.error && !r.result?.isError && (!!snap.url || snap.refs.size > 0);
  }
  let c = classify(tool, args, { server, kind, snapshot: snap, patterns, connector: cfg.connector });
  if (!readable && needsPage(tool)) c = { ...c, cls: 'outbound', reason: 'the page could not be read before this action' };
  const red = redactCall(tool, args, snap);
  if (c.cls !== 'outbound') return { allow: true, c, args: red };
  const shot = kind === 'browser' ? await screenshot() : null;
  const approval = { id: newId(), task, server, tool, cls: c.cls, reason: c.reason, action: c.action, key: c.key, url: c.url || snap?.url || null,
    ...(c.target && { target: c.target }), args: red, screenshot: shot, at: Date.now(), ttlMs };
  const v = verdict(await ask(dir, 'approvals', approval, { id: approval.id, timeoutMs: ttlMs + 5 * 60_000 }));
  return { allow: v.allow, c, args: red, approval, v, shot };
}
function audit(r, tool, extra) {
  try {
    appendAudit(auditFile, { ts: Date.now(), task, server, tool, class: r.c.cls, reason: r.c.reason, action: r.c.action, args: r.args,
      ...(r.approval && { approval: r.approval.id, decision: r.v.decision, ...(r.v.by && { by: r.v.by }), ...(r.v.reason && { note: r.v.reason }) }),
      ...(r.shot && { screenshot: r.shot }), ...extra });
  } catch (e) { process.stderr.write(`[gate] audit write failed: ${e.message}\n`); }
}
const denied = (r) => denialText(r.v, r.c.action);

// The Claude hook's pre-checks (agents.mjs): a call it let through has a ticket, so it isn't checked twice.
const tickets = new Map();
if (cfg.hook) {
  serve(dir, 'checks', (q) => enqueue(async () => {
    const r = await check(String(q.tool || ''), q.args || {});
    if (!r.allow) { audit(r, q.tool, { ok: false, result: 'not performed', via: 'hook' }); return { allow: false, reason: denied(r) }; }
    tickets.set(callKey(q.tool, q.args || {}), { r, at: Date.now() });
    return { allow: true, cls: r.c.cls };
  }));
}
function takeTicket(tool, args) {
  const k = callKey(tool, args), t = tickets.get(k);
  for (const [x, v] of tickets) if (Date.now() - v.at > 10 * 60_000) tickets.delete(x);
  if (!t) return null;
  tickets.delete(k);
  return t.r;
}

async function handle(m) {
  const tool = String(m.params?.name || ''), args = m.params?.arguments || {}, t0 = Date.now();
  const r = takeTicket(tool, args) || await check(tool, args);
  if (!r.allow) {
    audit(r, tool, { ok: false, result: 'not performed', ms: Date.now() - t0 });
    return toClient({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: denied(r) }], isError: true } });
  }
  let timer;
  const resp = await new Promise((resolve) => {
    timer = setTimeout(() => { waiting.delete(m.id); resolve(null); }, callMs);
    waiting.set(m.id, (x) => { clearTimeout(timer); resolve(x); });
    upstream.send(m);
  });
  if (!resp) {
    lateIds.add(m.id);
    if (lateIds.size > 200) lateIds.delete(lateIds.values().next().value);
    const s = Math.round(callMs / 1000);
    audit(r, tool, { ok: false, result: `timed out: ${server} did not answer within ${s} s`, ms: Date.now() - t0 });
    return toClient({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text',
      text: `gate: ${server} did not answer within ${s} s; the page may be stuck, take a snapshot before retrying` }], isError: true } });
  }
  const shot = r.shot || saveImage(imageOf(resp.result));
  const text = resp.error ? resp.error.message : resultText(resp.result);
  audit({ ...r, shot }, tool, { ok: !resp.error && !resp.result?.isError, result: String(text || '').replace(/\s+/g, ' ').slice(0, 300), ms: Date.now() - t0 });
  toClient(resp);
}
