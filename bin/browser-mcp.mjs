#!/usr/bin/env node
// A browser run's MCP server (browser.mjs browserServer): node bin/browser-mcp.mjs --identity <id> --home <home> -- <the
// Playwright MCP command…>. It attaches the MCP to the profile's shared Chromium (browser-live.mjs; started here when
// none runs, closed again when the run ends) with --cdp-endpoint, so the owner's live view sees the same page. While the
// owner has taken the profile over it holds every tools/call until they hand it back. It marks the profile in use while
// it runs.
import { spawn } from 'node:child_process';
import { endpointFor, launchChrome, closeChrome, markActive, takenOver } from '../browser-live.mjs';

const argv = process.argv.slice(2), sep = argv.indexOf('--');
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && i < sep ? argv[i + 1] : undefined; };
const identity = opt('--identity'), home = opt('--home');
let [cmd, ...args] = argv.slice(sep + 1);
if (sep < 0 || !cmd) { console.error('usage: browser-mcp.mjs --identity <id> --home <dir> -- <mcp command> [args…]'); process.exit(2); }
const err = (s) => process.stderr.write(`[agent-orch browser] ${s}\n`);

const unmark = markActive(identity, home);
let own = null;
try {
  const after = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  let ep = await endpointFor(identity, home);
  if (!ep) ep = own = await launchChrome({ identity, home, executable: after('--executable-path'), headless: args.includes('--headless') });
  // The MCP connects instead of launching: drop its own launch flags.
  const drop = new Set(['--user-data-dir', '--executable-path', '--browser']), out = [];
  for (let i = 0; i < args.length; i++) {
    if (drop.has(args[i])) { i++; continue; }
    if (args[i] === '--headless' || args[i] === '--no-sandbox') continue;
    out.push(args[i]);
  }
  args = [...out, '--cdp-endpoint', `http://127.0.0.1:${ep.port}`];
} catch (e) { err(`shared browser unavailable (${e.message}); the MCP launches its own`); }

const child = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.on('error', () => {});
let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  unmark();
  if (own) await closeChrome(own).catch(() => {});
  process.exit(code);
}
child.on('error', (e) => { err(e.message); finish(1); });
child.on('exit', (code, sig) => finish(code ?? (sig ? 1 : 0)));
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { child.kill('SIGTERM'); setTimeout(() => finish(1), 3000).unref(); });

// Client → MCP, one JSON-RPC message per line, in order; a tools/call waits while the profile is taken over.
const queue = [];
let buf = '', pumping = false, ended = false;
const heldCall = (line) => { try { return JSON.parse(line)?.method === 'tools/call'; } catch { return false; } };
async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    if (heldCall(queue[0])) while (takenOver(identity, home) && !finishing) await new Promise((r) => setTimeout(r, 250));
    child.stdin.write(`${queue.shift()}\n`);
  }
  pumping = false;
  if (ended) child.stdin.end();
}
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) queue.push(line); }
  pump();
});
process.stdin.on('end', () => { if (buf.trim()) queue.push(buf); ended = true; pump(); });
