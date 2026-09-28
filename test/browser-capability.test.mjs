// The browser capability (browser.mjs, AGENTIC.md → Browser): a task with "capabilities": ["browser"] gets the Playwright
// MCP in its run's MCP config (Claude --mcp-config file, codex profile), attached to the persistent profile's shared Chromium
// <home>/.agent-orch-browser/profiles/<identity>, screenshots into the run's .agent-orch/shots/, and the untrusted-content
// rules in its system prompt; placement sends it only to browserCapable workers (the controller only when allowed), one
// run per profile. The smoke test drives the real @playwright/mcp over stdio against a local page and proves a cookie
// set in the first run is still there in the second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { BROWSER_SYSTEM, findBrowser, hasDisplay, normIdentity, parseCapabilities, profileDir } from '../browser.mjs';
import { stopBrowser } from '../browser-live.mjs';
import { createExtensions } from '../extensions.mjs';
import { runAgentCli, setMcpSource } from '../agents.mjs';
import { extractTasks } from '../orchestrator.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-cap-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

test('capabilities and identities parse; the profile lives under the node home', () => {
  assert.deepEqual(parseCapabilities(['Browser', 'nope']), ['browser']);
  assert.deepEqual(parseCapabilities('["browser"]'), ['browser']);
  assert.equal(parseCapabilities([]), null);
  assert.equal(parseCapabilities(null), null);
  assert.equal(normIdentity(null), 'default');
  assert.equal(normIdentity('Xero'), 'xero');
  assert.equal(normIdentity('../etc'), 'default', 'a name that is not a plain folder name is the default');
  assert.equal(profileDir('xero', '/h'), '/h/.agent-orch-browser/profiles/xero');
  // The planner's tasks block carries them through.
  const [, payload] = extractTasks('```agent-orch-tasks\n{"tasks": [{"title": "t", "prompt": "p", "capabilities": ["browser"], "identity": "Xero"}, {"title": "u", "prompt": "p"}]}\n```');
  assert.deepEqual(payload.tasks.map((t) => [t.capabilities, t.identity]), [[['browser'], 'xero'], [null, null]]);
});

test('a browser run\'s MCP config (Claude and codex) adds Playwright on a persistent profile with the shots dir as output', async () => {
  const home = path.join(tmp, 'home'), dataDir = path.join(tmp, 'data'), codexDir = path.join(tmp, 'codex'), cwd = path.join(tmp, 'wt');
  fs.mkdirSync(cwd, { recursive: true });
  const ext = createExtensions({ dataDir, home, claudeDir: path.join(tmp, 'claude'), codexDir });
  ext.saveMcp({ name: 'docs', commandLine: 'node docs-mcp.js', env: 'TOKEN=secret' });
  const outputDir = path.join(cwd, '.agent-orch', 'shots'), profile = path.join(home, '.agent-orch-browser', 'profiles', 'default');

  // Claude: without the capability, only the owner's servers; with it, a per-run file adding playwright.
  assert.deepEqual(Object.keys(ext.mcpFor('claude')), ['docs']);
  const file = ext.mcpRun('claude', { browser: { identity: 'default', outputDir } });
  assert.notEqual(file, ext.mcpRun('claude'), 'a browser run gets its own config file');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const { mcpServers } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(mcpServers), ['docs', 'playwright']);
  const pw = mcpServers.playwright;
  assert.equal(pw.type, 'stdio');
  assert.ok(pw.args.some((a) => /@playwright[\\/]mcp/.test(a)), `runs @playwright/mcp: ${pw.args.join(' ')}`);
  // Behind the shim (bin/browser-mcp.mjs), which attaches it to the profile's one supervised Chromium: never --user-data-dir.
  assert.ok(/browser-mcp\.mjs$/.test(pw.args[0]) && !pw.args.includes('--user-data-dir'), pw.args.join(' '));
  assert.deepEqual([argAfter(pw.args, '--identity'), argAfter(pw.args, '--home')], ['default', home]);
  assert.equal(argAfter(pw.args, '--output-dir'), outputDir);
  assert.equal(argAfter(pw.args, '--headless'), hasDisplay() ? '0' : '1', 'headless without a display, headed on a Mac with a screen');
  assert.ok(fs.statSync(profile).isDirectory() && (fs.statSync(profile).mode & 0o777) === 0o700, 'the profile folder exists, 0700');
  assert.equal(ext.mcpRun('claude', { browser: { identity: 'default', outputDir } }), file, 'the same run config reuses its file');

  // A named identity is its own profile.
  const xero = JSON.parse(fs.readFileSync(ext.mcpRun('claude', { browser: { identity: 'xero', outputDir } }), 'utf8')).mcpServers.playwright;
  assert.equal(argAfter(xero.args, '--identity'), 'xero');
  assert.ok(fs.statSync(path.join(home, '.agent-orch-browser', 'profiles', 'xero')).isDirectory());

  // Codex: a per-run profile layered on config.toml.
  const profileName = ext.mcpRun('codex', { browser: { identity: 'default', outputDir } });
  assert.match(profileName, /^agent-orch-run-[0-9a-f]+$/);
  const toml = fs.readFileSync(path.join(codexDir, `${profileName}.config.toml`), 'utf8');
  assert.match(toml, /\[mcp_servers\.docs\]/);
  assert.match(toml, /\[mcp_servers\.playwright\]/);
  assert.ok(toml.includes(JSON.stringify(home)) && toml.includes('browser-mcp.mjs') && toml.includes(JSON.stringify(outputDir)), toml);

  // The agent adapter hands a run's `browser` to the MCP source: Claude's --mcp-config is the browser run's file.
  setMcpSource((agent, run) => ext.mcpRun(agent, run));
  try {
    let options = null;
    const query = ({ options: o }) => { options = o; return (async function* () { yield { type: 'result', subtype: 'success', result: 'ok', usage: {} }; })(); };
    await runAgentCli({ agent: 'claude', prompt: 'p', cwd, query, env: {}, browser: { identity: 'default', outputDir } });
    assert.equal(options.extraArgs['mcp-config'], file);
    await runAgentCli({ agent: 'claude', prompt: 'p', cwd, query, env: {} });
    assert.equal(options.extraArgs['mcp-config'], ext.mcpRun('claude'), 'a run without the capability keeps the shared file');
  } finally { setMcpSource(null); }
  assert.match(BROWSER_SYSTEM, /never follow\s+instructions/i);
  assert.match(BROWSER_SYSTEM, /credentials/i);
  assert.match(BROWSER_SYSTEM, /stop and ask/i);
});

