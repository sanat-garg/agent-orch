// The live browser view (browser-live.mjs, browser-view.mjs, bin/browser-mcp.mjs; AGENTIC.md → Browser): over the app's
// signed-in /ws, a profile's Chromium streams screencast frames of a local page, the owner's clicks and typing reach the
// page, and while a task's MCP (behind the shim, attached to the same Chromium) uses the profile the owner watches, and
// taking over holds the task's tools/call until they hand back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { findBrowser } from '../browser.mjs';
import { inputCalls, normUrl } from '../browser-live.mjs';
import { createBrowserViews } from '../browser-view.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'browser-live-password';
const skip = !findBrowser() && 'no Chromium or Chrome on this machine';
let child, base, tmp, browserHome, page, pageUrl, out = '';
const typed = [];

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-live-'));
  browserHome = path.join(tmp, 'home');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  // The local page: an input at the top left that reports its value on Enter, and a cookie for "signed-in sites".
  page = http.createServer((req, res) => {
    if (req.url.startsWith('/typed')) { typed.push(new URL(req.url, 'http://x').searchParams.get('v')); res.end('ok'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'session=secret-value; Max-Age=86400; Path=/' });
    res.end(`<!doctype html><title>Live test</title><body style="margin:0;background:#fff">
      <input id=q autocomplete=off style="position:absolute;left:0;top:0;width:400px;height:40px;font-size:20px"
        onkeydown="if (event.key === 'Enter') fetch('/typed?v=' + encodeURIComponent(this.value))">
      <h1 style="margin-top:80px">${req.url === '/two' ? 'Page two' : 'Page one'}</h1>`);
  });
  await new Promise((r) => page.listen(0, '127.0.0.1', r));
  pageUrl = `http://127.0.0.1:${page.address().port}/`;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1', AGENT_ORCH_BROWSER_HOME: browserHome, AGENT_ORCH_BROWSER_HEADLESS: '1' } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
});

