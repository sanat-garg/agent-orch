#!/usr/bin/env node
// A browser run's MCP server (browser.mjs browserServer): node bin/browser-mcp.mjs --identity <id> --home <home>
// [--executable <path>] [--headless 1|0] -- <the Playwright MCP command…>. It attaches the MCP to the profile's one
// supervised Chromium (browser-live.mjs startBrowser: started when none runs) with --cdp-endpoint, so the owner's live
// view shows the same browser, and never lets the MCP launch its own on the profile (Chromium allows one per profile).
// The DevTools port survives a Chromium restart, so the MCP's next call reconnects. Before the agent's first browser
// action it opens the agent's own tab (closing the previous run's) and records it for the live view to follow. While
// the owner has taken the profile over it holds every tools/call until they hand it back. It marks the profile in use
// while it runs. stdout carries only the MCP's JSON-RPC lines (anything else it prints goes to stderr, so nothing breaks
// the client's handshake), and the moment the MCP answers `initialize` is written to browser-live's mcpReadyFile.
// AGENT_ORCH_BROWSER_MCP_DELAY_MS (tests only) delays the start, to simulate a slow machine.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startBrowser, markActive, holdBrowser, takenOver, setAgentTab, lastAgentTab, mcpReadyFile } from '../browser-live.mjs';

const startedAt = Date.now();

const argv = process.argv.slice(2), sep = argv.indexOf('--');
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && i < sep ? argv[i + 1] : undefined; };
const identity = opt('--identity'), home = opt('--home');
let [cmd, ...args] = argv.slice(sep + 1);
if (sep < 0 || !cmd) { console.error('usage: browser-mcp.mjs --identity <id> --home <dir> [--executable <path>] [--headless 1|0] -- <mcp command> [args…]'); process.exit(2); }
const err = (s) => process.stderr.write(`[agent-orch browser] ${s}\n`);
const after = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const delay = Number(process.env.AGENT_ORCH_BROWSER_MCP_DELAY_MS) || 0;
if (delay > 0) { err(`delaying the start by ${delay} ms (AGENT_ORCH_BROWSER_MCP_DELAY_MS)`); await new Promise((r) => setTimeout(r, delay)); }
const unmark = markActive(identity, home), unhold = holdBrowser(identity, home);
let ep;
try {
  const headless = opt('--headless') ?? (args.includes('--headless') ? '1' : undefined);
  ep = await startBrowser(identity, { home, ...((opt('--executable') || after('--executable-path')) && { executable: opt('--executable') || after('--executable-path') }),
    ...(headless != null && { headless: headless === '1' }) });
} catch (e) {
  err(`the shared browser could not start: ${e.message}`);
  unmark(); unhold();
  process.exit(1);
}
// The MCP connects instead of launching: drop any launch flags of its own.
const drop = new Set(['--user-data-dir', '--executable-path', '--browser']), out = [];
for (let i = 0; i < args.length; i++) {
  if (drop.has(args[i])) { i++; continue; }
  if (['--headless', '--no-sandbox', '--isolated'].includes(args[i])) continue;
  out.push(args[i]);
}
const cdp = `http://127.0.0.1:${ep.port}`;
args = [...out, '--cdp-endpoint', cdp];

const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
child.stdin.on('error', () => {});
let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  unmark(); unhold();
  process.stdout.write('', () => process.exit(code)); // the MCP's last lines reach the client first
}
child.on('error', (e) => { err(e.message); finish(1); });
child.on('close', (code, sig) => finish(code ?? (sig ? 1 : 0)));
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { child.kill('SIGTERM'); setTimeout(() => finish(1), 3000).unref(); });

// MCP → client: JSON-RPC lines only; the answers to the shim's own calls stay here. The answer to the client's
// initialize marks the MCP ready.
const mine = new Map(); // id → resolve
let obuf = '', initId, ready = false;
function markReady() {
  ready = true;
  const readyAt = Date.now(), f = mcpReadyFile(identity, home);
  err(`MCP ready in ${readyAt - startedAt} ms`);
  try { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, JSON.stringify({ pid: process.pid, startedAt, readyAt })); } catch {}
}
child.stdout.on('data', (d) => {
  obuf += d;
  let i;
  while ((i = obuf.indexOf('\n')) >= 0) {
    const line = obuf.slice(0, i);
    obuf = obuf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { process.stderr.write(`${line}\n`); continue; }
    const id = m?.id;
    if (typeof id === 'string' && mine.has(id)) { mine.get(id)(); mine.delete(id); continue; }
    // Recorded before the client sees the answer, so a client reading mcpReadyFile right after its handshake finds it.
    if (!ready && initId !== undefined && id === initId && m.result) markReady();
    process.stdout.write(`${line}\n`);
  }
});
child.stdout.on('end', () => { if (obuf.trim()) { let json = true; try { JSON.parse(obuf); } catch { json = false; } (json ? process.stdout : process.stderr).write(`${obuf}\n`); } });

// The agent's own tab: opened through the MCP (so it is the MCP's current tab) before its first action.
const pages = async () => { try { return (await (await fetch(`${cdp}/json/list`, { signal: AbortSignal.timeout(3000) })).json()).filter((t) => t.type === 'page'); } catch { return []; } };
async function agentTab() {
  const before = new Set((await pages()).map((t) => t.id)), prev = lastAgentTab(identity, home), id = `agent-orch-tab-${process.pid}`;
  await new Promise((resolve) => {
    mine.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'browser_tabs', arguments: { action: 'new' } } })}\n`);
    setTimeout(resolve, 60_000).unref();
  });
  const tab = (await pages()).find((t) => !before.has(t.id));
  if (tab) setAgentTab(identity, tab.id, home);
  if (tab && prev && prev !== tab.id && before.has(prev)) await fetch(`${cdp}/json/close/${prev}`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
}

// Client → MCP, one JSON-RPC message per line, in order; a tools/call waits while the profile is taken over.
const queue = [];
let buf = '', pumping = false, ended = false, tabbed = false;
const heldCall = (line) => { try { return JSON.parse(line)?.method === 'tools/call'; } catch { return false; } };
async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    if (heldCall(queue[0])) {
      while (takenOver(identity, home) && !finishing) await new Promise((r) => setTimeout(r, 250));
      if (!tabbed) { tabbed = true; await agentTab().catch((e) => err(`could not open the agent's tab: ${e.message}`)); }
    }
    child.stdin.write(`${queue.shift()}\n`);
  }
  pumping = false;
  if (ended) child.stdin.end();
}
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    if (initId === undefined) { try { const m = JSON.parse(line); if (m?.method === 'initialize') initId = m.id; } catch {} }
    queue.push(line);
  }
  pump();
});
process.stdin.on('end', () => { if (buf.trim()) queue.push(buf); ended = true; pump(); });