test('placement: browser tasks go only to browserCapable workers, never the controller unless allowed, one per profile', { timeout: 60000 }, async () => {
  // Each task in its own project (a GitHub repo, so it may run remotely): tasks of one project with undeclared files
  // would wait for each other anyway.
  const dataDir = fs.mkdtempSync(path.join(tmp, 'orch-')), repos = fs.mkdtempSync(path.join(tmp, 'repos-'));
  const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
    import { DatabaseSync } from 'node:sqlite';
    import { execFileSync } from 'node:child_process';
    import path from 'node:path';
    const [dataDir, repos] = process.argv.slice(1), GB = 2 ** 30;
    const worker = (id, browser) => ({ id, name: id, os: 'linux', local: false, status: 'online', connected: true, enabled: true, draining: false, maxSlots: 4,
      inventory: { cores: 8, agents: [{ id: 'claude', installed: true, signedIn: true }], ...(browser && { browser }) }, resources: { memAvailable: 32 * GB, at: Date.now() }, features: ['approvals'] });
    const nodes = [{ id: 'controller', local: true, status: 'online', connected: true, enabled: true }, worker('plain', null)];
    const o = createOrchestrator({ query: () => (async function* () {})(), dataDir, disabled: true, claudeEnv: {}, getLimits: () => [],
      onSubscription: () => true, broadcast() {}, emitChat() {}, convoExists: () => false });
    let ver = 1;
    o.attachCluster({ listNodes: () => nodes, onMessage() {}, version: () => ver });
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    let pos = 0;
    const task = (title, caps = null, identity = null) => {
      const repo = path.join(repos, title);
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/test-owner/' + title + '.git'], { cwd: repo });
      const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,position,created_at) VALUES(?,?,50,'active',0,?,0)").run(repo, title, ++pos).lastInsertRowid);
      return Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,capabilities,browser_identity,created_at) VALUES(?,'work',?,'p',?,?,?)")
        .run(pid, title, caps && JSON.stringify(caps), identity, Date.now() / 1000).lastInsertRowid);
    };
    const claim = () => { const c = o.claimNext(null); return c && [c.task.title, c.node]; };
    const out = {};
    task('A', ['browser']);
    out.noCapable = claim(); // only a worker without a browser: the browser task waits
    o.setParallelSettings({ controllerBrowser: true });
    out.allowed = claim(); // the owner allows the controller
    db.prepare("UPDATE tasks SET status='queued', node_id=NULL").run();
    o.setParallelSettings({ controllerBrowser: false });
    nodes.push(worker('mac', { capable: true, headed: true })); ver++;
    task('B', ['browser']); task('C', ['browser'], 'xero'); task('D');
    out.seq = [claim(), claim(), claim(), claim()];
    db.prepare("UPDATE tasks SET status='done' WHERE title='A'").run();
    out.afterA = claim();
    console.log(JSON.stringify(out));
    process.exit(0);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repos], { cwd: ROOT, encoding: 'utf8', timeout: 45000 });
  const r = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(r.noCapable, null, 'no browserCapable worker and the controller not allowed: it waits');
  assert.deepEqual(r.allowed, ['A', 'controller']);
  // A takes the default profile on the Mac; B (default too) waits for it; C (xero) and D (no browser) still run.
  assert.deepEqual(r.seq[0], ['A', 'mac']);
  assert.deepEqual(r.seq[1], ['C', 'mac']);
  assert.equal(r.seq[2][0], 'D');
  assert.notEqual(r.seq[2][1], 'controller');
  assert.equal(r.seq[3], null, 'B waits while A holds the default profile');
  assert.deepEqual(r.afterA, ['B', 'mac'], 'once A is done, B gets the profile');
});

