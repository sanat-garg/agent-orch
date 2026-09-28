// Browser permissions (#476): everything runs without asking except what the owner's "Don't allow" rules match
// (Settings → Browser). The rules are parsed (gate.mjs parseRule: domain / action kinds / phrase) and applied by judge(),
// then end to end through gate-proxy.mjs in front of the fake Playwright MCP: with no rules a Send click runs and is
// audited; 'send email' holds a Gmail send; a domain rule holds navigation to it; a phrase rule matches a button name.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { answer, judge, parseRule, parseSnapshot, readAudit } from '../gate.mjs';
import { waitFor } from './helpers/wait.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(root, 'test/fixtures/fake-browser-mcp.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const GMAIL = parseSnapshot(`### Page
- Page URL: https://mail.google.com/mail/u/0/#inbox?compose=new
- Page Title: Inbox - bob@gmail.com - Gmail
### Snapshot
\`\`\`yaml
- dialog "New Message" [ref=e1]:
  - combobox "To recipients" [ref=e2]: alice@example.com
  - textbox "Subject" [ref=e3]: Lunch
  - textbox "Message Body" [active] [ref=e4]: See you at 1
  - button "Send ‪(⌘Enter)‬" [ref=e5] [cursor=pointer]
  - button "Save draft" [ref=e6]
  - button "Discard draft ‪(⌘⇧D)‬" [ref=e7]
  - link "Pricing" [ref=e8]:
    - /url: https://shop.example.com/checkout/cart
\`\`\``);
const ctx = (rules) => ({ server: 'playwright', snapshot: GMAIL, rules });

test('parseRule: a domain or URL, known action words, anything else a phrase', () => {
  assert.deepEqual(parseRule('bank.example.com'), { text: 'bank.example.com', type: 'url', host: 'bank.example.com', path: null });
  assert.deepEqual(parseRule('https://example.com/admin'), { text: 'https://example.com/admin', type: 'url', host: 'example.com', path: '/admin' });
  assert.equal(parseRule('*.shop.com').host, 'shop.com');
  assert.deepEqual(parseRule('payments and checkout').kinds, ['pay']);
  assert.deepEqual(parseRule('send email').kinds, ['send']);
  assert.deepEqual(parseRule('delete').kinds, ['delete']);
  assert.deepEqual(parseRule('post on social media').kinds, ['publish']);
  assert.deepEqual(parseRule('Log in / credentials').kinds, ['login']);
  assert.deepEqual(parseRule('upload or download files').kinds, ['upload', 'download']);
  assert.deepEqual(parseRule('Approve invoice'), { text: 'Approve invoice', type: 'phrase', phrase: 'approve invoice' });
  assert.equal(parseRule('   '), null);
});

test('judge: no rules → nothing held, not even a Send, a checkout link or a coordinate click', () => {
  for (const [tool, args] of [['browser_click', { target: 'e5' }], ['browser_click', { target: 'e8' }], ['browser_press_key', { key: 'Meta+Enter' }],
    ['browser_mouse_click_xy', { x: 1, y: 2 }], ['browser_navigate', { url: 'https://bank.example.com/' }], ['browser_file_upload', { paths: ['/tmp/a'] }]]) {
    assert.equal(judge(tool, args, ctx([])).hold, false, tool);
  }
  assert.equal(judge('browser_click', { target: 'e5' }, ctx([])).cls, 'outbound', 'still classified for the audit log');
});

test("judge: 'send email' holds a Gmail send (the button, ⌘Enter in the body) but not Save draft", () => {
  const send = judge('browser_click', { target: 'e5', element: 'Send button' }, ctx(['send email']));
  assert.deepEqual([send.hold, send.rule, send.reason], [true, 'send email', 'your rule "send email"']);
  assert.equal(judge('browser_press_key', { key: 'Meta+Enter' }, ctx(['send email'])).hold, true, 'the keyboard shortcut in the message body');
  assert.equal(judge('browser_click', { target: 'e6' }, ctx(['send email'])).hold, false, 'Save draft');
  assert.equal(judge('browser_type', { target: 'e3', text: 'x' }, ctx(['send email'])).hold, false, 'typing');
  assert.equal(judge('send_email', { to: 'a@b.c' }, { server: 'gmail', kind: 'connector', rules: ['send email'] }).hold, true, 'a connector send');
  assert.equal(judge('search_messages', { q: 'x' }, { server: 'gmail', kind: 'connector', rules: ['send email'] }).hold, false);
  assert.equal(judge('browser_click', { target: 'e7' }, ctx(['delete'])).hold, true, 'Discard draft deletes');
  assert.equal(judge('browser_click', { target: 'e6' }, ctx(['delete'])).hold, false, 'Save draft does not');
  assert.equal(judge('browser_click', { target: 'e8' }, ctx(['payments and checkout'])).rule, 'payments and checkout', 'a checkout link');
});

