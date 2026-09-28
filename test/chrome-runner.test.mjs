// Browser tasks through Claude in Chrome (chrome.mjs, .agent-orch/CHROME.md): a node's 'chrome' capability is detected
// from Chrome, the Claude extension, its native host and a desktop session; a browser task goes to a chrome node with the
// SDK option extraArgs {chrome: null} (job.start.chrome) and falls back to the built-in browser only while no chrome node
// is online; the owner's "Don't allow" rules hold an extension tool call for approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CHROME_EXTENSION_ID, CHROME_HOST, browserRoute, chromeTool, detectChrome, judgeChrome, runnerLabel } from '../chrome.mjs';
import { answer } from '../gate.mjs';
import { gateHooks, runAgentCli } from '../agents.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-runner-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

test('detection: Chrome, the extension in a profile, the native host and a desktop session (stubbed paths)', () => {
  const home = path.join(tmp, 'home'), apps = path.join(tmp, 'Applications');
  const support = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  const opts = (extra = {}) => ({ home, platform: 'darwin', env: {}, apps: [apps], gui: () => true, ...extra });
  assert.deepEqual(detectChrome(opts()), { capable: false, chrome: false, extension: false, nativeHost: false, gui: true, reason: 'Google Chrome is not installed' });
  fs.mkdirSync(path.join(apps, 'Google Chrome.app'), { recursive: true });
  fs.mkdirSync(path.join(support, 'Profile 2'), { recursive: true });
  assert.match(detectChrome(opts()).reason, /extension is not installed/);
  fs.mkdirSync(path.join(support, 'Profile 2', 'Extensions', CHROME_EXTENSION_ID, '1.0.0'), { recursive: true });
  assert.match(detectChrome(opts()).reason, /native host is not registered/);
  fs.mkdirSync(path.join(support, 'NativeMessagingHosts'), { recursive: true });
  fs.writeFileSync(path.join(support, 'NativeMessagingHosts', `${CHROME_HOST}.json`), '{}');
  assert.deepEqual(detectChrome(opts()), { capable: true, chrome: true, extension: true, nativeHost: true, gui: true });
  // No desktop session (the hidden agentorch user), a setup-token sign-in, or not a Mac: not capable.
  assert.match(detectChrome(opts({ gui: () => false })).reason, /no desktop session/);
  assert.match(detectChrome(opts({ gui: () => { throw new Error('stat failed'); } })).reason, /no desktop session/);
  assert.match(detectChrome(opts({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } })).reason, /setup token/);
  assert.equal(detectChrome(opts({ platform: 'linux' })).capable, false);
});

const chromeNode = (id, extra = {}) => ({ id, name: `Chrome on ${id}`, os: 'darwin', local: false, status: 'online', connected: true, enabled: true,
  features: ['approvals', 'browser-task', 'chrome'], inventory: { chrome: { capable: true }, chromeRunner: true }, ...extra });

test('browserRoute: a chrome node online wins for Claude; otherwise the built-in browser, with a note', () => {
  const pw = { id: 'pw', name: 'VPS2', local: false, status: 'online', connected: true, enabled: true, features: ['approvals', 'browser-task'], inventory: { browser: { capable: true } } };
  const r = browserRoute([{ id: 'controller', local: true }, pw, chromeNode('mac')]);
  assert.deepEqual(r, { mode: 'chrome', nodes: ['mac'], name: 'Chrome on mac' });
  assert.equal(runnerLabel(r), 'Using Chrome on mac');
  assert.equal(runnerLabel({ mode: 'chrome', name: "Sanat's Macbook Pro" }), "Using Chrome on Sanat's Macbook Pro");
  const off = browserRoute([pw, chromeNode('mac', { connected: false })]);
  assert.equal(off.mode, 'builtin');
  assert.match(off.note, /No Chrome runner is online/);
  assert.equal(runnerLabel(off), 'Built-in browser');
  assert.equal(browserRoute([chromeNode('mac', { features: ['approvals'] })]).mode, 'builtin', 'a worker without the chrome feature');
  assert.equal(browserRoute([chromeNode('mac')], { agent: 'codex' }).mode, 'builtin', 'Claude in Chrome is Claude only');
});