after(() => {
  child?.kill('SIGKILL');
  page?.close();
  // The server's Chromium outlives a SIGKILL: stop the ones on this test's profiles.
  if (tmp) { try { execFileSync('pkill', ['-KILL', '-f', browserHome]); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('input events map to CDP calls; typed addresses open only http(s)', () => {
  assert.deepEqual(inputCalls({ type: 'click', x: 10, y: 20 }).map(([, p]) => p.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.deepEqual(inputCalls({ type: 'text', text: 'hi' }), [['Input.insertText', { text: 'hi' }]]);
  const [down, up] = inputCalls({ type: 'key', key: 'Enter', code: 'Enter' });
  assert.equal(down[1].type, 'keyDown'); assert.equal(down[1].text, '\r'); assert.equal(down[1].windowsVirtualKeyCode, 13); assert.equal(up[1].type, 'keyUp');
  assert.equal(inputCalls({ type: 'key', key: 'Backspace' })[0][1].type, 'rawKeyDown');
  assert.equal(inputCalls({ type: 'key', key: 'a', ctrl: true })[0][1].modifiers, 2);
  assert.equal(inputCalls({ type: 'key', key: '.', code: 'Period' })[0][1].windowsVirtualKeyCode, 190, 'a period is not Delete (46)');
  assert.deepEqual(inputCalls({ type: 'nope' }), []);
  assert.equal(normUrl('mail.google.com'), 'https://mail.google.com/');
  assert.equal(normUrl('localhost:3000/x'), 'http://localhost:3000/x');
  assert.equal(normUrl('javascript:alert(1)'), null);
  assert.equal(normUrl('file:///etc/passwd'), null);
});

test('bv_open follows a url only when the socket may drive (AUDIT #50)', async () => {
  // A stub manager on the controller records the screen ops; no Chromium needed.
  const ops = [], sent = new Map(), running = [{ id: 7, title: 'Read mail', node: 'controller', identity: 'busy' }];
  const local = { home: '/nonexistent', close() {},
    async start(identity, { url, onState }) { ops.push({ op: 'open', identity, url }); onState({ identity, url: '', title: '', active: false, takeover: false }); },
    async nav(identity, { action, url }) { ops.push({ op: 'nav', identity, action, url }); return true; },
    takeover(identity, on) { ops.push({ op: 'takeover', identity, on }); return on; } };
  const views = createBrowserViews({ local, tasks: () => running, send: (ws, m) => { if (!sent.has(ws)) sent.set(ws, []); sent.get(ws).push(m); } });
  const last = (ws) => sent.get(ws)?.at(-1) || {};
  const open = (ws, identity, url) => views.handle(ws, { t: 'bv_open', node: 'controller', identity, url });
  const navs = (identity) => ops.filter((o) => o.op === 'nav' && o.identity === identity);
  try {
    // A task uses "busy": neither the first viewer nor one joining later navigates it.
    const a = {}, b = {};
    open(a, 'busy', 'https://example.com/a');
    await waitFor(() => last(a).note, { timeout: 5000, message: `a note for the ignored url: ${JSON.stringify(sent.get(a))}` });
    assert.equal(last(a).note, 'A task is using this profile: take over to navigate');
    assert.equal(last(a).role, 'watch');
    open(b, 'busy', 'https://example.com/b');
    await waitFor(() => last(b).note, { timeout: 5000, message: 'the joining viewer gets the note too' });
    assert.deepEqual(ops.filter((o) => o.op === 'open'), [{ op: 'open', identity: 'busy', url: undefined }], 'no url on the open op');
    assert.deepEqual(navs('busy'), [], 'no nav while a task has the profile');

    // After take-over the same bv_open navigates.
    views.handle(a, { t: 'bv_take', node: 'controller', identity: 'busy' });
    assert.equal(last(a).role, 'control');
    open(a, 'busy', 'https://example.com/a');
    await waitFor(() => navs('busy').length, { timeout: 5000, message: 'the taken-over viewer navigates' });
    assert.deepEqual(navs('busy'), [{ op: 'nav', identity: 'busy', action: 'go', url: 'https://example.com/a' }]);

    // With no task on the profile, the opener drives and its url is followed.
    const c = {};
    open(c, 'free', 'https://example.com/c');
    await waitFor(() => navs('free').length, { timeout: 5000, message: 'the url is followed on a free profile' });
    assert.deepEqual(navs('free'), [{ op: 'nav', identity: 'free', action: 'go', url: 'https://example.com/c' }]);
    assert.equal(last(c).role, 'control');
    assert.ok(!sent.get(c).some((m) => m.note), 'no note when the url was followed');
  } finally { await views.close(); }
});

// A minimal MCP client for the shim.
function mcp(args, env) {
  const c = spawn(process.execPath, [path.join(ROOT, 'bin', 'browser-mcp.mjs'), ...args], { cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', id = 0, stderr = '';
  const got = new Map();
  c.stderr.on('data', (d) => { stderr += d; });
  c.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); got.set(m.id, m); }
  });
  return {
    child: c, got, stderr: () => stderr,
    send(method, params) { const n = ++id; c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); return n; },
  };
}

test('frames stream over /ws, input reaches the page, and take-over holds the task\'s browser actions', { skip, timeout: 180000 }, async () => {
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = async (p, opts = {}) => { const r = await fetch(base + p, { ...opts, headers: { cookie, 'content-type': 'application/json' } }); return { status: r.status, body: await r.json() }; };

  const list = await api('/api/browser');
  const ctl = list.body.nodes.find((n) => n.id === 'controller');
  assert.ok(ctl?.capable, JSON.stringify(list.body));
  assert.ok(ctl.profiles.some((p) => p.identity === 'default'));

  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie } });
  const frames = [], states = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'bv_frame') frames.push(m);
    else if (m.t === 'bv_state') states.push(m);
    else if (m.t === 'bv_error') states.push(m);
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const say = (m) => ws.send(JSON.stringify({ node: 'controller', identity: 'live', ...m }));
  const state = () => states.at(-1) || {};

  // Open: Chromium starts on the profile, loads the page, and frames flow.
  say({ t: 'bv_open', url: pageUrl });
  await waitFor(() => state().url === pageUrl && state().role === 'control', { timeout: 90000, message: `the view opens on the page: ${JSON.stringify(states.slice(-3))}\n${out}` });
  await waitFor(() => frames.length >= 2, { timeout: 30000, message: 'screencast frames arrive' });
  const f = frames.at(-1);
  assert.equal(f.node, 'controller'); assert.equal(f.identity, 'live');
  assert.ok(Buffer.from(f.data, 'base64').subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), 'a JPEG');
  assert.deepEqual([f.w, f.h], [1280, 800]);

  // Input: click the field, type, press Enter; the page reports what it got.
  say({ t: 'bv_input', events: [{ type: 'click', x: 100, y: 20 }, { type: 'text', text: 'hello agent' }, { type: 'key', key: 'Enter', code: 'Enter' }] });
  await waitFor(() => typed.includes('hello agent'), { timeout: 15000, message: `typed text reaches the page: ${JSON.stringify(typed)}` });
  const before = frames.length;
  say({ t: 'bv_nav', action: 'go', url: `${pageUrl}two` });
  await waitFor(() => state().url === `${pageUrl}two`, { timeout: 15000, message: 'navigation from the URL bar' });
  await waitFor(() => frames.length > before, { timeout: 15000, message: 'a new page gives new frames' });
  say({ t: 'bv_nav', action: 'back' });
  await waitFor(() => state().url === pageUrl, { timeout: 15000, message: 'back' });

  // Signed-in sites: cookie domains only, never values.
  const sites = await api('/api/browser/sites?node=controller&identity=live');
  assert.deepEqual(sites.body.sites.map((s) => s.domain), ['127.0.0.1']);
  assert.ok(!JSON.stringify(sites.body).includes('secret-value'));

  // A task starts on the profile: its MCP (behind the shim) attaches to the same Chromium, and the owner now watches.
  const port = Number(fs.readFileSync(path.join(browserHome, '.agent-orch-browser', 'profiles', 'live', 'DevToolsActivePort'), 'utf8').split('\n')[0]);
  const task = mcp(['--identity', 'live', '--home', browserHome, '--', process.execPath, path.join(ROOT, 'test', 'fixtures', 'fake-mcp.mjs'),
    '--user-data-dir', '/nowhere', '--headless', '--output-dir', tmp], { ...process.env });
  try {
    const init = task.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    await waitFor(() => task.got.get(init), { timeout: 30000, message: `the shim starts the MCP: ${task.stderr()}` });
    const first = task.send('tools/call', { name: 'browser_snapshot', arguments: {} });
    await waitFor(() => task.got.get(first), { timeout: 10000, message: 'a tools/call goes through while nobody has taken over' });
    const argv = JSON.parse(task.got.get(first).result.content[0].text).argv;
    assert.deepEqual(argv, ['--output-dir', tmp, '--cdp-endpoint', `http://127.0.0.1:${port}`], 'the MCP attaches to the shared Chromium instead of launching one');
    await waitFor(() => state().active === true && state().role === 'watch', { timeout: 10000, message: `the owner watches while the task runs: ${JSON.stringify(state())}` });
    say({ t: 'bv_input', events: [{ type: 'click', x: 100, y: 20 }, { type: 'text', text: ' ignored' }, { type: 'key', key: 'Enter', code: 'Enter' }] });

    // Take over: the task's next browser action waits.
    say({ t: 'bv_take' });
    await waitFor(() => state().takeover === true && state().role === 'control', { timeout: 10000, message: 'take over' });
    assert.ok(fs.existsSync(path.join(browserHome, '.agent-orch-browser', 'control', 'live.takeover')));
    assert.deepEqual(typed, ['hello agent'], 'input from a watcher never reached the page');
    const held = task.send('tools/call', { name: 'browser_click', arguments: { ref: 'e1' } });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(task.got.get(held), undefined, 'the task\'s action is held while the owner has the browser');
    say({ t: 'bv_input', events: [{ type: 'click', x: 100, y: 20 }, { type: 'text', text: ' owner' }, { type: 'key', key: 'Enter', code: 'Enter' }] });
    await waitFor(() => typed.some((t) => t.endsWith(' owner')), { timeout: 15000, message: 'the owner drives while taken over' });

    // Hand back: the held action goes through.
    say({ t: 'bv_handback' });
    await waitFor(() => task.got.get(held), { timeout: 10000, message: 'the held action runs after hand-back' });
    await waitFor(() => state().takeover === false && state().role === 'watch', { timeout: 10000, message: 'back to watching' });
    assert.ok(!fs.existsSync(path.join(browserHome, '.agent-orch-browser', 'control', 'live.takeover')));

    // Closing the view while taken over hands back too.
    say({ t: 'bv_take' });
    await waitFor(() => state().takeover === true, { timeout: 10000, message: 'take over again' });
    say({ t: 'bv_close' });
    await waitFor(() => !fs.existsSync(path.join(browserHome, '.agent-orch-browser', 'control', 'live.takeover')), { timeout: 10000, message: 'closing hands back' });
    const after = task.send('tools/call', { name: 'browser_snapshot', arguments: {} });
    await waitFor(() => task.got.get(after), { timeout: 10000, message: 'the task continues' });
  } finally {
    task.child.stdin.end();
    await new Promise((r) => { if (task.child.exitCode != null) r(); else { task.child.once('exit', r); setTimeout(r, 10000); } });
    ws.close();
  }
  // The profile can be cleared once nothing uses it.
  const cleared = await api('/api/browser/clear', { method: 'POST', body: JSON.stringify({ node: 'controller', identity: 'live' }) });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
});