test('judge: a domain rule holds navigation to it and its subdomains, not other sites; reads never hold', () => {
  const r = ['bank.example.com'];
  assert.equal(judge('browser_navigate', { url: 'https://bank.example.com/login' }, ctx(r)).rule, 'bank.example.com');
  assert.equal(judge('browser_navigate', { url: 'https://www.bank.example.com/' }, ctx(r)).hold, true);
  assert.equal(judge('browser_navigate', { url: 'https://notbank.example.com/' }, ctx(r)).hold, false);
  assert.equal(judge('browser_navigate', { url: 'https://example.com/bank.example.com' }, ctx(r)).hold, false);
  assert.equal(judge('browser_navigate', { url: 'https://example.com/admin/x' }, ctx(['example.com/admin'])).hold, true);
  assert.equal(judge('browser_navigate', { url: 'https://example.com/help' }, ctx(['example.com/admin'])).hold, false);
  assert.equal(judge('browser_snapshot', {}, ctx(['mail.google.com'])).hold, false);
  assert.equal(judge('browser_click', { target: 'e6' }, ctx(['mail.google.com'])).hold, true, 'acting on a page of that domain');
});

test("judge: a phrase rule matches the element's accessible name (any case), the page title or the URL", () => {
  assert.equal(judge('browser_click', { target: 'e6' }, ctx(['save DRAFT'])).rule, 'save DRAFT');
  assert.equal(judge('browser_click', { target: 'e6' }, ctx(['approve invoice'])).hold, false);
  assert.equal(judge('browser_click', { target: 'e6' }, ctx(['bob@gmail'])).hold, true, 'the page title');
  assert.equal(judge('browser_navigate', { url: 'https://example.com/invoices/42' }, ctx(['invoices'])).hold, true, 'the URL');
});

// ---- end to end through the proxy
function mcp(s) {
  const child = spawn(s.command, s.args || [], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 0;
  const waits = new Map();
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waits.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise((r) => { const n = ++id; waits.set(n, r); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); });
  return { init: () => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }),
    call: async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result, close: () => { child.stdin.end(); child.kill(); } };
}
const txt = (r) => (r?.content || []).map((c) => c.text || '').join('\n');
function proxy(name, rules) {
  const dir = path.join(tmp, name), log = path.join(tmp, `${name}.calls.jsonl`), cfg = path.join(dir, 'proxy-playwright.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ dir, server: 'playwright', kind: 'browser', task: 7, rules, ttlMs: 60_000,
    upstream: { command: process.execPath, args: [FAKE], env: { FAKE_MCP_LOG: log } } }));
  const c = mcp({ command: process.execPath, args: [path.join(root, 'gate-proxy.mjs'), '--config', cfg] });
  const box = path.join(dir, 'approvals');
  const pending = () => { try { return fs.readdirSync(box).filter((n) => /^[\w-]+\.json$/.test(n) && !n.includes('answer') && !fs.existsSync(path.join(box, n.replace('.json', '.answer.json')))); } catch { return []; } };
  const ran = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).name); } catch { return []; } };
  return { c, dir, pending, ran, approval: (n) => JSON.parse(fs.readFileSync(path.join(box, n), 'utf8')), audit: () => readAudit(path.join(dir, 'audit.jsonl')) };
}

test('proxy, no rules: a Send click runs without approval and is audited', async () => {
  const p = proxy('none', []);
  try {
    await p.c.init();
    await p.c.call('browser_navigate', { url: 'https://mail.google.com/mail/u/0/' });
    assert.match(txt(await p.c.call('browser_click', { target: 'e3', element: 'Send' })), /Sent!/);
    assert.deepEqual(p.pending(), []);
    assert.ok(!fs.existsSync(path.join(p.dir, 'approvals')), 'nothing was asked');
    const e = p.audit().find((x) => x.tool === 'browser_click');
    assert.deepEqual([e.class, e.ok, e.approval, e.task], ['outbound', true, undefined, 7]);
    assert.match(e.action, /^Click "Send" button on mail\.google\.com/);
  } finally { p.c.close(); }
});

