// A browser run's Playwright MCP starts reliably (task #400), against a real Chromium: the pinned local MCP only (never
// npx), the profile's Chromium pre-warmed so the MCP only attaches, a startup budget above the CLIs' defaults (a 40 s
// slow start still connects; the real Claude CLI too, where its 30 s default fails), and a run whose MCP failed to
// connect restarts Chromium and retries twice before the owner sees "Browser tool couldn't start: retried twice".
// No message is sent to any model: Claude runs are an idle SDK query (mcpServerStatus) or a fake query. The MCP handshake
// needs no Chromium (Playwright MCP attaches on its first tool call). Where Chromium can't run (a macOS LaunchDaemon
// session: it dies with SIGILL), the pre-warm and restart run against fixtures/fake-chromium.mjs and opening a page is skipped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { browserServer, findBrowser, playwrightMcpCommand, MCP_START_MS, MCP_START_FAILED } from '../browser.mjs';
import { warmBrowser, closeChrome, closeProfile, endpointFor, readMcpReady } from '../browser-live.mjs';
import { runAgentCli, MCP_START_ENV, BROWSER_RETRIES, AGENTS } from '../agents.mjs';
import { createExtensions } from '../extensions.mjs';

process.env.AGENT_ORCH_BROWSER_HEADLESS = '1';
let noChromium = null; // why a real Chromium can't run here, or null
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-start-'));
const homeOf = (name) => { const h = path.join(tmp, name); fs.mkdirSync(h, { recursive: true }); return h; };
const PAGE_TITLE = 'Ranthambore hotels';
let site, siteUrl;