test('a Claude run with chrome gets extraArgs {chrome: null}, no Playwright MCP, and the gate hook', async () => {
  let seen = null;
  const query = ({ options }) => { seen = options; return (async function* () { yield { type: 'result', subtype: 'success', result: 'done', usage: {} }; })(); };
  const gate = { dir: path.join(tmp, 'gate-opt'), task: 7, rules: [], ttlMs: 60_000 };
  const res = await runAgentCli({ agent: 'claude', prompt: 'p', cwd: tmp, query, bin: '/bin/true', chrome: true, gate, browser: { identity: 'default' }, mcp: null });
  assert.equal(res.outcome, 'ok');
  assert.deepEqual(seen.extraArgs, { chrome: null });
  assert.equal(typeof seen.hooks?.PreToolUse?.[0]?.hooks?.[0], 'function', 'the extension calls go through the gate hook');
  // Without chrome, no --chrome flag.
  await runAgentCli({ agent: 'claude', prompt: 'p', cwd: tmp, query, bin: '/bin/true', mcp: null });
  assert.equal(seen.extraArgs, undefined);
});

test("a 'Don't allow' rule holds a matching extension call for approval; a denial blocks it, other calls run", async () => {
  assert.equal(chromeTool('mcp__claude-in-chrome__navigate'), 'navigate');
  assert.equal(chromeTool('mcp__playwright__browser_click'), null);
  assert.equal(judgeChrome('navigate', { url: 'https://bank.example.com/login' }, { rules: ['bank.example.com'] }).hold, true);
  assert.equal(judgeChrome('computer', { action: 'left_click', coordinate: [10, 20] }, { rules: ['payments and checkout'] }).hold, true, 'a coordinate click is an unknown target');
  assert.equal(judgeChrome('computer', { action: 'screenshot' }, { rules: ['payments and checkout'] }).hold, false, 'reads never hold');
  assert.equal(judgeChrome('navigate', { url: 'https://news.example.org' }, { rules: ['bank.example.com'] }).hold, false);

  const dir = path.join(tmp, 'gate-hold');
  const pre = gateHooks({ dir, task: 9, rules: ['bank.example.com'], ttlMs: 60_000, chrome: true }).PreToolUse[0].hooks[0];
  assert.deepEqual(await pre({ tool_name: 'mcp__claude-in-chrome__navigate', tool_input: { url: 'https://news.example.org' } }), {}, 'no rule matches: it runs');
  assert.deepEqual(await pre({ tool_name: 'Bash', tool_input: { command: 'ls' } }), {}, 'not an extension tool');
  const held = pre({ tool_name: 'mcp__claude-in-chrome__navigate', tool_input: { url: 'https://bank.example.com/transfer' } });
  // The call waits in the gate dir's approvals/ (the host asks the owner) until answered.
  const box = path.join(dir, 'approvals');
  let q = null;
  for (let i = 0; i < 100 && !q; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const f = fs.existsSync(box) && fs.readdirSync(box).find((n) => !n.endsWith('.answer.json'));
    if (f) q = JSON.parse(fs.readFileSync(path.join(box, f), 'utf8'));
  }
  assert.ok(q, 'an approval request was written');
  assert.equal(q.server, 'claude-in-chrome');
  assert.equal(q.tool, 'navigate');
  assert.equal(q.rule, 'bank.example.com');
  assert.equal(q.task, 9);
  answer(dir, 'approvals', q.id, { decision: 'deny', reason: 'not today' });
  const out = await held;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /denied.*not today.*NOT performed/s);
  const audit = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(audit.map((e) => [e.tool, e.decision ?? null]), [['navigate', null], ['navigate', 'deny']]);
});