test("proxy, 'send email': a Gmail Send is held with a screenshot; denied it never runs, approved it does", async () => {
  const p = proxy('send', ['send email']);
  try {
    await p.c.init();
    await p.c.call('browser_navigate', { url: 'https://mail.google.com/mail/u/0/' });
    assert.match(txt(await p.c.call('browser_click', { target: 'e4', element: 'Save draft' })), /Not sent/, 'other clicks run');
    const denied = p.c.call('browser_click', { target: 'e3', element: 'Send' });
    await waitFor(() => p.pending().length === 1, { timeout: 10000 });
    const a = p.approval(p.pending()[0]);
    assert.deepEqual([a.reason, a.rule, a.tool], ['your rule "send email"', 'send email', 'browser_click']);
    assert.ok(a.screenshot, 'a screenshot of the page');
    assert.equal(p.ran().filter((n) => n === 'browser_click').length, 1, 'only Save draft ran');
    answer(p.dir, 'approvals', a.id, { decision: 'deny', reason: 'not yet' });
    assert.match(txt(await denied), /denied this action.*not yet/s);
    const ok = p.c.call('browser_click', { target: 'e3', element: 'Send' });
    await waitFor(() => p.pending().length === 1, { timeout: 10000 });
    answer(p.dir, 'approvals', p.approval(p.pending()[0]).id, { decision: 'approve' });
    assert.match(txt(await ok), /Sent!/);
    assert.deepEqual(p.audit().filter((x) => x.tool === 'browser_click').map((x) => [x.rule ?? null, x.decision ?? null, x.ok]),
      [[null, null, true], ['send email', 'deny', false], ['send email', 'approve', true]]);
  } finally { p.c.close(); }
});

test('proxy: a domain rule holds navigation to that domain; a phrase rule matches a button name', async () => {
  const p = proxy('mixed', ['bank.example.com', 'save draft']);
  try {
    await p.c.init();
    assert.match(txt(await p.c.call('browser_navigate', { url: 'https://mail.example.org/' })), /Compose/, 'another site opens');
    const nav = p.c.call('browser_navigate', { url: 'https://bank.example.com/transfer' });
    await waitFor(() => p.pending().length === 1, { timeout: 10000 });
    const a = p.approval(p.pending()[0]);
    assert.deepEqual([a.tool, a.rule], ['browser_navigate', 'bank.example.com']);
    answer(p.dir, 'approvals', a.id, { decision: 'deny' });
    assert.equal((await nav).isError, true);
    assert.equal(p.ran().filter((n) => n === 'browser_navigate').length, 1, 'the bank was never opened');
    assert.match(txt(await p.c.call('browser_click', { target: 'e3', element: 'Send' })), /Sent!/, 'Send is not disallowed here');
    const draft = p.c.call('browser_click', { target: 'e4' });
    await waitFor(() => p.pending().length === 1, { timeout: 10000 });
    assert.equal(p.approval(p.pending()[0]).rule, 'save draft');
    answer(p.dir, 'approvals', p.approval(p.pending()[0]).id, { decision: 'approve' });
    assert.ok(!(await draft).isError);
  } finally { p.c.close(); }
});

test("Settings has a Browser section with a 'Don't allow' box; the activity panel says what it asks before", () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /<h3 class="st-sec">Browser<\/h3>\s*<p class="st-hint">[^<]+<\/p>\s*<div class="st-row st-dir">\s*<label class="st-text" for="stGatePatterns"><strong>Don't allow<\/strong>/);
  assert.match(html, /<textarea id="stGatePatterns"[^>]*placeholder="payments and checkout&#10;send email&#10;delete&#10;bank\.example\.com&#10;post on social media"/);
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8'), bx = fs.readFileSync(path.join(root, 'public/browser.js'), 'utf8');
  assert.match(app, /api\('\/api\/orch\/gate', 'PUT', \{ rules: t\.value \}\)/);
  const line = new Function(`${/const bxRulesLine = [^\n]+/.exec(bx)[0]}; return bxRulesLine;`)();
  assert.equal(line(['payments', 'send email']), 'Asks before: payments, send email');
  assert.match(line([]), /^Asks before: nothing/);
});
