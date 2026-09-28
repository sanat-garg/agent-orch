// The approval gate (gate.mjs, gate-proxy.mjs): classification, and the proxy holding an outbound click until the owner
// answers. A fake Playwright-like MCP (test/fixtures/fake-browser-mcp.mjs) logs every call it actually executes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { answer, classify, hostGate, matchPattern, parseSnapshot, patternsWith, readAudit, redact } from '../gate.mjs';
import { waitFor } from './helpers/wait.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(root, 'test/fixtures/fake-browser-mcp.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SNAP = `### Page
- Page URL: https://mail.example.com/compose
- Page Title: Compose
### Snapshot
\`\`\`yaml
- generic [ref=e1]:
  - textbox "To" [ref=e2]: bob@example.com
  - textbox "Subject" [ref=e5]: Invoice 42
  - link "Checkout" [ref=e8] [cursor=pointer]:
    - /url: /shop/checkout
  - button "Send" [ref=e3] [cursor=pointer]
  - button "Save draft" [ref=e4]
  - button "Sign in" [ref=e10]
  - button [ref=e9]:
    - text: Delete
\`\`\``;

test('classify: element names from the snapshot, checkout URLs, reads, custom patterns', () => {
  const snapshot = parseSnapshot(SNAP), ctx = { server: 'playwright', snapshot };
  assert.equal(snapshot.url, 'https://mail.example.com/compose');
  assert.deepEqual(snapshot.refs.get('e3'), { ref: 'e3', role: 'button', name: 'Send', indent: 2 });
  assert.equal(snapshot.refs.get('e9').name, 'Delete', 'a nameless element takes its text');
  const send = classify('browser_click', { element: 'the blue button', target: 'e3' }, ctx);
  assert.equal(send.cls, 'outbound');
  assert.match(send.action, /Click "Send" button on mail\.example\.com\/compose · To: bob@example\.com, Subject: Invoice 42/);
  assert.equal(classify('browser_click', { element: 'Save draft', target: 'e4' }, ctx).cls, 'draft');
  assert.equal(classify('browser_click', { element: 'Sign in', target: 'e10' }, ctx).cls, 'draft', '"Sign in" is not signing');
  assert.equal(classify('browser_click', { element: 'x', target: 'e9' }, ctx).cls, 'outbound');
  assert.equal(classify('browser_click', { element: 'Checkout', target: 'e8' }, ctx).cls, 'outbound', 'a link to checkout');
  assert.equal(classify('browser_click', { target: 'button:has-text("Send")' }, ctx).cls, 'outbound', 'a selector naming Send');
  assert.equal(classify('browser_click', { element: 'Send', target: 'e4' }, ctx).cls, 'outbound', "the agent's own description counts too");
  assert.equal(classify('browser_navigate', { url: 'https://shop.example.com/checkout/step1' }, ctx).cls, 'outbound');
  assert.equal(classify('browser_navigate', { url: 'https://shop.example.com/products' }, ctx).cls, 'draft');
  for (const t of ['browser_snapshot', 'browser_take_screenshot', 'browser_wait_for']) assert.equal(classify(t, {}, ctx).cls, 'read', t);
  assert.equal(classify('browser_evaluate', { function: '() => 1' }, ctx).cls, 'outbound', 'arbitrary JS');
  assert.equal(classify('browser_type', { target: 'e5', text: 'hi' }, ctx).cls, 'draft');
  assert.equal(classify('browser_click', { target: 'e4' }, { ...ctx, patterns: patternsWith(['Save draft']) }).cls, 'outbound', "the owner's pattern");
  assert.equal(matchPattern('Sender', patternsWith([])), null, 'whole words only');
  assert.equal(matchPattern('Submit  order', patternsWith([])), 'Submit order');
  assert.equal(matchPattern('Archive all', ['/arch(ive)?/i']), '/arch(ive)?/i');
  // Keyboard sends, submit, the wider verb list and icon-only buttons (AUDIT #40).
  const slack = parseSnapshot(`- Page URL: https://app.slack.com/client/T1/C1
- generic [ref=e1]:
  - searchbox "Search Acme" [ref=e2]
  - textbox "Message #general" [active] [ref=e3]: hello team
  - button "Post" [ref=e4]
  - button [ref=e5]:
    - img [ref=e6]
  - link "Order history" [ref=e7]:
    - /url: /account/orders`), sctx = { server: 'playwright', snapshot: slack };
  assert.equal(slack.refs.get('e3').active, true, 'the focused field');
  const enter = classify('browser_press_key', { key: 'Enter' }, sctx);
  assert.equal(enter.cls, 'outbound');
  assert.equal(enter.reason, 'may submit the focused field');
  assert.equal(enter.action, 'press key Enter in "Message #general" textbox on app.slack.com/client/T1/C1');
  assert.equal(enter.key, 'playwright|browser_press_key|enter|textbox|message #general', 'the "always allow" key names the field');
  assert.equal(classify('browser_press_key', { key: 'Control+Enter' }, sctx).cls, 'outbound', 'Ctrl+Enter sends in Gmail');
  assert.equal(classify('browser_press_key', { key: 'Control+Enter' }, {}).cls, 'outbound', 'no snapshot: assume a composer');
  assert.equal(classify('browser_press_key', { key: 'ArrowDown' }, sctx).cls, 'draft', 'other keys');
  assert.equal(classify('browser_press_key', { key: 'Enter' }, ctx).cls, 'draft', 'nothing focused');
  assert.equal(classify('browser_press_key', { key: 'Enter' }, { ...sctx, snapshot: parseSnapshot(SNAP.replace('"To" [ref=e2]', '"To" [active] [ref=e2]')) }).cls, 'outbound', 'a focused compose field');
  assert.equal(classify('browser_type', { target: 'e3', text: 'hi', submit: true }, sctx).cls, 'outbound', 'Enter sends in Slack');
  assert.equal(classify('browser_type', { target: 'e3', text: 'hi', submit: true }, sctx).reason, 'submits the field');
  assert.equal(classify('browser_type', { target: 'e2', text: 'hi', submit: true }, sctx).cls, 'draft', 'a searchbox');
  assert.equal(classify('browser_type', { target: 'e3', text: 'hi' }, sctx).cls, 'draft', 'typing without submit');
  assert.equal(classify('browser_click', { element: 'Post', target: 'e4' }, sctx).cls, 'outbound');
  const icon = classify('browser_click', { element: 'the blue icon', target: 'e5' }, sctx);
  assert.equal(icon.cls, 'outbound');
  assert.equal(icon.reason, 'button with no accessible name');
  assert.match(icon.action, /^Click "the blue icon" button on app\.slack\.com/);
  assert.equal(classify('browser_click', { target: 'e7' }, sctx).cls, 'draft', '"Order history" orders nothing');
  for (const t of ['Post', 'Reply', 'Submit', 'Buy now', 'Order', 'Checkout', 'Tweet', 'Save & send']) assert.ok(matchPattern(t), t);
  for (const t of ['Order history', 'Orders', 'Posts', 'Replies', 'Checkout history', 'Your orders', 'Track order']) assert.equal(matchPattern(t), null, t);
  // Connectors: marked tools and outbound verbs in their names.
  const conn = { server: 'gmail', kind: 'connector', connector: { outbound: ['modify_labels'] } };
  assert.equal(classify('send_email', { to: 'a@b.c' }, conn).cls, 'outbound');
  assert.equal(classify('create_payment', {}, conn).cls, 'outbound');
  assert.equal(classify('modify_labels', {}, conn).cls, 'outbound');
  assert.equal(classify('search_messages', { q: 'x' }, conn).cls, 'read');
  assert.equal(classify('create_draft', {}, conn).cls, 'draft');
  // "Always" keys (AUDIT #49): arbitrary code has none; a connector's covers only the same recipients.
  const ev = classify('browser_evaluate', { function: `() => ${'x'.repeat(200)}` }, ctx);
  assert.equal(ev.key, null, 'no "always" for arbitrary JS');
  assert.equal(ev.action, `evaluate on mail.example.com/compose: () => ${'x'.repeat(114)}`, 'the first 120 chars of the code');
  assert.equal(classify('browser_run_code', { code: 'x' }, ctx).key, null);
  const bob = classify('send_email', { to: 'bob@acme.com', subject: 'Hi' }, conn).key;
  assert.match(bob, /^gmail\|send_email\|[0-9a-f]{8}$/);
  assert.equal(classify('send_email', { subject: 'Other', to: 'bob@acme.com' }, conn).key, bob, 'same recipient, same key');
  assert.notEqual(classify('send_email', { to: 'x@evil.com', subject: 'Hi' }, conn).key, bob, 'another recipient is not covered');
  assert.equal(classify('search_messages', { q: 'x' }, conn).key, 'gmail|search_messages', 'no recipient-like args');
  // Local and private services are outbound (AUDIT #41).
  for (const u of ['http://127.0.0.1:7682', 'http://192.168.1.5/', 'http://localhost:3000/', 'http://[::1]:2019/', 'http://caddy/', 'http://169.254.169.254/latest']) {
    const nav = classify('browser_navigate', { url: u }, ctx);
    assert.deepEqual([nav.cls, nav.reason], ['outbound', 'opens a local or private service'], u);
  }
  assert.equal(classify('browser_navigate', { url: 'https://example.com/' }, ctx).cls, 'draft');
  const lan = parseSnapshot('- Page URL: https://example.com/\n- link "Docs" [ref=e1]:\n  - /url: http://10.0.0.2:8080/\n- link "About" [ref=e2]:\n  - /url: /about');
  assert.equal(classify('browser_click', { target: 'e1' }, { ...ctx, snapshot: lan }).reason, 'opens a local or private service');
  assert.equal(classify('browser_click', { target: 'e2' }, { ...ctx, snapshot: lan }).cls, 'draft', 'a relative link');
  assert.deepEqual(redact({ apiKey: 'k', q: 'token ya29.abcdefghijklmnop', fields: [{ name: 'Password', value: 'hunter2' }] }),
    { apiKey: '[redacted]', q: 'token [redacted]', fields: [{ name: 'Password', value: '[redacted]' }] });
});