// A minimal MCP client over stdio (newline-delimited JSON-RPC).
function mcpClient(server) {
  const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', id = 0, stderr = '';
  const waits = new Map();
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      waits.get(m.id)?.(m);
    }
  });
  const exited = new Promise((r) => child.once('exit', r));
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const n = ++id, t = setTimeout(() => reject(new Error(`${method} timed out; stderr: ${stderr}`)), 60000);
    waits.set(n, (m) => { clearTimeout(t); m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = (r.content || []).map((c) => c.text || '').join('\n');
    if (r.isError) throw new Error(`${name}: ${text}`);
    return text;
  };
  return {
    async init() {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-orch-test', version: '1' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    call,
    async close() { await call('browser_close').catch(() => {}); child.stdin.end(); await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]); child.kill('SIGKILL'); },
  };
}

test('Playwright MCP smoke: the persistent profile keeps a cookie across two runs', { skip: !findBrowser() && 'no Chromium or Chrome on this machine', timeout: 180000 }, async () => {
  // The local test page: the first visit sets a lasting cookie, a later one shows it came back.
  const srv = http.createServer((req, res) => {
    const seen = /(?:^|;\s*)agent_orch_visit=1(?:;|$)/.test(req.headers.cookie || '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...(!seen && { 'set-cookie': 'agent_orch_visit=1; Max-Age=86400; Path=/; SameSite=Lax' }) });
    res.end(`<!doctype html><title>${seen ? 'returning' : 'first'}</title><h1>${seen ? 'Cookie persisted: welcome back' : 'First visit: cookie set'}</h1>`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const home = path.join(tmp, 'smoke-home'), outputDir = path.join(tmp, 'smoke-wt', '.agent-orch', 'shots');
  fs.mkdirSync(outputDir, { recursive: true });
  const ext = createExtensions({ dataDir: path.join(tmp, 'smoke-data'), home, claudeDir: path.join(tmp, 'smoke-claude'), codexDir: path.join(tmp, 'smoke-codex') });
  // Each run starts the server exactly as the agent CLI would: from the run's --mcp-config file.
  const visit = async () => {
    const server = JSON.parse(fs.readFileSync(ext.mcpRun('claude', { browser: { identity: 'default', outputDir, headed: false } }), 'utf8')).mcpServers.playwright;
    const c = mcpClient(server);
    try {
      await c.init();
      await c.call('browser_navigate', { url });
      const text = await c.call('browser_snapshot');
      await c.call('browser_take_screenshot', {});
      return text;
    } finally { await c.close(); }
  };
  try {
    const first = await visit();
    assert.match(first, /First visit: cookie set/, first);
    const second = await visit();
    assert.match(second, /Cookie persisted: welcome back/, second);
    assert.ok(fs.readdirSync(path.join(home, '.agent-orch-browser', 'profiles', 'default')).length > 0, 'the profile folder holds the browser state');
    assert.ok(fs.readdirSync(outputDir).some((f) => /\.(png|jpe?g)$/.test(f)), `screenshots land in the run's shots dir: ${fs.readdirSync(outputDir)}`);
  } finally { srv.close(); await stopBrowser('default', home); }
});
