#!/usr/bin/env node
// The approval gate's MCP proxy (gate.mjs): `node gate-proxy.mjs --config <file>` speaks stdio MCP to the agent CLI and
// runs the real server (the Playwright MCP, or a connector) as its child. Every tools/call is classified first (element
// targets resolved in a fresh accessibility snapshot); an outbound one is held (approvals/<id>.json in the run's gate dir,
// with a screenshot) until the host answers, and a denial goes back to the agent as a tool error, the call never made.
// Calls run one at a time, in order, so nothing slips past a held one. Every call is appended to <dir>/audit.jsonl.
// Config (JSON, 0600, written by extensions.mjs mcpFor): {dir, server, kind: 'browser'|'connector', upstream: {command,
// args, env}, patterns, connector: {outbound, read, draft}, ttlMs, task, hook (serve the Claude hook's checks/), snapshotMs}.
// A page that can't be read (the snapshot errors or times out) makes element tools, key presses and dialogs outbound.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { APPROVAL_TTL_MS, DEFAULT_PATTERNS, appendAudit, ask, callKey, classify, denialText, isBrowserRead, newId, parseSnapshot,
  redactCall, resultText, serve, verdict } from './gate.mjs';

const cfg = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--config') + 1], 'utf8'));
const { dir, server = 'mcp', kind = 'browser', task = null } = cfg;
const patterns = cfg.patterns?.length ? cfg.patterns : DEFAULT_PATTERNS, ttlMs = cfg.ttlMs || APPROVAL_TTL_MS, snapshotMs = cfg.snapshotMs || 60_000;
const auditFile = path.join(dir, 'audit.jsonl');

const up = spawn(cfg.upstream.command, cfg.upstream.args || [], { env: { ...process.env, ...(cfg.upstream.env || {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
up.on('error', (e) => { process.stderr.write(`[gate] ${server}: ${e.message}\n`); process.exit(1); });
up.on('exit', (code) => process.exit(code ?? 1));
process.stdin.on('end', () => up.stdin.end());
process.on('SIGTERM', () => { up.kill('SIGTERM'); });

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
const toUp = (m) => up.stdin.write(`${JSON.stringify(m)}\n`);

// Upstream responses: to the proxy's own calls (snapshot, screenshot), to forwarded tools/calls, or anything else.
const own = new Map(), waiting = new Map();
let seq = 0;
function callUp(name, args = {}, ms = 60_000) {
  const id = `agent-orch-gate-${++seq}`;
  return new Promise((resolve) => {
    const t = setTimeout(() => { own.delete(id); resolve(null); }, ms);
    own.set(id, (m) => { clearTimeout(t); resolve(m); });
    toUp({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  });
}
lines(up.stdout, (m) => {
  if (m.id != null && m.method == null) {
    if (own.has(m.id)) { const f = own.get(m.id); own.delete(m.id); return f(m); }
    if (waiting.has(m.id)) { const f = waiting.get(m.id); waiting.delete(m.id); return f(m); }
  }
  toClient(m);
});

let chain = Promise.resolve();
const enqueue = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
lines(process.stdin, (m) => {
  if (m.method === 'tools/call' && m.id != null) enqueue(() => handle(m)).catch((e) => toClient({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: `gate: ${e?.message || e}` } }));
  else toUp(m);
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
  const resp = await new Promise((resolve) => { waiting.set(m.id, resolve); toUp(m); });
  const shot = r.shot || saveImage(imageOf(resp.result));
  const text = resp.error ? resp.error.message : resultText(resp.result);
  audit({ ...r, shot }, tool, { ok: !resp.error && !resp.result?.isError, result: String(text || '').replace(/\s+/g, ' ').slice(0, 300), ms: Date.now() - t0 });
  toClient(resp);
}