// A client for the proxy, as the agent CLI would run it.
function startProxy(name, extra = {}) {
  const dir = path.join(tmp, name), log = path.join(tmp, `${name}.calls.jsonl`);
  fs.mkdirSync(dir, { recursive: true });
  const cfgFile = path.join(dir, 'proxy.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ dir, server: 'playwright', kind: 'browser', task: 7, upstream: { command: process.execPath, args: [FAKE], env: { FAKE_MCP_LOG: log } }, ...extra }));
  const child = spawn(process.execPath, [path.join(root, 'gate-proxy.mjs'), '--config', cfgFile], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 0;
  const waits = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waits.get(m.id)?.(m); }
  });
  const rpc = (method, params) => new Promise((resolve) => { const n = ++id; waits.set(n, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); });
  const call = async (tool, args = {}) => (await rpc('tools/call', { name: tool, arguments: args })).result;
  const executed = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const approvals = () => { try { return fs.readdirSync(path.join(dir, 'approvals')).filter((n) => !n.includes('answer')).map((n) => JSON.parse(fs.readFileSync(path.join(dir, 'approvals', n), 'utf8'))); } catch { return []; } };
  return { dir, rpc, call, executed, approvals, close: () => { child.stdin.end(); child.kill(); } };
}
const txt = (r) => (r?.content || []).map((c) => c.text || '').join('\n');
const settled = (p) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 300))]);

