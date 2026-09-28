// Browser tab direct mode (#512, chrome.mjs, .agent-orch/CHROME.md): with a Chrome runner online a Browser-tab prompt
// runs there as a Claude run with extraArgs {chrome: null}, the owner's prompt verbatim behind a short fixed preface and
// their "Don't allow" rules, no system prompt and no Playwright MCP; the extension's calls become the tab's steps and
// screenshots; a deny rule still holds an extension call. With no runner online the tab shows the setup card with a
// command carrying a fresh multi-use pairing code; the built-in browser is behind a link. CW_UI_SHOTS=1 saves screenshots.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CHROME_PREFACE, chromePrompt, chromeSetup } from '../chrome.mjs';
import { browserSteps } from '../browser-task.mjs';
import { answer } from '../gate.mjs';
import { gateHooks, runAgentCli } from '../agents.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.CW_UI_SHOTS ? path.join(ROOT, '.agent-orch', 'shots') : null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-direct-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

test('chromePrompt: the fixed preface, the deny rules as text, then the prompt verbatim', () => {
  assert.equal(CHROME_PREFACE, 'Use the Claude in Chrome tools to do this in the browser. Stop and ask if a login or 2FA is needed.');
  assert.equal(chromePrompt('  Find my last Amazon order  ', []), `${CHROME_PREFACE}\n\nFind my last Amazon order`);
  assert.equal(chromePrompt('Pay the bill', ['payments and checkout', 'bank.example.com']),
    `${CHROME_PREFACE}\nDon't allow without asking the owner first: payments and checkout; bank.example.com.\n\nPay the bill`);
});

test('chromeSetup: a status line per Mac', () => {
  const mac = (id, chrome, extra = {}) => ({ id, name: id, os: 'darwin', local: false, status: 'online', connected: true, enabled: true,
    features: ['approvals', 'chrome'], inventory: { chrome }, ...extra });
  const rows = chromeSetup([{ id: 'controller', local: true, os: 'linux' }, { id: 'vps', os: 'linux', local: false },
    mac('air', { capable: false, chrome: false, reason: 'Google Chrome is not installed' }),
    mac('mini', { capable: false, chrome: true, extension: false }),
    mac('pro', { capable: false, chrome: true, extension: true, nativeHost: true, gui: false }),
    mac('runner', { capable: true }, { inventory: { chrome: { capable: true }, chromeRunner: true } }),
    mac('old', null), mac('away', { capable: true }, { connected: false })]);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.status])), { runner: 'ready', air: 'Chrome not installed', mini: 'extension missing',
    pro: 'no desktop session', old: 'no Chrome runner', away: 'offline' });
  assert.equal(rows[0].id, 'runner', 'runners first');
});

test('the extension\'s calls are the steps: navigate, click, type, read, and screenshots as thumbnails', () => {
  const t = (name, input) => ({ k: 'tool', at: 1, name: `mcp__claude-in-chrome__${name}`, input });
  const steps = browserSteps([t('tabs_context_mcp', {}), t('navigate', { url: 'https://example.com', tabId: 1 }),
    t('computer', { action: 'left_click', coordinate: [10, 20] }), t('computer', { action: 'type', text: 'hello' }),
    t('get_page_text', {}), t('computer', { action: 'screenshot' }), { k: 'image', at: 2, id: 'm1' }, t('computer', { action: 'scroll' }),
    { k: 'text', at: 3, text: 'Done: it says hello.' }]);
  assert.deepEqual(steps.map((s) => [s.kind, s.label, s.mediaId || null]), [['nav', 'https://example.com', null], ['click', '(10, 20)', null],
    ['type', '"hello"', null], ['read', 'the page', null], ['shot', 'the page', 'm1'], ['text', 'Done: it says hello.', null]]);
});

test('a Claude run with chrome: extraArgs {chrome: null} and no Playwright MCP config', async () => {
  let seen = null;
  const query = ({ prompt, options }) => { seen = { prompt, options }; return (async function* () { yield { type: 'result', subtype: 'success', result: 'done', usage: {} }; })(); };
  const gate = { dir: path.join(tmp, 'gate-opt'), task: 7, rules: [], ttlMs: 60_000 };
  const prompt = chromePrompt('Read the headline on example.com', []);
  const res = await runAgentCli({ agent: 'claude', prompt, cwd: tmp, query, bin: '/bin/true', chrome: true, gate, mcp: null });
  assert.equal(res.outcome, 'ok');
  assert.deepEqual(seen.options.extraArgs, { chrome: null }, 'the chrome flag and no --mcp-config (no Playwright)');
  assert.equal(seen.options.mcpServers, undefined);
  assert.equal(seen.prompt, prompt);
});

