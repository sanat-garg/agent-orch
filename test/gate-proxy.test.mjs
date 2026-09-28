// gate-proxy.mjs against the fake Playwright MCP: a page whose snapshot errors or never answers can't show what an element
// is, so element tools are held for the owner instead of passing as draft; a readable page behaves as before, and a call
// the Claude hook already checked (a ticket) is not snapshotted twice. A forwarded call the server never answers becomes a
// tool error after callMs, so the calls after it still run.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { answer, ask, readAudit } from '../gate.mjs';
import { waitFor } from './helpers/wait.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(root, 'test/fixtures/fake-browser-mcp.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-proxy-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A minimal MCP client over a server record {command, args, env}.
function mcp(s, env = process.env) {
  const child = spawn(s.command, s.args || [], { env: { ...env, ...(s.env || {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 0;
  const waits = new Map();
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waits.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise((r) => { const n = ++id; waits.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  return { init: () => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }),
    call: async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result, close: () => { child.stdin.end(); child.kill(); } };
}
const txt = (r) => (r?.content || []).map((c) => c.text || '').join('\n');
const calls = (log) => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).name); } catch { return []; } };

// A proxy in front of the fixture, its config written the way extensions.mjs gated() writes it.
function proxy(name, { snapshot, snapshotMs, hook = false, hang, callMs } = {}) {
  const dir = path.join(tmp, name), log = path.join(tmp, `${name}.calls.jsonl`), cfg = path.join(dir, 'proxy-playwright.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ dir, server: 'playwright', kind: 'browser', task: null, patterns: undefined, ttlMs: 60_000, hook,
    ...(snapshotMs && { snapshotMs }), ...(callMs && { callMs }),
    upstream: { command: process.execPath, args: [FAKE], env: { FAKE_MCP_LOG: log, ...(snapshot && { FAKE_MCP_SNAPSHOT: snapshot }), ...(hang && { FAKE_MCP_HANG: hang }) } } }));
  const c = mcp({ command: process.execPath, args: [path.join(root, 'gate-proxy.mjs'), '--config', cfg] });
  const box = path.join(dir, 'approvals');
  const pending = () => { try { return fs.readdirSync(box).filter((n) => /^[\w-]+\.json$/.test(n) && !n.includes('answer') && !fs.existsSync(path.join(box, n.replace('.json', '.answer.json')))); } catch { return []; } };
  const approval = (n) => JSON.parse(fs.readFileSync(path.join(box, n), 'utf8'));
  return { c, dir, log, pending, approval };
}
const SEND = { target: 'e3', element: 'the blue button' };

test('snapshot errors: navigation passes, an element click is held until approved and never runs when denied', async () => {
  const p = proxy('error', { snapshot: 'error' });
  try {
    await p.c.init();
    assert.match(txt(await p.c.call('browser_navigate', { url: 'https://mail.example.com/' })), /Compose/, 'navigation is forwarded');
    // Deny: the click never reaches the browser and the agent gets a tool error.
    const denied = p.c.call('browser_click', SEND);
    await waitFor(() => p.pending().length === 1, { timeout: 10000 });
    const a = p.approval(p.pending()[0]);
    assert.equal(a.cls, 'outbound');
    assert.equal(a.reason, 'the page could not be read before this action');
    assert.equal(a.tool, 'browser_click');
    assert.ok(!calls(p.log).includes('browser_click'), 'held, not forwarded');
    answer(p.dir, 'approvals', a.id, { decision: 'deny', reason: 'no' });
    const d = await denied;
    assert.equal(d.isError, true);
    assert.match(txt(d), /denied this action.*It was NOT performed/s);
    assert.ok(!calls(p.log).includes('browser_click'), 'the denied click never ran');
    // Approve: only then does the click run.
    const ok = p.c.call('browser_click', SEND);
    await waitFor(() => p.pending().length === 1, { timeout: 10000 });
    assert.ok(!calls(p.log).includes('browser_click'));
    answer(p.dir, 'approvals', p.approval(p.pending()[0]).id, { decision: 'approve' });
    assert.match(txt(await ok), /Sent!/);
    assert.equal(calls(p.log).filter((n) => n === 'browser_click').length, 1);
    const clicks = readAudit(path.join(p.dir, 'audit.jsonl')).filter((e) => e.tool === 'browser_click');
    assert.deepEqual(clicks.map((e) => [e.class, e.reason, e.decision, e.ok]), [
      ['outbound', 'the page could not be read before this action', 'deny', false],
      ['outbound', 'the page could not be read before this action', 'approve', true]]);
  } finally { p.c.close(); }
});