test('proxy: a click on Send is held until approved; deny returns the reason and leaves the page unchanged; reads pass', async () => {
  const p = startProxy('held');
  try {
    await p.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.ok((await p.rpc('tools/list', {})).result.tools.some((t) => t.name === 'browser_click'), 'tools/list passes through');
    await p.call('browser_navigate', { url: 'https://mail.example.com/compose' });
    assert.match(txt(await p.call('browser_snapshot')), /Not sent/);
    await p.call('browser_type', { element: 'Password', target: 'e7', text: 'hunter2' });
    assert.equal(p.approvals().length, 0, 'reads and drafts are never held');

    // Approve once: nothing runs until the owner answers.
    const clicked = p.call('browser_click', { element: 'Send button', target: 'e3' });
    await waitFor(() => p.approvals().length === 1, { timeout: 10000 });
    assert.equal(await settled(clicked), false, 'the call is held');
    assert.ok(!p.executed().some((c) => c.name === 'browser_click'), 'the click has not reached the browser');
    const [a] = p.approvals();
    assert.match(a.action, /Click "Send" button on mail\.example\.com\/compose · To: bob@example\.com/);
    assert.match(a.screenshot, /^[0-9a-f]{64}\.png$/);
    assert.ok(fs.existsSync(path.join(p.dir, 'shots', a.screenshot)), 'the screenshot of the page is saved');
    answer(p.dir, 'approvals', a.id, { decision: 'approve', by: 'owner' });
    const ok = await clicked;
    assert.ok(!ok.isError, txt(ok));
    assert.match(txt(await p.call('browser_snapshot')), /Sent!/);

    // Deny: the agent gets an error with the reason, and the page is unchanged.
    await p.call('browser_navigate', { url: 'https://mail.example.com/compose' });
    const before = p.executed().filter((c) => c.name === 'browser_click').length;
    const second = p.call('browser_click', { element: 'Send button', target: 'e3' });
    await waitFor(() => p.approvals().length === 2, { timeout: 10000 });
    const b = p.approvals().find((x) => x.id !== a.id);
    answer(p.dir, 'approvals', b.id, { decision: 'deny', reason: 'wrong recipient', by: 'owner' });
    const no = await second;
    assert.equal(no.isError, true);
    assert.match(txt(no), /denied this action .*Send.*: wrong recipient\. It was NOT performed/);
    assert.equal(p.executed().filter((c) => c.name === 'browser_click').length, before, 'the denied click never ran');
    assert.match(txt(await p.call('browser_snapshot')), /Not sent/);

    // The audit log: every call, classified, with redacted args and the screenshot ids.
    const log = readAudit(path.join(p.dir, 'audit.jsonl'));
    assert.ok(log.every((e) => !e.broken && Number.isFinite(e.ts) && ['read', 'draft', 'outbound'].includes(e.class)));
    assert.deepEqual(log.map((e) => `${e.tool}:${e.class}${e.decision ? `:${e.decision}` : ''}`), [
      'browser_navigate:draft', 'browser_snapshot:read', 'browser_type:draft', 'browser_click:outbound:approve', 'browser_snapshot:read',
      'browser_navigate:draft', 'browser_click:outbound:deny', 'browser_snapshot:read']);
    assert.equal(log[2].args.text, '[redacted]', 'text typed into a password field is redacted');
    assert.equal(log[3].screenshot, a.screenshot);
    assert.equal(log[6].ok, false);
    assert.equal(log[6].note, 'wrong recipient');
  } finally { p.close(); }
});