before(async () => {
  site = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<title>${PAGE_TITLE}</title><h1>Hotels near Ranthambore</h1>`); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}/`;
  // Can Chromium really run here? It must start and still answer a few seconds later.
  if (!findBrowser()) noChromium = 'no Chromium or Chrome on this machine';
  else {
    const home = homeOf('probe');
    try {
      const w = await warmBrowser({ identity: 'default', home, headless: true });
      await new Promise((r) => setTimeout(r, 3000));
      if (!(await endpointFor('default', home))) noChromium = 'Chromium died right after starting';
      await closeChrome(w.own).catch(() => {});
    } catch (e) { noChromium = e.message.split('\n')[0].slice(0, 200); }
  }
  if (noChromium) process.env.AGENT_ORCH_BROWSER_PATH = fileURLToPath(new URL('./fixtures/fake-chromium.mjs', import.meta.url));
});
after(() => { site?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// A minimal MCP stdio client that keeps every stdout line (they must all be JSON-RPC).
function mcpClient(server, env = {}) {
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waits = new Map(), lines = [];
  let buf = '', stderr = '', id = 0;
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      lines.push(line);
      let m; try { m = JSON.parse(line); } catch { continue; }
      waits.get(m.id)?.(m); waits.delete(m.id);
    }
  });
  child.stderr.on('data', (d) => { stderr += d; });
  const rpc = (method, params = {}, timeoutMs = 60_000) => new Promise((resolve, reject) => {
    const n = ++id, t = setTimeout(() => reject(new Error(`${method} timed out; stderr: ${stderr.slice(-800)}`)), timeoutMs);
    waits.set(n, (m) => { clearTimeout(t); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  const handshake = async (timeoutMs = MCP_START_MS) => {
    const t0 = Date.now();
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, timeoutMs);
    notify('notifications/initialized');
    return { init, ms: Date.now() - t0 };
  };
  const close = () => new Promise((r) => {
    if (child.exitCode != null || child.signalCode) return r();
    child.once('close', r);
    child.stdin.end();
    setTimeout(() => child.kill('SIGKILL'), 8000).unref();
  });
  return { rpc, handshake, close, lines, stderr: () => stderr };
}
const allJson = (lines) => lines.filter((l) => l.trim()).every((l) => { try { JSON.parse(l); return true; } catch { return false; } });

test('the browser MCP is the pinned local install with a raised startup budget, for Claude and codex', () => {
  const mcp = playwrightMcpCommand();
  assert.ok(mcp, '@playwright/mcp is installed');
  assert.equal(mcp.command, process.execPath);
  assert.match(mcp.args[0], /node_modules[\\/]@playwright[\\/]mcp[\\/]cli\.js$/);
  const s = browserServer({ identity: 'default', home: homeOf('pinned'), headed: false });
  assert.ok(!s.args.includes('npx') && !s.args.some((a) => /^-y$|@playwright\/mcp@/.test(a)), 'never npx at run time');
  assert.equal(s.startupSec, MCP_START_MS / 1000);
  assert.ok(MCP_START_MS >= 90_000);
  assert.deepEqual(MCP_START_ENV, { MCP_TIMEOUT: String(MCP_START_MS), MCP_CONNECT_TIMEOUT_MS: String(MCP_START_MS), MCP_CONNECTION_NONBLOCKING: '0' });
  // codex: startup_timeout_sec on the server's table, straight and behind the approval gate's proxy.
  const ext = createExtensions({ dataDir: homeOf('ext-data'), home: homeOf('ext-home') });
  for (const run of [{ browser: { identity: 'default', headed: false } }, { browser: { identity: 'default', headed: false }, gate: { dir: homeOf('gate'), task: 1, patterns: [], ttlMs: 60_000 } }]) {
    const profile = ext.mcpRun('codex', run);
    const toml = fs.readFileSync(path.join(homeOf('ext-home'), '.codex', `${profile}.config.toml`), 'utf8');
    const table = toml.split(/\n(?=\[mcp_servers\.)/).find((t) => t.startsWith('[mcp_servers.playwright]'));
    assert.match(table, /^startup_timeout_sec = 90$/m);
  }
});

test('pre-warm: the profile\'s CDP endpoint answers /json/version before the agent starts; it is reused, and a restart replaces it', { timeout: 120_000 }, async (t) => {
  if (noChromium) t.diagnostic(`a real Chromium can't run here (${noChromium}): using fixtures/fake-chromium.mjs`);
  const home = homeOf('prewarm');
  const warm = await warmBrowser({ identity: 'default', home, headless: true });
  let fresh;
  try {
    assert.ok(warm.own, 'started here');
    assert.ok(warm.ms >= 0);
    const v = await (await fetch(`http://127.0.0.1:${warm.port}/json/version`)).json();
    assert.equal(v.webSocketDebuggerUrl, warm.ws);
    const again = await warmBrowser({ identity: 'default', home });
    assert.equal(again.own, null, 'a running one is reused');
    assert.equal(again.ws, warm.ws);
    fresh = await warmBrowser({ identity: 'default', home, restart: true });
    assert.ok(fresh.own && fresh.ws !== warm.ws, 'a restart closes the old one and starts another');
    assert.ok(warm.own.child.exitCode != null || warm.own.child.signalCode, 'the old one is gone');
  } finally { await closeChrome(warm.own); if (fresh) await closeChrome(fresh.own); }
  assert.equal(await endpointFor('default', home), null);
});

test('pre-warmed Chromium: the MCP attaches to it within the timeout, prints only JSON-RPC and opens a page', { timeout: 180_000 }, async (t) => {
  if (noChromium) return t.skip(`a real Chromium can't run here: ${noChromium}`);
  const home = homeOf('warm');
  const warm = await warmBrowser({ identity: 'default', home, headless: true });
  try {
    assert.ok(warm.own, 'started here');
    const v = await (await fetch(`http://127.0.0.1:${warm.port}/json/version`)).json();
    assert.ok(v.webSocketDebuggerUrl, 'its CDP endpoint answers /json/version before the agent starts');
    const again = await warmBrowser({ identity: 'default', home });
    assert.equal(again.own, null, 'a running one is reused');
    assert.equal(again.port, warm.port);

    const c = mcpClient(browserServer({ identity: 'default', home, headed: false }));
    try {
      const { init, ms } = await c.handshake();
      assert.ok(init.serverInfo, 'initialize answered');
      assert.ok(ms < MCP_START_MS, `connected in ${ms} ms`);
      const ready = readMcpReady('default', home);
      assert.ok(ready && ready.readyAt >= ready.startedAt, 'the shim recorded its MCP ready time');
      const { tools } = await c.rpc('tools/list');
      assert.ok(tools.some((t) => t.name === 'browser_navigate'));
      const nav = await c.rpc('tools/call', { name: 'browser_navigate', arguments: { url: siteUrl } }, 90_000);
      assert.match(JSON.stringify(nav), new RegExp(PAGE_TITLE));
      // It drove the pre-warmed Chromium (attached over CDP, not a browser of its own).
      const targets = await (await fetch(`http://127.0.0.1:${warm.port}/json/list`)).json();
      assert.ok(targets.some((t) => t.url === siteUrl), 'the page opened in the pre-warmed Chromium');
      assert.ok(allJson(c.lines), `stdout carried only JSON-RPC: ${c.lines.find((l) => { try { JSON.parse(l); return false; } catch { return true; } })}`);
    } finally { await c.close(); }
    assert.ok(await endpointFor('default', home), 'the MCP leaves the pre-warmed Chromium running for its owner to close');
  } finally { await closeChrome(warm.own); }
});

test('a 40 s slow start still connects within the raised timeout (and the real Claude CLI waits for it, where its default gives up)', { timeout: 240_000 }, async (t) => {
  const DELAY = 40_000, slow = { AGENT_ORCH_BROWSER_MCP_DELAY_MS: String(DELAY) };
  const direct = (async () => {
    const home = homeOf('slow');
    const warm = await warmBrowser({ identity: 'default', home, headless: true });
    const c = mcpClient(browserServer({ identity: 'default', home, headed: false }), slow);
    try {
      const { ms } = await c.handshake(MCP_START_MS);
      assert.ok(ms >= DELAY && ms < MCP_START_MS, `connected after ${ms} ms`);
      assert.ok(allJson(c.lines), 'nothing but JSON-RPC on stdout, even while delayed');
    } finally { await c.close(); await closeChrome(warm.own); }
  })();
  // The Claude CLI itself: an idle query (no message, nothing billed) reports the server's connection status.
  const claudeBin = AGENTS.claude.bin, haveClaude = fs.existsSync(claudeBin);
  const viaClaude = async (name, extraEnv) => {
    const home = homeOf(name), cfg = path.join(home, 'mcp.json');
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { playwright: (({ startupSec, ...s }) => s)(browserServer({ identity: 'default', home, headed: false })) } }));
    const env = { ...process.env, ...slow, ...extraEnv };
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete env[k];
    const ac = new AbortController(), t0 = Date.now();
    const idle = (async function* () { await new Promise((r) => ac.signal.addEventListener('abort', r, { once: true })); })();
    const q = sdkQuery({ prompt: idle, options: { cwd: home, abortController: ac, pathToClaudeCodeExecutable: claudeBin, env, extraArgs: { 'mcp-config': cfg }, stderr: () => {} } });
    (async () => { try { for await (const _ of q); } catch {} })();
    try {
      for (;;) {
        const p = (await q.mcpServerStatus()).find((x) => x.name === 'playwright');
        if (p && p.status !== 'pending') return { status: p.status, error: p.error, ms: Date.now() - t0 };
        if (Date.now() - t0 > MCP_START_MS + 30_000) return { status: 'pending', ms: Date.now() - t0 };
        await new Promise((r) => setTimeout(r, 1000));
      }
    } finally { ac.abort(); await closeProfile('default', home).catch(() => {}); }
  };
  const [raised, dflt] = haveClaude ? await Promise.all([viaClaude('claude-raised', MCP_START_ENV), viaClaude('claude-default', {}), direct]) : [null, null, await direct];
  if (!haveClaude) return t.diagnostic('no Claude CLI here: only the direct MCP client was checked');
  assert.equal(raised.status, 'connected', `Claude with MCP_START_ENV: ${JSON.stringify(raised)}`);
  assert.ok(raised.ms >= DELAY, `connected after ${raised.ms} ms`);
  assert.equal(dflt.status, 'failed', `Claude's own 30 s default gives up on the same slow start: ${JSON.stringify(dflt)}`);
});