test('snapshot hangs: the click is held after snapshotMs, not after 60 s', async () => {
  const p = proxy('hang', { snapshot: 'hang', snapshotMs: 500 });
  try {
    await p.c.init();
    await p.c.call('browser_navigate', { url: 'https://mail.example.com/' });
    const t0 = Date.now(), held = p.c.call('browser_click', SEND);
    await waitFor(() => p.pending().length === 1, { timeout: 10000 });
    assert.ok(Date.now() - t0 < 5000, 'held within a few seconds');
    const a = p.approval(p.pending()[0]);
    assert.equal(a.reason, 'the page could not be read before this action');
    answer(p.dir, 'approvals', a.id, { decision: 'deny' });
    assert.equal((await held).isError, true);
    assert.ok(!calls(p.log).includes('browser_click'));
  } finally { p.c.close(); }
});

test('a readable page: a click on "Save draft" is forwarded as draft without asking', async () => {
  const p = proxy('ok');
  try {
    await p.c.init();
    await p.c.call('browser_navigate', { url: 'https://mail.example.com/' });
    const r = await p.c.call('browser_click', { target: 'e4', element: 'Save draft' });
    assert.ok(!r.isError);
    assert.deepEqual(p.pending(), []);
    assert.ok(calls(p.log).includes('browser_click'));
    const e = readAudit(path.join(p.dir, 'audit.jsonl')).find((x) => x.tool === 'browser_click');
    assert.equal(e.class, 'draft');
    assert.equal(e.reason, 'page interaction');
  } finally { p.c.close(); }
});

test('hook tickets: a call the hook check allowed runs without a second snapshot', async () => {
  const p = proxy('hook', { hook: true });
  try {
    await p.c.init();
    await p.c.call('browser_navigate', { url: 'https://mail.example.com/' });
    const before = calls(p.log).filter((n) => n === 'browser_snapshot').length;
    const args = { target: 'e4', element: 'Save draft' };
    const ans = await ask(p.dir, 'checks', { tool: 'browser_click', args }, { timeoutMs: 10000 });
    assert.equal(ans?.allow, true);
    assert.equal(ans.cls, 'draft');
    const r = await p.c.call('browser_click', args);
    assert.ok(!r.isError);
    assert.equal(calls(p.log).filter((n) => n === 'browser_snapshot').length - before, 1, 'one snapshot for the check and the call');
    assert.ok(calls(p.log).includes('browser_click'));
  } finally { p.c.close(); }
});

test('a forwarded call that never answers: a tool error after callMs, audited, and the next call still runs', async () => {
  const p = proxy('callhang', { hang: 'browser_navigate', callMs: 2000 });
  try {
    await p.c.init();
    const t0 = Date.now(), r = await p.c.call('browser_navigate', { url: 'https://mail.example.com/' });
    assert.ok(Date.now() - t0 < 6000, 'answered within a few seconds');
    assert.equal(r.isError, true);
    assert.match(txt(r), /did not answer within 2 s/);
    assert.ok(calls(p.log).includes('browser_navigate'), 'it was forwarded');
    const e = readAudit(path.join(p.dir, 'audit.jsonl')).find((x) => x.tool === 'browser_navigate');
    assert.equal(e.ok, false);
    assert.match(e.result, /^timed out: playwright did not answer/);
    const s = await p.c.call('browser_snapshot');
    assert.ok(!s.isError);
    assert.match(txt(s), /Page URL/);
  } finally { p.c.close(); }
});

test('callMs set: a normal call is unaffected and audited ok', async () => {
  const p = proxy('callok', { callMs: 2000 });
  try {
    await p.c.init();
    const r = await p.c.call('browser_navigate', { url: 'https://mail.example.com/' });
    assert.ok(!r.isError);
    assert.match(txt(r), /Compose/);
    const e = readAudit(path.join(p.dir, 'audit.jsonl')).find((x) => x.tool === 'browser_navigate');
    assert.equal(e.ok, true);
  } finally { p.c.close(); }
});