test('hostGate: the host sees each request and audit line once, and its answer releases the call', async () => {
  const p = startProxy('host');
  const seen = [], audit = [];
  const stop = hostGate(p.dir, { onRequest: async (a) => { seen.push(a); return { decision: 'deny', reason: 'not today' }; }, onAudit: (e) => audit.push(e) });
  try {
    await p.call('browser_navigate', { url: 'https://shop.example.com/checkout' }).then((r) => assert.match(txt(r), /not today/));
    await p.call('browser_snapshot');
    await waitFor(() => audit.length === 2, { timeout: 10000 });
    assert.equal(seen.length, 1);
    assert.match(seen[0].action, /^Open https:\/\/shop\.example\.com\/checkout/);
    assert.deepEqual(audit.map((e) => e.class), ['outbound', 'read']);
    assert.ok(!p.executed().some((c) => c.name === 'browser_navigate'), 'the denied navigation never ran');
  } finally { stop(); p.close(); }
});

test('cluster frames: held calls and audit lines ride job.event; the answer is job.approval, only to workers that read it', async () => {
  const { FEATURES, WORKER_ACCEPTS, createSender, validate } = await import('../cluster-protocol.mjs');
  const w = createSender('w'), c = createSender('c');
  assert.doesNotThrow(() => w('job.event', { job: 3, from: 0, events: [{ k: 'approval', approval: { id: 'x1y2z3', action: 'Click "Send"' } }, { k: 'audit', entry: { tool: 'browser_click', class: 'outbound' } }] }));
  assert.doesNotThrow(() => c('job.approval', { job: 3, id: 'x1y2z3', decision: 'deny', reason: 'no' }));
  assert.match(validate({ t: 'job.approval', seq: 1, ts: 1, job: 3, id: 'x', decision: 'approve' }, { from: 'w' }), /may not be sent by the worker/);
  assert.equal(FEATURES['job.approval'], 'approvals');
  assert.ok(WORKER_ACCEPTS.includes('job.approval'));
  // The worker sends a screenshot only for a content-hash id, never a path from the run's question file or audit line.
  const src = fs.readFileSync(new URL('../worker.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ MEDIA_ID_RE \} from '\.\/media\.mjs';/);
  assert.match(src, /const image = \(id\) => \{\n\s+if \(!MEDIA_ID_RE\.test\(id \|\| ''\)/);
  const { MEDIA_ID_RE } = await import('../media.mjs');
  assert.ok(!MEDIA_ID_RE.test('../x') && !MEDIA_ID_RE.test(`../${'a'.repeat(64)}.png`));
});

test('approvals: past 20 pending requests in one run, the next is denied at once by the cap', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { createApprovals } = await import('../approvals.mjs');
  const db = new DatabaseSync(':memory:'), sent = [], changes = [];
  const ap = createApprovals({ db, dataDir: path.join(tmp, 'cap'), deliver: (row, ans) => { sent.push([row.id, ans]); return true; }, onChange: (row, kind) => changes.push([row.id, kind]) });
  try {
    for (let i = 0; i < 20; i++) assert.equal(ap.request({ approval: { id: `held-${i}`, action: 'Click "Send"' }, taskId: 1, runId: 7, node: 'w' }).status, 'pending');
    const r = ap.request({ approval: { id: 'held-20', action: 'Click "Send"' }, taskId: 1, runId: 7, node: 'w' });
    assert.equal(r.status, 'denied');
    assert.equal(r.by, 'cap');
    assert.match(r.note, /Too many held actions in one run/);
    assert.deepEqual(sent, [['held-20', { decision: 'deny', reason: r.note, by: 'cap' }]]);
    assert.deepEqual(changes.at(-1), ['held-20', 'decided']);
    assert.equal(ap.request({ approval: { id: 'other-run', action: 'Click "Send"' }, taskId: 1, runId: 8, node: 'w' }).status, 'pending', 'another run is not capped');
  } finally { ap.stop(); db.close(); }
});

test('approvals: the expiry note states the row\'s own window, not the current setting', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { createApprovals } = await import('../approvals.mjs');
  let t = 1_000_000;
  const db = new DatabaseSync(':memory:');
  const ap = createApprovals({ db, dataDir: path.join(tmp, 'ttl'), now: () => t });
  try {
    ap.request({ approval: { id: 'ttl-1h', action: 'Click "Send"', ttlMs: 3_600_000 }, taskId: 1, runId: 7, node: 'w' });
    ap.request({ approval: { id: 'ttl-45m', action: 'Click "Send"', ttlMs: 2_700_000 }, taskId: 1, runId: 7, node: 'w' });
    t += 3_600_000;
    ap.expire();
    assert.equal(ap.get('ttl-1h').status, 'expired');
    assert.equal(ap.get('ttl-1h').note, 'No answer within 1 h');
    assert.equal(ap.get('ttl-45m').note, 'No answer within 45 min');
  } finally { ap.stop(); db.close(); }
});

test('approvals: at boot a remote row that ran out while the head was down is expired before createApprovals returns', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { createApprovals } = await import('../approvals.mjs');
  const file = path.join(tmp, 'boot-expiry.db');
  let t = 1_000_000;
  let db = new DatabaseSync(file);
  const first = createApprovals({ db, dataDir: path.join(tmp, 'boot'), now: () => t });
  first.request({ approval: { id: 'remote-old', action: 'Click "Send"', ttlMs: 3_600_000 }, taskId: 1, runId: 7, node: 'w' });
  first.request({ approval: { id: 'remote-new', action: 'Click "Send"' }, taskId: 1, runId: 7, node: 'w' });
  first.stop(); db.close();
  t += 2 * 3_600_000;
  db = new DatabaseSync(file);
  const sent = [];
  const ap = createApprovals({ db, dataDir: path.join(tmp, 'boot'), boot: true, now: () => t, deliver: (row, ans) => { sent.push([row.id, ans.decision]); return true; } });
  try {
    assert.equal(ap.get('remote-old').status, 'expired');
    assert.equal(ap.get('remote-old').note, 'No answer within 1 h');
    assert.equal(ap.get('remote-new').status, 'pending', 'a row still inside its window waits');
    assert.deepEqual(sent, [], 'the answer goes out once the caller has finished wiring up');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, [['remote-old', 'expired']]);
  } finally { ap.stop(); db.close(); }
});