// The orchestrator's placement with a fake cluster (as test/integrate-on-worker.test.mjs): a Browser-tab prompt goes to
// the chrome node with job.start.chrome; with the chrome node gone it falls back to the Playwright worker.
test('routing: a browser task goes to the chrome node with chrome: true; without one online, the built-in browser', { timeout: 60_000 }, async () => {
  const dir = path.join(tmp, 'orch');
  fs.mkdirSync(dir, { recursive: true });
  const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { createOrchestrator } from ${url('orchestrator.mjs')};
    const [dataDir] = process.argv.slice(1), GB = 2 ** 30;
    const o = createOrchestrator({ query: () => (async function* () {})(), dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true,
      broadcast() {}, emitChat() {}, convoExists: () => false, config: { pollMs: 1e9, agentSlots: Infinity, hardware: () => ({ cores: 1, mem: 8 * GB }), meminfo: ${JSON.stringify(fileURLToPath(new URL('./fixtures/meminfo-ample', import.meta.url)))} } });
    const agents = [{ id: 'claude', installed: true, signedIn: true }];
    const base = { os: 'darwin', local: false, status: 'online', connected: true, enabled: true, draining: false, maxSlots: 4, resources: { memAvailable: 16 * GB, at: Date.now() } };
    const pw = { ...base, id: 'pw', name: 'Mac mini', features: ['approvals', 'browser-task'], inventory: { cores: 8, agents, browser: { capable: true } } };
    const chrome = { ...base, id: 'cr', name: "Chrome on Sanat's Macbook Pro", features: ['approvals', 'browser-task', 'chrome'], inventory: { cores: 8, agents, chrome: { capable: true }, chromeRunner: true } };
    const nodes = [{ id: 'controller', name: 'vps', local: true, status: 'online', connected: true, enabled: true }, pw, chrome];
    let handler = null;
    const sent = [];
    o.attachCluster({ listNodes: () => nodes, node: (id) => nodes.find((n) => n.id === id) || null, isConnected: (id) => nodes.some((n) => n.id === id && n.connected),
      send: (node, m) => { sent.push({ node, ...m }); if (m.t === 'job.offer') setTimeout(() => handler(node, { t: 'job.accept', job: m.job }), 0); return true; },
      onMessage(fn) { handler = fn; }, version: () => 1 });
    const out = {};
    out.runner = o.browserRunner();
    const a = o.createBrowserTask({ prompt: 'read the page', identity: 'default', node: 'pw' }).taskId;
    const start = async (id) => { for (let i = 0; i < 200; i++) { const s = sent.find((m) => m.t === 'job.start' && m.job === id); if (s) return s; await new Promise((r) => setTimeout(r, 25)); } return null; };
    const s1 = await start(a);
    out.first = s1 && { node: s1.node, chrome: s1.chrome ?? null, execution: s1.execution };
    out.firstRunner = o.listBrowserTasks({ identity: 'default', node: 'pw' }).find((t) => t.id === a)?.runner;
    chrome.connected = false;
    out.fallbackRunner = o.browserRunner();
    const b = o.createBrowserTask({ prompt: 'read it again', identity: 'other', node: 'pw' }).taskId;
    const s2 = await start(b);
    out.second = s2 && { node: s2.node, chrome: s2.chrome ?? null };
    console.log(JSON.stringify(out));
    process.exit(0);`, dir], { cwd: ROOT, encoding: 'utf8', timeout: 50_000 });
  const r = JSON.parse(stdout.trim().split('\n').pop());
  const { macs, ...runner } = r.runner;
  assert.deepEqual(runner, { mode: 'chrome', label: "Using Chrome on Sanat's Macbook Pro", node: 'cr', name: "Chrome on Sanat's Macbook Pro" });
  assert.equal(macs.find((m) => m.id === 'cr')?.status, 'ready');
  assert.deepEqual(r.first, { node: 'cr', chrome: true, execution: 'browser' }, 'the Browser-tab prompt runs on the chrome node with Claude in Chrome');
  assert.equal(r.firstRunner, 'chrome');
  assert.equal(r.fallbackRunner.mode, 'builtin');
  assert.match(r.fallbackRunner.note, /No Chrome runner is online/);
  assert.deepEqual(r.second, { node: 'pw', chrome: null }, 'no chrome node online: the Playwright worker, without the chrome option');
});

// bin/install-worker-macos.sh --chrome-runner under the Mac's own bash (3.2 on a Mac; set -u, no bash 4 features).
test('installer --chrome-runner --dry-run: an Aqua LaunchAgent as the owner, runner env, its own pairing', { skip: process.platform !== 'darwin' && 'macOS /bin/bash' }, async () => {
  const { spawnSync } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(tmp, 'inst-'));
  const r = spawnSync('/bin/bash', [path.join(ROOT, 'bin/install-worker-macos.sh'), '--dry-run', '--controller', 'https://head.example', '--code', 'ABCD-2345',
    '--name', 'MBP', '--chrome-runner'], { encoding: 'utf8', env: { ...process.env, HOME: home, NVM_DIR: path.join(home, 'nvm') } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /syntax error|unbound variable/);
  assert.match(r.stdout, /com\.agent-orch\.worker\.chrome-runner\.plist/);
  assert.match(r.stdout, /<key>LimitLoadToSessionType<\/key><string>Aqua<\/string>/);
  assert.match(r.stdout, /<key>AGENT_ORCH_CHROME_RUNNER<\/key><string>1<\/string>/);
  assert.match(r.stdout, /<key>AGENT_ORCH_WORKER_BROWSER<\/key><string>off<\/string>/);
  assert.match(r.stdout, /\.agent-orch-chrome-runner/);
  assert.match(r.stdout, /worker\.mjs pair --controller https:\/\/head\.example --code ABCD-2345 --name Chrome on MBP/);
  assert.match(r.stdout, /launchctl bootstrap gui\/\d+ \S+chrome-runner\.plist/);
});
