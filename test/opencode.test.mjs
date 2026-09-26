import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, runAgentCli, opencodeAuth, opencodeModels, opencodeProviders, opencodeZenKey, OPENCODE_OAUTH, limitScope, limitScopes, agentStatus, clearLoginCache, discoverModels, setModelCatalog } from '../agents.mjs';
import { SPECS, parsePane, parseMenu, menuKeys, createConnections } from '../connections.mjs';
import { normUsage } from '../usage.mjs';

const stub = fileURLToPath(new URL('./fixtures/opencode-stub.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-test-'));
const env = (mode, extra = {}) => ({ PATH: process.env.PATH, OPENCODE_STUB: mode, ...extra });

test('OAuth only: key credentials do not count as a subscription connection', () => {
  const home = tmp(), file = path.join(home, '.local/share/opencode/auth.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ openai: { type: 'api', key: 'secret' } }));
  assert.equal(opencodeAuth(home), false);
  fs.writeFileSync(file, JSON.stringify({ openai: { type: 'oauth', refresh: 'secret', access: 'secret' } }));
  assert.equal(opencodeAuth(home), true);
});

const authHome = (creds) => {
  const home = tmp(), file = path.join(home, '.local/share/opencode/auth.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(creds));
  return home;
};
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

test('every signed-in subscription provider is reported, with the ChatGPT email; API keys are not', () => {
  const home = authHome({
    openai: { type: 'oauth', refresh: 'r', access: jwt({ 'https://api.openai.com/profile': { email: 'me@example.com' } }) },
    'github-copilot': { type: 'oauth', refresh: 'gho_x', access: 'gho_x', expires: 0 },
    anthropic: { type: 'api', key: 'secret' }, opencode: { type: 'api', key: 'zen' }, xai: { type: 'api', key: 'k' },
  });
  assert.deepEqual(opencodeProviders(home), [{ id: 'openai', account: 'me@example.com' }, { id: 'github-copilot', account: null }]);
  assert.deepEqual(Object.keys(SPECS.opencode.providers), Object.keys(OPENCODE_OAUTH), 'one login flow per subscription provider');
});

test('model discovery parses provider-specific CLI output without a static catalog', async () => {
  assert.deepEqual(opencodeModels('openai/gpt-5.4\nopenai/gpt-5.3-codex\nother/a\n'), [
    { id: 'openai/gpt-5.4', label: 'gpt-5.4' }, { id: 'openai/gpt-5.3-codex', label: 'gpt-5.3-codex' },
  ]);
  assert.deepEqual(opencodeModels('openai/gpt-5\ngithub-copilot/gpt-5\nxai/grok-4\n', ['openai', 'github-copilot']), [
    { id: 'openai/gpt-5', label: 'gpt-5 · ChatGPT' }, { id: 'github-copilot/gpt-5', label: 'gpt-5 · Copilot' },
  ]);
  // One verbose listing; only signed-in providers' models plus the free Zen ones survive.
  const log = path.join(tmp(), 'argv.json'), home = authHome({ 'github-copilot': { type: 'oauth', refresh: 'gho', access: 'gho' } });
  const zenFree = [{ id: 'opencode/big-pickle', label: 'Zen · Big Pickle (free)', free: true },
    { id: 'opencode/nemotron-3-ultra-free', label: 'Zen · Nemotron 3 Ultra Free (free)', free: true }];
  assert.deepEqual(await AGENTS.opencode.listModels({ bin: stub, env: env('success', { OPENCODE_STUB_LOG: log }), home }), zenFree);
  assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')).argv, ['models', '--verbose']);
  assert.deepEqual(await AGENTS.opencode.listModels({ bin: stub, env: env('success'), home: tmp() }), zenFree, 'no sign-in needed for free Zen');
  assert.deepEqual(await AGENTS.opencode.listModels({ bin: stub, env: env('success'), home: authHome({ openai: { type: 'oauth', refresh: 'r', access: 'a' } }) }),
    [...opencodeModels('openai/gpt-5.4\nopenai/gpt-5.3-codex', ['openai']), ...zenFree]);
});

test('free Zen filter: zero cost (or the -free/big-pickle naming without costs); paid Zen only with a Zen key', async () => {
  // The real `opencode models` output on this VM (no sign-in).
  const plain = 'opencode/big-pickle\nopencode/ling-3.0-flash-fin-free\nopencode/mimo-v2.6-flash-free\nopencode/nemotron-3.5-lightning-free\nopencode/gpt-5-nano\n';
  assert.deepEqual(opencodeModels(plain, []).map((m) => m.id), ['opencode/big-pickle', 'opencode/ling-3.0-flash-fin-free', 'opencode/mimo-v2.6-flash-free', 'opencode/nemotron-3.5-lightning-free']);
  assert.equal(opencodeModels(plain, [])[0].label, 'Zen · big-pickle (free)');
  const verbose = 'opencode/cheap\n{\n  "name": "Cheap",\n  "cost": {"input": 0, "output": 0}\n}\nopencode/pricey-free\n{\n  "name": "Pricey",\n  "cost": {"input": 1, "output": 2}\n}\n';
  assert.deepEqual(opencodeModels(verbose, []), [{ id: 'opencode/cheap', label: 'Zen · Cheap (free)', free: true }], 'the cost reading beats the name');
  assert.deepEqual(opencodeModels(verbose, [], { zenKey: true }).map((m) => m.label), ['Zen · Cheap (free)', 'Zen · Pricey']);
  const zenHome = authHome({ opencode: { type: 'api', key: 'zen' } });
  assert.equal(opencodeZenKey(zenHome), true);
  assert.equal(opencodeZenKey(tmp()), false);
  assert.deepEqual((await AGENTS.opencode.listModels({ bin: stub, env: env('success'), home: zenHome })).map((m) => m.id),
    ['opencode/big-pickle', 'opencode/nemotron-3-ultra-free', 'opencode/claude-opus-4-5']);
  // The billing guard refuses a paid Zen model without a key, and runs free ones with no sign-in at all.
  const home = tmp();
  const paid = await runAgentCli({ agent: 'opencode', bin: stub, cwd: tmp(), model: 'opencode/claude-opus-4-5', prompt: 'hi', env: env('success', { HOME: home }) });
  assert.equal(paid.outcome, 'auth_error');
  assert.match(paid.text, /paid OpenCode Zen model/);
  const free = await runAgentCli({ agent: 'opencode', bin: stub, cwd: tmp(), model: 'opencode/big-pickle', prompt: 'hi', env: env('success', { HOME: home }) });
  assert.equal(free.outcome, 'ok');
  assert.equal(limitScope('opencode', 'opencode/big-pickle'), 'opencode:opencode');
});

test('OpenCode is ready without a provider login once it lists free Zen models', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-bin-'));
  fs.symlinkSync(stub, path.join(bin, 'opencode'));
  const prev = process.env.PATH;
  process.env.PATH = `${bin}:${prev}`;
  try {
    clearLoginCache();
    setModelCatalog('opencode', { models: [], error: 'not signed in', at: Date.now() });
    if (opencodeAuth()) return; // a real sign-in on this machine makes the logged-out half meaningless
    assert.equal(agentStatus('opencode'), 'not logged in');
    const e = await discoverModels('opencode', { bin: stub, env: env('success', { OPENCODE_STUB_MODELS: 'zen' }), home: tmp() });
    assert.deepEqual(e.models.map((m) => m.id), ['opencode/big-pickle', 'opencode/nemotron-3-ultra-free']);
    setModelCatalog('opencode', e);
    assert.equal(agentStatus('opencode'), true);
    assert.deepEqual(AGENTS.opencode.freeModels().map((m) => m.id), ['opencode/big-pickle', 'opencode/nemotron-3-ultra-free']);
  } finally {
    process.env.PATH = prev;
    setModelCatalog('opencode', { models: [], error: 'reset', at: Date.now() });
    clearLoginCache();
  }
});

test('recorded OpenCode stream normalizes text, tools, paths, results and usage', async () => {
  const dir = tmp(), log = path.join(dir, 'log.json'), events = [];
  const res = await runAgentCli({ agent: 'opencode', bin: stub, cwd: dir, model: 'openai/gpt-5.4', prompt: 'work', systemAppend: 'rules',
    env: env('success', { OPENCODE_STUB_LOG: log, OPENAI_API_KEY: 'secret', AZURE_OPENAI_API_KEY: 'secret', GITHUB_TOKEN: 'secret' }),
    onEvent: (e) => events.push(e) });
  assert.equal(res.outcome, 'ok');
  assert.equal(res.sessionId, 'ses_fixture');
  assert.equal(res.text, 'Done');
  assert.deepEqual(events.map(({ lines, ...e }) => e), [
    { k: 'text', text: 'Looking' },
    { k: 'tool', id: 'call_1', name: 'Bash', input: { command: 'cat src/a.js' } },
    { k: 'tool_result', id: 'call_1', text: 'hello\n', isError: false },
    { k: 'tool', id: 'call_2', name: 'read', input: { file_path: '/tmp/a.js' } },
    { k: 'tool_result', id: 'call_2', text: 'hello', isError: false },
    { k: 'text', text: 'Done' },
    { k: 'result', usage: { input_tokens: 209, output_tokens: 21, cached_input_tokens: 189, reasoning_output_tokens: 2 } },
  ]);
  assert.deepEqual(normUsage('opencode', res.usage), { input: 20, output: 21, cached: 189 });
  const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.deepEqual(seen.argv, ['run', '--dir', dir, '--format', 'json', '--model', 'openai/gpt-5.4', '--auto', 'rules\n\nwork']);
  for (const k of ['OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.ok(!(k in seen.env), k);
});

test('resume uses exact session; completed run need not contain step_finish', async () => {
  const dir = tmp(), log = path.join(dir, 'log.json');
  const res = await runAgentCli({ agent: 'opencode', bin: stub, cwd: dir, resume: 'ses_old', prompt: 'more', autonomous: false,
    env: env('success', { OPENCODE_STUB_LOG: log }) });
  assert.equal(res.outcome, 'ok');
  assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')).argv, ['run', '--dir', dir, '--format', 'json', '--session', 'ses_old', 'more']);
  const missing = await runAgentCli({ agent: 'opencode', bin: stub, cwd: dir, resume: 'gone', prompt: 'more', env: env('missing') });
  assert.equal(missing.errorCode, 'no_session');
});

test('abort kills the OpenCode process group', async () => {
  const dir = tmp(), pids = path.join(dir, 'pids'), ac = new AbortController();
  const pending = runAgentCli({ agent: 'opencode', bin: stub, cwd: dir, prompt: 'wait', signal: ac.signal,
    env: env('hang', { OPENCODE_STUB_PIDS: pids }) });
  for (let i = 0; i < 100 && !fs.existsSync(pids); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fs.existsSync(pids));
  ac.abort();
  assert.equal((await pending).outcome, 'aborted');
  const pid = Number(fs.readFileSync(pids, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(alive(), false);
});

test('project API billing configuration is rejected before spawning', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'opencode.json'), '{"provider":{"openai":{"options":{"apiKey":"secret"}}}}');
  const res = await runAgentCli({ agent: 'opencode', bin: stub, cwd: dir, prompt: 'hi', env: env('success') });
  assert.equal(res.outcome, 'auth_error');
  assert.match(res.text, /API key/);
});

test('global config with a provider apiKey is rejected before spawning', async () => {
  const home = tmp(), dir = tmp(), log = path.join(dir, 'log.json');
  fs.mkdirSync(path.join(home, '.config/opencode'), { recursive: true });
  const cfg = path.join(home, '.config/opencode/opencode.json');
  fs.writeFileSync(cfg, '{"provider":{"openai":{"options":{"apiKey":"secret"}}}}');
  const res = await runAgentCli({ agent: 'opencode', bin: stub, cwd: dir, prompt: 'hi', env: env('success', { HOME: home, OPENCODE_STUB_LOG: log }) });
  assert.equal(res.outcome, 'auth_error');
  assert.ok(res.text.startsWith(`${cfg} configures an API key`), res.text);
  assert.ok(!fs.existsSync(log));
});

test('parent-directory config up to the git root is checked', async () => {
  const root = tmp(), cwd = path.join(root, 'pkg/sub');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'opencode.json'), '{"provider":{"openai":{"options":{"baseURL":"https://proxy"}}}}');
  const res = await runAgentCli({ agent: 'opencode', bin: stub, cwd, prompt: 'hi', env: env('success', { HOME: tmp() }) });
  assert.equal(res.outcome, 'auth_error');
  assert.match(res.text, new RegExp(`^${path.join(root, 'opencode.json')} configures`));
});