// A fake Claude SDK query: each call runs script(attempt, options) for its messages.
function fakeClaude(script) {
  const calls = [];
  const query = ({ options }) => {
    const n = calls.push({ env: options.env }) ;
    return (async function* () { yield* await script(n, options, calls[n - 1]); })();
  };
  return { query, calls };
}
const init = (status) => ({ type: 'system', subtype: 'init', session_id: 's1', mcp_servers: [{ name: 'playwright', status }] });
const success = (text) => ({ type: 'result', subtype: 'success', is_error: false, result: text, usage: {}, num_turns: 1, session_id: 's1' });

test('a forced MCP failure restarts Chromium and retries twice, then says so in owner words', { timeout: 180_000 }, async (t) => {
  const home = homeOf('retry'), events = [];
  const { query, calls } = fakeClaude(async (n, options, call) => {
    call.ws = (await endpointFor('default', home))?.ws; // the pre-warmed Chromium this attempt got
    return [init('failed'), { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'should never run' }] } }, success('never')];
  });
  const res = await runAgentCli({ agent: 'claude', prompt: 'search hotels in Ranthambore', cwd: home, query, mcp: null, env: {}, browser: { identity: 'default', home }, onEvent: (e) => events.push(e) });
  assert.equal(calls.length, 1 + BROWSER_RETRIES, 'the first run and two retries');
  assert.equal(BROWSER_RETRIES, 2);
  assert.equal(res.outcome, 'error');
  assert.equal(res.errorCode, 'mcp_connect_failed');
  assert.equal(res.text, MCP_START_FAILED);
  assert.equal(MCP_START_FAILED, "Browser tool couldn't start: retried twice");
  if (noChromium) t.diagnostic(`a real Chromium can't run here (${noChromium}): pre-warmed and restarted fixtures/fake-chromium.mjs`);
  assert.ok(calls.every((c) => c.ws), 'every attempt started with Chromium already up');
  assert.equal(new Set(calls.map((c) => c.ws)).size, calls.length, 'each retry restarted Chromium');
  for (const c of calls) {
    assert.equal(c.env.MCP_TIMEOUT, String(MCP_START_MS));
    assert.equal(c.env.MCP_CONNECTION_NONBLOCKING, '0');
  }
  assert.deepEqual(events.filter((e) => e.k === 'mcp').map((e) => [e.ok, e.attempt]), [[false, 1], [false, 2], [false, 3]]);
  assert.ok(!events.some((e) => e.k === 'text' && /should never run/.test(e.text)), 'a failed MCP stops the run before the agent works without it');
  assert.equal(await endpointFor('default', home), null, 'the pre-warmed Chromium is closed after the run');
});