test("a 'Don't allow' rule holds an extension call; a denial blocks it", async () => {
  const dir = path.join(tmp, 'gate-hold');
  const pre = gateHooks({ dir, task: 9, rules: ['payments and checkout'], ttlMs: 60_000, chrome: true }).PreToolUse[0].hooks[0];
  assert.deepEqual(await pre({ tool_name: 'mcp__claude-in-chrome__computer', tool_input: { action: 'screenshot' } }), {}, 'reads run');
  const held = pre({ tool_name: 'mcp__claude-in-chrome__navigate', tool_input: { url: 'https://shop.example.com/checkout' } });
  const box = path.join(dir, 'approvals');
  let q = null;
  for (let i = 0; i < 100 && !q; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const f = fs.existsSync(box) && fs.readdirSync(box).find((n) => !n.endsWith('.answer.json'));
    if (f) q = JSON.parse(fs.readFileSync(path.join(box, f), 'utf8'));
  }
  assert.ok(q, 'an approval request was written');
  assert.equal(q.rule, 'payments and checkout');
  answer(dir, 'approvals', q.id, { decision: 'deny', reason: 'no' });
  const out = await held;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

// The head with a fake cluster (as test/chrome-runner.test.mjs): the Browser-tab prompt's job.start.
test('with a chrome runner online, a Browser-tab prompt runs there with chrome, the prompt plus preface, and no system prompt', { timeout: 60_000 }, async () => {
  const dir = path.join(tmp, 'orch');
  fs.mkdirSync(dir, { recursive: true });
  const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { createOrchestrator } from ${url('orchestrator.mjs')};
    const [dataDir] = process.argv.slice(1), GB = 2 ** 30;
    const o = createOrchestrator({ query: () => (async function* () {})(), dataDir, claudeEnv: {}, getLimits: () => [], onSubscription: () => true,
      broadcast() {}, emitChat() {}, convoExists: () => false, config: { pollMs: 1e9, agentSlots: Infinity, hardware: () => ({ cores: 1, mem: 8 * GB }), meminfo: ${JSON.stringify(fileURLToPath(new URL('./fixtures/meminfo-ample', import.meta.url)))} } });
    o.setGateSettings({ rules: ['payments and checkout'] });
    const agents = [{ id: 'claude', installed: true, signedIn: true }];
    const base = { os: 'darwin', local: false, status: 'online', connected: true, enabled: true, draining: false, maxSlots: 4, resources: { memAvailable: 16 * GB, at: Date.now() } };
    const chrome = { ...base, id: 'cr', name: "Chrome on Sanat's Macbook Pro", features: ['approvals', 'browser-task', 'chrome'], inventory: { cores: 8, agents, chrome: { capable: true }, chromeRunner: true } };
    const nodes = [{ id: 'controller', name: 'vps', local: true, status: 'online', connected: true, enabled: true }, chrome];
    let handler = null;
    const sent = [];
    o.attachCluster({ listNodes: () => nodes, node: (id) => nodes.find((n) => n.id === id) || null, isConnected: (id) => nodes.some((n) => n.id === id && n.connected),
      send: (node, m) => { sent.push({ node, ...m }); if (m.t === 'job.offer') setTimeout(() => handler(node, { t: 'job.accept', job: m.job }), 0); return true; },
      onMessage(fn) { handler = fn; }, version: () => 1 });
    const runner = o.browserRunner();
    const id = o.createBrowserTask({ prompt: 'Find my last Amazon order and tell me its total', identity: 'default', node: runner.node }).taskId;
    let s = null;
    for (let i = 0; i < 200 && !s; i++) { s = sent.find((m) => m.t === 'job.start' && m.job === id); if (!s) await new Promise((r) => setTimeout(r, 25)); }
    chrome.connected = false;
    console.log(JSON.stringify({ runner, start: s && { node: s.node, chrome: s.chrome ?? null, prompt: s.prompt, systemAppend: s.systemAppend ?? null, execution: s.execution },
      runnerRow: o.listBrowserTasks({ identity: 'default', node: runner.node }).find((t) => t.id === id)?.runner, off: o.browserRunner() }));
    process.exit(0);`, dir], { cwd: ROOT, encoding: 'utf8', timeout: 50_000 });
  const r = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(r.runner.mode, 'chrome');
  assert.equal(r.runner.node, 'cr');
  assert.deepEqual(r.start, { node: 'cr', chrome: true, execution: 'browser', systemAppend: null,
    prompt: `${CHROME_PREFACE}\nDon't allow without asking the owner first: payments and checkout.\n\nFind my last Amazon order and tell me its total` });
  assert.doesNotMatch(r.start.prompt, /playwright/i);
  assert.equal(r.runnerRow, 'chrome');
  assert.equal(r.off.mode, 'builtin');
  assert.deepEqual(r.off.macs, [{ id: 'cr', name: "Chrome on Sanat's Macbook Pro", online: false, runner: true, status: 'offline' }], 'the setup card lists the Mac');
});

// ---- the Browser tab (public/browser.js) against a real server with /api/browser* mocked, as test/ui-browser-view.test.mjs.
const PASSWORD = 'chrome-direct-password';
let chromium = null, browser = null, skip = false, child = null, base = '', cookie = '', out = '';
try { ({ chromium } = await import('playwright-core')); browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${String(e.message).split('\n')[0]}`; }
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
before(async () => {
  if (skip) return;
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1', AGENT_ORCH_BROWSER_HOME: path.join(tmp, 'home') } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
});
after(async () => { await browser?.close(); child?.kill('SIGKILL'); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PLAYWRIGHT_NODE = { id: 'vps2', name: 'VPS2', local: false, online: true, capable: true, profiles: [{ identity: 'default', running: false, task: null }] };
async function app(data) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 860 } });
  await ctx.addCookies([{ name, value, url: base }]);
  const p = await ctx.newPage();
  const s = { errors: [], posts: [], pairs: [], bv: [], tasks: [] };
  p.on('pageerror', (e) => s.errors.push(e.message));
  await p.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => { const msg = JSON.parse(m); if (msg.t?.startsWith('bv_')) s.bv.push(msg); else server.send(m); });
    server.onMessage((m) => ws.send(m));
  });
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await p.route('**/api/status', async (r) => json(r, { ...(await (await r.fetch()).json()), claudeSignedIn: true }));
  await p.route('**/api/browser', (r) => json(r, data));
  await p.route('**/api/browser/tasks?*', (r) => json(r, s.tasks));
  await p.route('**/api/orch/gate', (r) => json(r, { rules: ['payments and checkout'] }));
  await p.route('**/api/orch/approvals', (r) => json(r, { approvals: [] }));
  await p.route('**/api/cluster/pair', (r) => { s.pairs.push(r.request().postDataJSON()); return json(r, { code: `WXYZ-${2345 + s.pairs.length}`, expiresAt: Date.now() + 3600e3, uses: 2, used: 0, nodes: [] }); });
  await p.route('**/api/browser/task', (r) => {
    s.posts.push(r.request().postDataJSON());
    s.tasks = [{ id: 51, title: 'Read the headline on example.com', status: 'running', startedAt: Date.now(), runner: 'chrome',
      steps: [{ ts: 1, kind: 'nav', label: 'https://example.com' }, { ts: 2, kind: 'shot', label: 'the page', mediaId: 'shot-1' },
        { ts: 3, kind: 'click', label: '(10, 20)' }, { ts: 4, kind: 'shot', label: 'the page', mediaId: 'shot-2' }] }];
    return json(r, { taskId: 51 }, 201);
  });
  await p.route('**/api/media/*', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await p.goto(`${base}/`);
  await p.locator('#app:not([inert])').waitFor({ timeout: 20000 });
  await p.locator('.seg [data-view="browser"]').click();
  return { ctx, p, s };
}
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `chrome-direct-${name}.png`) }); } };

test('no runner online: the setup card with a generated command and each Mac\'s status; the built-in browser behind a link', { skip, timeout: 120_000 }, async () => {
  const macs = [{ id: 'air', name: "Soham's Air", online: true, runner: false, status: 'Chrome not installed' },
    { id: 'pro', name: "Sanat's Macbook Pro", online: true, runner: false, status: 'extension missing' }];
  const { ctx, p, s } = await app({ nodes: [PLAYWRIGHT_NODE], runner: { mode: 'builtin', label: 'Built-in browser', note: 'No Chrome runner is online, so the built-in browser is used', macs } });
  try {
    const card = p.locator('#bxSetup');
    await card.getByText('Set up Claude in Chrome').waitFor({ timeout: 10000 });
    assert.ok(await p.locator('#bxStage').isHidden() && await p.locator('#bxPrompt').isHidden(), 'no black canvas, no prompt box');
    assert.equal(await card.locator('.bx-setup-steps > li').count(), 3);
    assert.match(await card.textContent(), /claude login/);
    assert.deepEqual(await card.locator('.bx-setup-mac').allTextContents(), ["Soham's AirChrome not installed", "Sanat's Macbook Proextension missing"]);
    assert.equal(s.bv.filter((m) => m.t === 'bv_open').length, 0, 'no live view opened');
    await card.getByRole('button', { name: 'Generate command' }).click();
    await card.locator('#bxCmd').waitFor({ timeout: 5000 });
    assert.deepEqual(s.pairs, [{ uses: 2 }], 'a fresh multi-use code from the pair API');
    assert.equal(await card.locator('#bxCmd').textContent(),
      `curl -fsSL ${base}/install/worker-macos.sh | sudo bash -s -- --controller ${base} --code WXYZ-2346 --chrome-runner`);
    assert.ok(await card.locator('#bxCmd').evaluate((n) => n.classList.contains('copy-cmd')), 'copy on click');
    await shot(p, 'setup');
    await card.getByRole('button', { name: 'New code' }).click();
    await waitFor(async () => /WXYZ-2347/.test(await card.locator('#bxCmd').textContent()), { timeout: 5000, message: 'a new code each time' });
    // The built-in browser, only behind the link.
    await p.locator('#bxAlt', { hasText: 'Use built-in browser instead' }).click();
    await waitFor(() => s.bv.some((m) => m.t === 'bv_open' && m.node === 'vps2'), { timeout: 10000, message: 'the built-in view opens' });
    assert.ok(await card.isHidden() && await p.locator('#bxStage').isVisible());
    assert.deepEqual(s.errors, []);
  } finally { await ctx.close(); }
});

test('a runner online: "Running in Chrome on <machine>", the prompt goes to it, steps and the latest screenshot, no canvas', { skip, timeout: 120_000 }, async () => {
  const { ctx, p, s } = await app({ nodes: [PLAYWRIGHT_NODE], runner: { mode: 'chrome', label: "Using Chrome on Sanat's Macbook Pro", node: 'cr', name: "Chrome on Sanat's Macbook Pro", macs: [] } });
  try {
    await p.locator('#bxDirectHead', { hasText: "Running in Chrome on Sanat's Macbook Pro" }).waitFor({ timeout: 10000 });
    assert.ok(await p.locator('#bxStage').isHidden() && await p.locator('#bxBar').isHidden() && await p.locator('#bxSetup').isHidden());
    assert.ok(await p.locator('#bxAlt').isHidden());
    await p.locator('#bxInput').fill('Read the headline on example.com');
    await p.locator('#bxInput').press('Enter');
    await waitFor(() => s.posts.length === 1, { timeout: 10000, message: 'the prompt is posted' });
    assert.deepEqual(s.posts[0], { prompt: 'Read the headline on example.com', identity: 'default', node: 'cr' });
    const act = p.locator('#bxActivity');
    await act.locator('.bx-step').nth(3).waitFor({ timeout: 10000 });
    assert.deepEqual(await act.locator('.bx-step').allTextContents(), ['Opened https://example.com', 'Took a screenshot of the page', 'Clicked (10, 20)', 'Took a screenshot of the page']);
    assert.equal(await act.locator('.shots .shot').count(), 2, 'screenshot thumbnails');
    await waitFor(async () => (await p.locator('#bxDirectShot img').getAttribute('src').catch(() => null)) === '/api/media/shot-2', { timeout: 5000, message: 'the latest screenshot replaces the canvas' });
    await shot(p, 'direct');
    assert.equal(s.bv.filter((m) => m.t === 'bv_open').length, 0, 'no live stream');
    assert.deepEqual(s.errors, []);
  } finally { await ctx.close(); }
});
