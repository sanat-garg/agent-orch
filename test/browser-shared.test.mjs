// One shared browser per profile, end to end with real Chromium (browser-live.mjs's supervisor, bin/browser-mcp.mjs and
// the real @playwright/mcp): the owner's live view (server.mjs /ws) and an agent's MCP use the SAME profile at once. The
// MCP config never gets --user-data-dir; the MCP opens its own tab, navigates and clicks, and the viewer follows that tab
// ('Agent tab') and receives non-black frames of it (decoded: pixel variance > 0). Killing Chromium makes the supervisor
// restart it within 10 s; the viewer says 'reconnecting', then resumes frames, and the MCP's next call succeeds. Only one
// Chromium main process exists for the profile throughout.
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
import { chromium } from 'playwright-core';
import { browserServer, findBrowser, profileDir } from '../browser.mjs';
import { browserState, browserEndpoint, stopBrowser } from '../browser-live.mjs';
import { waitFor as wait } from './helpers/wait.mjs';
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'browser-shared-password';
Object.assign(process.env, macChromiumEnv(), { AGENT_ORCH_BROWSER_HEADLESS: '1' }); // the MacBook worker's LaunchDaemon needs the shim
const skip = !findBrowser() && 'no Chromium or Chrome on this machine';
let tmp, browserHome, profile, page, pageUrl, server, base, cookie, decoder, out = '';
const reports = [];

// waitFor with a message that may be a function (read only on a timeout).
const waitFor = (c, o = {}) => wait(c, { ...o, message: '' }).catch(() => { throw new Error(`Timed out: ${typeof o.message === 'function' ? o.message() : o.message}`); });
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-shared-'));
  browserHome = path.join(tmp, 'home');
  profile = profileDir('shared', browserHome);
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  // Pages that are never one flat colour: blue/yellow stripes with a Go button that turns them green/white.
  page = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/report') { reports.push(Object.fromEntries(u.searchParams)); res.end('ok'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Shared ${u.pathname}</title>
      <body style="margin:0;height:100vh;background:repeating-linear-gradient(45deg,#1e6fd9 0 40px,#f2c230 40px 80px)">
      <button id="go" style="margin:40px;font:bold 32px sans-serif;padding:20px 40px">Go</button>
      <script>document.getElementById('go').onclick = () => {
        document.body.style.background = 'repeating-linear-gradient(45deg,#10c040 0 40px,#ffffff 40px 80px)';
        document.title = 'Clicked'; fetch('/report?kind=click');
      };</script>`);
  });
  await new Promise((r) => page.listen(0, '127.0.0.1', r));
  pageUrl = `http://127.0.0.1:${page.address().port}/`;
  process.env.AGENT_ORCH_BROWSER_HOME_URL = `${pageUrl}home`; // where a (re)started browser opens
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1', AGENT_ORCH_BROWSER_HOME: browserHome } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
  // A separate throwaway browser decodes the viewer's JPEG frames.
  decoder = await chromium.launch().catch(() => chromium.launch({ executablePath: findBrowser() }));
});

after(async () => {
  await decoder?.close().catch(() => {});
  if (browserHome) await stopBrowser('shared', browserHome).catch(() => {});
  server?.kill('SIGKILL');
  page?.close();
  if (tmp) { try { execFileSync('pkill', ['-KILL', '-f', browserHome]); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); }
});