test('clean global config runs and OPENCODE_CONFIG* vars never reach OpenCode', async () => {
  const home = tmp(), dir = tmp(), log = path.join(dir, 'log.json');
  fs.mkdirSync(path.join(home, '.config/opencode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/opencode/opencode.jsonc'), '{\n  "$schema": "https://opencode.ai/config.json"\n}');
  const res = await runAgentCli({ agent: 'opencode', bin: stub, cwd: dir, prompt: 'hi', env: env('success', { HOME: home, OPENCODE_STUB_LOG: log,
    OPENCODE_CONFIG_CONTENT: '{"provider":{"openai":{"options":{"apiKey":"secret"}}}}', OPENCODE_CONFIG: '/x.json', OPENCODE_CONFIG_DIR: '/x' }) });
  assert.equal(res.outcome, 'ok');
  const seen = JSON.parse(fs.readFileSync(log, 'utf8')).env;
  for (const k of ['OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR']) assert.ok(!(k in seen), k);
});

test('limits come only from structured error events, not tool output', async () => {
  const events = [];
  const ok = await runAgentCli({ agent: 'opencode', bin: stub, cwd: tmp(), prompt: 'hi', env: env('toolmention'), onEvent: (e) => events.push(e) });
  assert.equal(ok.outcome, 'ok');
  assert.ok(events.some((e) => e.k === 'tool_result' && /usage limit/.test(e.text)));
  assert.ok(!events.some((e) => e.k === 'limit'));
  const limit = await runAgentCli({ agent: 'opencode', bin: stub, cwd: tmp(), prompt: 'hi', env: env('limit'), onEvent: (e) => events.push(e) });
  assert.equal(limit.outcome, 'rate_limited');
  assert.equal(limit.resetsAt, Date.parse('2030-01-01T00:00:00Z') / 1000);
  assert.deepEqual(events.filter((e) => e.k === 'limit'), [{ k: 'limit', resetsAt: limit.resetsAt }]);
  assert.equal(limitScope('opencode', 'openai/gpt-5.4'), 'opencode:openai');
  assert.deepEqual(limitScopes(['opencode']), ['opencode:openai', 'opencode:github-copilot', 'opencode:xai', 'opencode:opencode']);
});