test('a run that failed on the MCP (the agent said so) retries, and the retry connects the real MCP with its startup time logged', { timeout: 180_000 }, async () => {
  const home = homeOf('recover'), events = [];
  const { query, calls } = fakeClaude(async (n) => {
    if (n === 1) return [init('pending'), success('The Playwright browser tool server failed to connect (connection timeout). playwright MCP server failed to connect (CONNECT_TIMEOUT)')];
    // The retry: the real MCP (behind the shim) starts and attaches to the pre-warmed Chromium.
    const c = mcpClient(browserServer({ identity: 'default', home, headed: false }));
    try { await c.handshake(); } finally { await c.close(); }
    return [init('connected'), { type: 'assistant', session_id: 's1', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__playwright__browser_navigate', input: { url: siteUrl } }] } }, success('Found 3 hotels.')];
  });
  const res = await runAgentCli({ agent: 'claude', prompt: 'search hotels', cwd: home, query, mcp: null, env: {}, browser: { identity: 'default', home }, onEvent: (e) => events.push(e) });
  assert.equal(calls.length, 2);
  assert.equal(res.outcome, 'ok');
  assert.equal(res.text, 'Found 3 hotels.');
  const mcp = events.filter((e) => e.k === 'mcp');
  assert.deepEqual(mcp.map((e) => [e.ok, e.attempt]), [[false, 1], [true, 2]]);
  assert.ok(mcp[1].ms > 0 && mcp[1].ms < MCP_START_MS, `startup time logged: ${mcp[1].ms} ms`);
  assert.ok(mcp[1].warmMs >= 0, 'with the pre-warm time');
});

test('a run whose browser tools worked is never retried, even if its reply mentions a connect failure', { timeout: 120_000 }, async () => {
  const home = homeOf('worked');
  const { query, calls } = fakeClaude(async () => [init('connected'),
    { type: 'assistant', session_id: 's1', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__playwright__browser_navigate', input: { url: siteUrl } }] } },
    success('The hotel site said: MCP server failed to connect (CONNECT_TIMEOUT).')]);
  const res = await runAgentCli({ agent: 'claude', prompt: 'x', cwd: home, query, mcp: null, env: {}, browser: { identity: 'default', home } });
  assert.equal(calls.length, 1);
  assert.equal(res.outcome, 'ok');
});