// A frame's pixels: size, mean and variance of the luminance, and the share of green (the clicked page) pixels.
async function decode(data) {
  const p = decoder.contexts()[0]?.pages()[0] || await (await decoder.newContext()).newPage();
  return p.evaluate(async (d) => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${d}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0, sq = 0, green = 0;
    for (let i = 0; i < px.length; i += 4 * 7) {
      const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      n++; sum += y; sq += y * y;
      if (px[i + 1] > 150 && px[i] < 90 && px[i + 2] < 120) green++;
    }
    const mean = sum / n;
    return { w: c.width, h: c.height, mean, variance: sq / n - mean * mean, green: green / n };
  }, data);
}
// The profile's Chromium main processes (not its renderers and helpers, which carry --type=).
function mains() {
  const ps = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return ps.split('\n').filter((l) => l.includes(`--user-data-dir=${profile}`) && !l.includes('--type=')).map((l) => Number(l.trim().split(/\s+/)[0]));
}
// A minimal MCP client over stdio.
function mcpClient(command, args) {
  const c = spawn(command, args, { cwd: tmp, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', id = 0, stderr = '';
  const got = new Map();
  c.stderr.on('data', (d) => { stderr += d; });
  c.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id != null) got.set(m.id, m); }
  });
  const send = (method, params) => { const n = ++id; c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); return n; };
  return {
    child: c, stderr: () => stderr, send,
    notify: (method, params = {}) => c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    async call(name, args = {}, timeout = 60000) {
      const n = send('tools/call', { name, arguments: args });
      await waitFor(() => got.has(n), { timeout, message: `${name} answers: ${stderr.slice(-2000)}` });
      const m = got.get(n);
      return { ...m.result, error: m.error, text: (m.result?.content || []).map((x) => x.text || '').join('\n') };
    },
    async request(method, params, timeout = 30000) {
      const n = send(method, params);
      await waitFor(() => got.has(n), { timeout, message: `${method} answers: ${stderr.slice(-2000)}` });
      return got.get(n);
    },
  };
}