test('recorded signed-out error stays a normal error without a false limit', async () => {
  const events = [];
  const res = await runAgentCli({ agent: 'opencode', bin: stub, cwd: tmp(), prompt: 'hi', env: env('signedout'), onEvent: (e) => events.push(e) });
  assert.equal(res.outcome, 'error');
  assert.equal(res.sessionId, 'ses_fixture');
  assert.ok(!events.some((e) => e.k === 'limit'));
});

const pane = (f) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/panes/${f}`, import.meta.url)), 'utf8');

test('provider menu (recorded `opencode auth login`) parses into options', () => {
  const m = parseMenu(pane('opencode-providers.txt'));
  assert.equal(m.prompt, 'Select provider');
  assert.deepEqual(m.options.slice(0, 3), [{ label: 'OpenCode Zen (recommended)', active: true }, { label: 'OpenAI', active: false }, { label: 'GitHub Copilot', active: false }]);
  assert.equal(m.options.length, 7);
  const methods = parseMenu(pane('opencode-openai-methods.txt'));
  assert.equal(methods.prompt, 'Login method');
  assert.deepEqual(methods.options.map((o) => o.label), ['ChatGPT Pro/Plus (browser)', 'ChatGPT Pro/Plus (headless)', 'Manually enter API Key']);
  assert.equal(parseMenu(pane('opencode-openai-device.txt')), null, 'no open menu once the device flow shows');
  // Copilot's deployment question is answered with GitHub.com; other menus are left alone.
  const cp = SPECS.opencode.providers['github-copilot'];
  assert.deepEqual(menuKeys(cp, pane('opencode-copilot-deploy.txt')), [0, ['Enter']]);
  assert.deepEqual(menuKeys(cp, pane('opencode-copilot-deploy.txt').replace('● GitHub.com', '○ GitHub.com').replace('○ GitHub Enterprise', '● GitHub Enterprise')), [0, ['Up', 'Enter']]);
  assert.equal(menuKeys(cp, pane('opencode-openai-methods.txt')), null);
});

test('each provider flow parses its recorded URL and code; only subscription methods are used', () => {
  const P = SPECS.opencode.providers;
  const look = (id, f) => { const p = parsePane(P[id], pane(f)); return [p.url, p.code, p.exited]; };
  assert.deepEqual(look('openai', 'opencode-openai-device.txt'), ['https://auth.openai.com/codex/device', 'Z28M-PTNE3', false]);
  assert.deepEqual(look('github-copilot', 'opencode-copilot-device.txt'), ['https://github.com/login/device', '6140-6F98', false]);
  assert.deepEqual(look('xai', 'opencode-xai-device.txt'), ['https://accounts.x.ai/oauth2/device?user_code=FPKF-QQZV', 'FPKF-QQZV', false]);
  for (const [id, p] of Object.entries(P)) {
    assert.deepEqual(p.start.slice(0, 5), ['opencode', 'auth', 'login', '--provider', id]);
    assert.doesNotMatch(p.start.at(-1), /API Key|browser/i);
  }
  const ok = parsePane(P.openai, `${pane('opencode-openai-device.txt')}\n◇  Login successful\n__AO_EXIT:0\n`);
  assert.deepEqual([ok.exited, ok.ok], [true, true]);
  const bad = parsePane(P.xai, `${pane('opencode-xai-device.txt')}\n■  Failed to authorize\n__AO_EXIT:1\n`);
  assert.deepEqual([bad.exited, bad.ok, bad.error], [true, false, '■  Failed to authorize']);
});

function fakeConn(accounts = []) {
  const calls = [];
  const tmux = async (args) => { calls.push(args); return { ok: true, out: args[0] === 'capture-pane' ? pane('opencode-copilot-deploy.txt') : '' }; };
  const conn = createConnections({ entries: [{ id: 'opencode', label: 'OpenCode CLI', installed: () => true, signedIn: () => accounts.length > 0,
    accounts: () => accounts, spec: SPECS.opencode }], env: { PATH: '/usr/bin' }, tmux, pollMs: 5 });
  return { conn, calls };
}

test('start for a chosen provider launches that provider\'s flow, not OpenAI\'s', async () => {
  const { conn, calls } = fakeConn();
  assert.equal((await conn.start('opencode')).status, 400, 'a provider must be chosen');
  assert.equal((await conn.start('opencode', { provider: 'anthropic' })).status, 400, 'API-key providers are not offered');
  assert.equal((await conn.start('opencode', { provider: '__proto__' })).status, 400);
  const r = await conn.start('opencode', { provider: 'github-copilot' });
  assert.equal(r.status, 200);
  assert.equal(r.login.provider, 'github-copilot');
  const cmd = calls.find((c) => c[0] === 'new-session').at(-1);
  assert.match(cmd, /^'opencode' 'auth' 'login' '--provider' 'github-copilot' '--method' 'Login with GitHub Copilot';/);
  assert.doesNotMatch(cmd, /openai/);
  for (let i = 0; i < 100 && !calls.some((c) => c[0] === 'send-keys'); i++) await new Promise((res) => setTimeout(res, 5));
  assert.deepEqual(calls.filter((c) => c[0] === 'send-keys').map((c) => c.slice(3)), [['Enter']], 'GitHub.com chosen once');
  const list = conn.list()[0];
  assert.deepEqual(list.providers.map((p) => p.id), ['openai', 'github-copilot', 'xai']);
  assert.match(list.providers[0].blurb, /ChatGPT Plus\/Pro/);
  await conn.cancel('opencode');
});

test('status lists every signed-in provider; logout is per provider', async () => {
  const { conn } = fakeConn([{ id: 'openai', account: 'me@example.com' }, { id: 'github-copilot', account: null }, { id: 'bogus' }]);
  assert.deepEqual(conn.list()[0].accounts, [{ id: 'openai', account: 'me@example.com', label: 'ChatGPT' }, { id: 'github-copilot', account: null, label: 'GitHub Copilot' }]);
  assert.equal((await conn.logout('opencode', {})).status, 400, 'no provider, no logout');
  assert.deepEqual(SPECS.opencode.logout, ['opencode', 'auth', 'logout']);
});