test('a browser run\'s MCP attaches to the profile\'s shared Chromium, never launching one on the profile', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-shared-cfg-'));
  try {
    const s = browserServer({ identity: 'Xero', home, outputDir: '/tmp/shots', headed: false, executable: '/bin/chrome' });
    assert.equal(s.command, process.execPath);
    assert.match(s.args[0], /bin[\\/]browser-mcp\.mjs$/);
    const at = (f) => s.args[s.args.indexOf(f) + 1];
    assert.deepEqual([at('--identity'), at('--home'), at('--executable'), at('--headless')], ['xero', home, '/bin/chrome', '1']);
    const mcp = s.args.slice(s.args.indexOf('--') + 1);
    assert.ok(mcp.some((a) => /@playwright[\\/]mcp/.test(a)), mcp.join(' '));
    for (const f of ['--user-data-dir', '--executable-path', '--browser', '--headless']) assert.ok(!mcp.includes(f), `the MCP gets no ${f}: ${mcp.join(' ')}`);
    assert.equal(at('--output-dir'), '/tmp/shots');
    // Only an explicitly isolated run launches a browser of its own, on a throwaway profile.
    const iso = browserServer({ identity: 'xero', home, isolated: true, executable: '/bin/chrome' });
    assert.ok(!iso.args.some((a) => /browser-mcp\.mjs$/.test(a)) && iso.args.includes('--isolated') && !iso.args.includes('--user-data-dir'), iso.args.join(' '));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the live view and the agent\'s MCP share one self-healing Chromium on the profile', { skip, timeout: 300000 }, async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie } });
  const frames = [], states = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'bv_frame') frames.push({ ...m, at: Date.now() });
    else if (m.t === 'bv_state' || m.t === 'bv_error') states.push({ ...m, at: Date.now() });
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const say = (m) => ws.send(JSON.stringify({ node: 'controller', identity: 'shared', ...m }));
  const state = () => states.at(-1) || {};
  // A decoded frame at or after index `from` that passes ok(pixels), within the timeout.
  async function frameWhere(from, ok, message, timeout = 30000) {
    let seen = null;
    await waitFor(async () => {
      const f = frames.slice(from).at(-1);
      if (!f) return false;
      seen = await decode(f.data);
      return ok(seen);
    }, { timeout, interval: 300, message: () => `${message}: ${JSON.stringify(seen)} ${JSON.stringify(state())}\n${out.slice(-2000)}` });
    return seen;
  }

  // The owner opens the view first: the supervisor starts the profile's Chromium.
  say({ t: 'bv_open', size: { width: 1000, height: 700, dpr: 1 } });
  await waitFor(() => state().role === 'control' && frames.length > 0, { timeout: 60000, message: () => `the view opens with a first frame: ${JSON.stringify(states.slice(-3))}\n${out.slice(-3000)}` });
  const counts = [];
  const sampler = setInterval(() => { try { counts.push(mains().length); } catch {} }, 250);

  const cfg = browserServer({ identity: 'shared', home: browserHome, outputDir: tmp, headed: false });
  assert.ok(!cfg.args.includes('--user-data-dir'));
  const mcp = mcpClient(cfg.command, cfg.args);
  try {
    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'browser-shared-test', version: '1' } }, 60000);
    assert.ok(init.result, JSON.stringify(init));
    mcp.notify('notifications/initialized');

    // The agent navigates in its own tab; the viewer follows it and shows it as the agent's.
    const nav = await mcp.call('browser_navigate', { url: pageUrl });
    assert.ok(!nav.isError && !nav.error, `navigate: ${nav.text || JSON.stringify(nav.error)}`);
    await waitFor(() => state().url === pageUrl && state().agentTab === true && state().active === true, { timeout: 30000, message: () => `the viewer follows the agent's tab: ${JSON.stringify(state())}` });
    assert.deepEqual(mains().length, 1, 'one Chromium for the profile while both use it');

    // It clicks; the page changes and the viewer sees it.
    const snap = await mcp.call('browser_snapshot');
    const ref = /button "Go"[^\n]*\[ref=(\w+)\]/.exec(snap.text)?.[1];
    assert.ok(ref, `the snapshot shows the button: ${snap.text.slice(0, 1500)}`);
    const n0 = frames.length;
    const click = await mcp.call('browser_click', { element: 'Go button', target: ref, ref });
    assert.ok(!click.isError && !click.error, `click: ${click.text || JSON.stringify(click.error)}`);
    await waitFor(() => reports.some((r) => r.kind === 'click'), { timeout: 15000, message: 'the click reaches the page' });
    const px = await frameWhere(n0, (p) => p.variance > 0 && p.green > 0.1, 'a non-black frame of the clicked page');
    assert.ok(px.variance > 0 && px.mean > 10, JSON.stringify(px));

    // Chromium dies: the supervisor restarts it within 10 s, the viewer reconnects and gets frames again.
    const dead = browserState('shared', browserHome).chromePid;
    assert.deepEqual(mains(), [dead], 'the supervisor\'s Chromium is the profile\'s only one');
    const s0 = states.length, t0 = Date.now();
    process.kill(dead, 'SIGKILL');
    await waitFor(async () => { const e = await browserEndpoint('shared', browserHome); return e && e.pid !== dead; }, { timeout: 10000, message: 'a supervised restart within 10 s' });
    const restartMs = Date.now() - t0;
    await waitFor(() => states.slice(s0).some((s) => s.reconnecting), { timeout: 10000, message: () => `the viewer says it is reconnecting: ${JSON.stringify(states.slice(s0))}` });
    await waitFor(() => state().reconnecting === false && !state().closed, { timeout: 30000, message: () => `the viewer reconnects: ${JSON.stringify(state())}` });
    const n1 = frames.length;
    const back = await frameWhere(n1, (p) => p.variance > 0 && p.mean > 10, 'frames resume after the restart');
    assert.ok(back.variance > 0);

    // The agent's next call reconnects to the same endpoint and works.
    const again = await mcp.call('browser_navigate', { url: `${pageUrl}after` });
    assert.ok(!again.isError && !again.error, `the next MCP call succeeds: ${again.text || JSON.stringify(again.error)}`);
    await waitFor(() => state().url === `${pageUrl}after`, { timeout: 30000, message: () => `the viewer shows the agent's page: ${JSON.stringify(state())}` });
    const n2 = frames.length;
    await frameWhere(n2, (p) => p.variance > 0 && p.mean > 10, 'non-black frames of the agent\'s page after the restart');
    console.log(`# supervised restart after ${restartMs} ms`);
    assert.ok(restartMs < 10000);
  } finally {
    clearInterval(sampler);
    mcp.child.stdin.end();
    await new Promise((r) => { if (mcp.child.exitCode != null) r(); else { mcp.child.once('exit', r); setTimeout(r, 10000); } });
    ws.close();
  }
  assert.ok(counts.length > 10 && Math.max(...counts) === 1, `exactly one Chromium main process for the profile throughout (samples: ${[...new Set(counts)]})`);
});
