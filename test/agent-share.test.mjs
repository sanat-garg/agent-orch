// Worker machines run Claude and Codex on the head's sign-ins (agent-share.mjs, agent.credential): the store, the frame,
// the Connections flow that captures `claude setup-token`'s token, and end to end: a real worker (worker.mjs) against an
// in-test hub (cluster.mjs) gets both sign-ins with nothing signed in on it, and a Codex refresh made there comes back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentShare, wireAgentShare, shareTargets, parseCodexAuth, CLAUDE_TOKEN_RE } from '../agent-share.mjs';
import { createConnections, SPECS, parsePane } from '../connections.mjs';
import { parseClaudeAuth } from '../agents.mjs';
import { createCluster } from '../cluster.mjs';
import { validate, WORKER_ACCEPTS, FEATURES, FEATURE_LIST, CLAIM_PATH, WHOAMI_PATH } from '../cluster-protocol.mjs';
import { checkPairing } from '../worker.mjs';
import { isolatedPath } from './helpers/isolated-path.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = `sk-ant-oat01-${'A1b2_C3-'.repeat(12)}`;
const codexAuth = (account, iso, access = 'at-1') => JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
  tokens: { id_token: 'id', access_token: access, refresh_token: `rt-${access}`, account_id: account }, last_refresh: iso }, null, 2);
const mode = (f) => fs.statSync(f).mode & 0o777;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-share-'));
  const data = path.join(dir, 'data'), home = path.join(dir, 'home');
  fs.mkdirSync(data); fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const sent = [];
  const share = createAgentShare({ dataDir: data, home, send: (id, f) => sent.push({ id, ...f }), targets: () => ['n1', 'n2'], watchMs: 60_000 });
  return { dir, data, home, sent, share, done: () => { share.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('Claude: only a setup-token token is shared; it is stored owner-only and every worker gets it (null stops sharing)', () => {
  const f = fixture();
  try {
    assert.equal(f.share.setClaudeToken('sk-ant-api03-an-api-key-bills-api-credits').status, 400);
    assert.equal(f.share.setClaudeToken('hello').status, 400);
    assert.equal(f.sent.length, 0);
    assert.deepEqual(f.share.setClaudeToken(`  ${TOKEN}\n`), { ok: true });
    const file = path.join(f.data, 'agent-share.json');
    assert.equal(mode(file), 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).claude.token, TOKEN);
    assert.deepEqual(f.sent.map((x) => [x.id, x.agent, x.value]), [['n1', 'claude', TOKEN], ['n2', 'claude', TOKEN]]);
    assert.equal(f.share.status().claude.shared, true);
    f.sent.length = 0;
    f.share.setClaudeToken(null);
    assert.deepEqual(f.sent.map((x) => [x.id, x.value]), [['n1', null], ['n2', null]]);
    assert.equal(f.share.hasClaude(), false);
  } finally { f.done(); }
});

test('Codex: the head shares its ChatGPT login; a worker\'s refresh is adopted only when it is the same account and newer', () => {
  const f = fixture();
  try {
    assert.equal(parseCodexAuth(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' })), null, 'an API-key login is never shared');
    const ours = codexAuth('acct-1', '2026-09-20T00:00:00Z');
    fs.writeFileSync(path.join(f.home, '.codex', 'auth.json'), ours);
    f.share.checkCodex();
    assert.deepEqual(f.sent.map((x) => [x.id, x.agent, x.value]), [['n1', 'codex', ours], ['n2', 'codex', ours]]);
    f.sent.length = 0;
    f.share.syncNode('n3');
    assert.deepEqual(f.sent.map((x) => x.agent), ['claude', 'codex'], 'a connecting worker gets both');
    f.sent.length = 0;
    const older = codexAuth('acct-1', '2026-09-19T00:00:00Z', 'at-old'), other = codexAuth('acct-2', '2026-09-27T00:00:00Z', 'at-x');
    const newer = codexAuth('acct-1', '2026-09-27T00:00:00Z', 'at-2');
    assert.match(f.share.fromWorker('n1', { agent: 'codex', value: older }).ignored, /not newer/);
    assert.match(f.share.fromWorker('n1', { agent: 'codex', value: other }).ignored, /different account/);
    assert.match(f.share.fromWorker('n1', { agent: 'claude', value: TOKEN }).ignored, /only a refreshed codex/);
    assert.equal(fs.readFileSync(path.join(f.home, '.codex', 'auth.json'), 'utf8'), ours, 'nothing was taken');
    assert.deepEqual(f.share.fromWorker('n1', { agent: 'codex', value: newer }), { adopted: true });
    assert.equal(fs.readFileSync(path.join(f.home, '.codex', 'auth.json'), 'utf8'), newer);
    assert.equal(mode(path.join(f.home, '.codex', 'auth.json')), 0o600);
    assert.deepEqual(f.sent.map((x) => [x.id, x.value]), [['n2', newer]], 'every other worker, not the sender');
  } finally { f.done(); }
});

test('the agent.credential frame: both directions, exempt from the secret check, only to workers that read it', () => {
  const frame = (value, from) => validate({ t: 'agent.credential', seq: 1, ts: 1, agent: 'claude', value }, { from });
  assert.equal(frame(TOKEN, 'c'), null);
  assert.equal(frame(null, 'c'), null);
  assert.equal(validate({ t: 'agent.credential', seq: 1, ts: 1, agent: 'codex', value: '{}' }, { from: 'w' }), null);
  assert.match(validate({ t: 'agent.credential', seq: 1, ts: 1, agent: 'gemini', value: 'x' }, { from: 'c' }), /bad agent/);
  assert.match(validate({ t: 'inventory', seq: 1, ts: 1, node: 'n', name: 'n', os: 'linux', arch: 'x', cores: 1, mem: 1, agents: [], versions: {}, token: 'x' }, { from: 'w' }), /secrets may not travel/,
    'other frames still refuse secrets');
  assert.ok(WORKER_ACCEPTS.includes('agent.credential'));
  assert.equal(FEATURES['agent.credential'], 'creds');
  assert.ok(FEATURE_LIST.includes('creds'));
});

test('a setup-token token counts as a Claude subscription sign-in; an API key never does', () => {
  assert.equal(parseClaudeAuth('{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}').ok, true);
  assert.equal(parseClaudeAuth('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"a@b"}').ok, true);
  assert.equal(parseClaudeAuth('{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}').ok, false);
  assert.equal(parseClaudeAuth('{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"bedrock"}').ok, false);
});

test('Connections: "Share with machines" runs claude setup-token, captures the token it prints, and never shows it', async () => {
  let pane = '';
  const calls = [];
  const tmux = async (args) => { calls.push(args); return args[0] === 'capture-pane' ? { ok: true, out: pane } : { ok: true, out: '' }; };
  let captured = null, stopped = false;
  const c = createConnections({ tmux, pollMs: 20, entries: [{ id: 'claude-machines', label: 'Claude for your machines', installed: () => true, signedIn: () => !!captured,
    spec: SPECS.claudeShare, onCapture: (t) => { captured = t; }, logout: async () => { stopped = true; captured = null; return { ok: true }; },
    ui: { connect: 'Share with machines', disconnect: 'Stop sharing' } }] });
  const r = await c.start('claude-machines');
  assert.equal(r.status, 200);
  assert.ok(calls.some((a) => a[0] === 'new-session' && a.at(-1).includes("'setup-token'")), JSON.stringify(calls.find((a) => a[0] === 'new-session')));
  pane = 'Browser didn\'t open? Use the url below to sign in:\nhttps://claude.ai/oauth/authorize?code=true&client_id=x&state=y\nPaste code here if prompted > ';
  await waitFor(() => c.list()[0].login?.url, { timeout: 2000 });
  assert.equal(c.list()[0].login.needsPastedCode, true);
  pane += `abc#def\n\n✓ Long-lived authentication token created successfully!\n\nYour OAuth token (valid for 1 year):\n\n${TOKEN}\n\nStore this token securely.\n__AO_EXIT:0\n`;
  await waitFor(() => c.list()[0].login?.state === 'done', { timeout: 2000 });
  assert.equal(captured, TOKEN);
  const row = c.list()[0];
  assert.equal(row.signedIn, true);
  assert.deepEqual([row.canLogout, row.ui.disconnect], [true, 'Stop sharing']);
  assert.ok(!JSON.stringify(row).includes('sk-ant-oat01'), 'the token is never in what the UI gets');
  assert.ok(calls.some((a) => a[0] === 'kill-session'), 'the session and its scrollback are killed');
  assert.equal((await c.logout('claude-machines')).status, 200);
  assert.equal(stopped, true);
  // A failed run's error line never carries a token.
  const failed = parsePane(SPECS.claudeShare, `oops ${TOKEN} failed\n__AO_EXIT:1\n`);
  assert.equal(failed.ok, true, 'the token printed means it worked');
  assert.ok(!parsePane({ url: /x/ }, `error near ${TOKEN}\n__AO_EXIT:3\n`).error.includes('sk-ant'));
  assert.ok(CLAUDE_TOKEN_RE.test(TOKEN));
});

// ---- end to end: an in-test hub + the real agent-share wiring, and a real worker process with nothing signed in.
let tmp, whome, bin, server, cluster, share, base, worker, out = '';
const headHome = () => path.join(tmp, 'head-home');
const env = () => ({ HOME: whome, PATH: bin, TMPDIR: tmp, AGENT_ORCH_REAPER: 'off', AGENT_ORCH_CRED_WATCH_MS: '200' });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-share-e2e-'));
  whome = path.join(tmp, 'worker-home');
  bin = path.join(tmp, 'bin');
  for (const d of [whome, bin, path.join(whome, '.local', 'bin'), path.join(headHome(), '.codex'), path.join(tmp, 'head-data')]) fs.mkdirSync(d, { recursive: true });
  isolatedPath(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec node ${path.join(ROOT, 'test/fixtures/worker-agent-stub.mjs')} "$@"\n`, { mode: 0o755 });
  // Claude: signed in only when the worker hands it CLAUDE_CODE_OAUTH_TOKEN (it records what it got).
  fs.writeFileSync(path.join(whome, '.local', 'bin', 'claude'), `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "2.1.282 (Claude Code)" ;;
  "auth status") if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" > "$HOME/claude-token-seen"; echo '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}';
    else echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'; exit 1; fi ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  cluster = createCluster({ dbFile: path.join(tmp, 'hub.db'), heartbeatMs: 300 });
  share = createAgentShare({ dataDir: path.join(tmp, 'head-data'), home: headHome(), send: (id, f) => cluster.send(id, f), targets: shareTargets(cluster), watchMs: 200 });
  wireAgentShare(cluster, share);
  server = http.createServer(async (req, res) => {
    if (req.url === WHOAMI_PATH && req.method === 'GET') {
      const r = cluster.whoami(req.headers);
      res.writeHead(r.status || 200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(r.status ? { error: r.error } : r));
    }
    if (req.url !== CLAIM_PATH || req.method !== 'POST') { res.writeHead(404); return res.end(); }
    let body = '';
    for await (const c of req) body += c;
    const r = cluster.claim(JSON.parse(body));
    res.writeHead(r.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.status ? { error: r.error } : r));
  });
  server.on('upgrade', (req, socket, head) => cluster.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (worker && worker.exitCode == null) {
    worker.kill('SIGTERM');
    await new Promise((r) => { const t = setTimeout(() => { worker.kill('SIGKILL'); r(); }, 10000); worker.on('exit', () => { clearTimeout(t); r(); }); });
  }
  share?.close(); cluster?.close(); server?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('a worker with nothing signed in runs Claude and Codex on the head\'s sign-ins; a Codex refresh there comes back', { timeout: 90000 }, async () => {
  // The head: Claude shared (a setup-token token), and its own Codex ChatGPT login.
  share.setClaudeToken(TOKEN);
  const first = codexAuth('acct-1', '2026-09-20T00:00:00Z');
  fs.writeFileSync(path.join(headHome(), '.codex', 'auth.json'), first);
  share.checkCodex();
  const { code } = cluster.createPairing();
  await promisify(execFile)(process.execPath, ['worker.mjs', 'pair', '--controller', base, '--code', code, '--name', 'mac'], { cwd: ROOT, env: env() });
  const { node } = JSON.parse(fs.readFileSync(path.join(whome, '.agent-orch-worker', 'config.json'), 'utf8'));
  worker = spawn(process.execPath, ['worker.mjs', 'run'], { cwd: ROOT, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', (d) => { out += d; });
  worker.stderr.on('data', (d) => { out += d; });
  const agent = (id) => cluster.node(node)?.inventory?.agents?.find((a) => a.id === id);
  const logTail = () => { try { return fs.readFileSync(path.join(whome, '.agent-orch-worker', 'worker.log'), 'utf8').split('\n').slice(-25).join('\n'); } catch (e) { return String(e); } };
  await waitFor(() => agent('claude')?.signedIn && agent('codex')?.shared, { timeout: 30000 }).catch((e) => {
    throw new Error(`${e.message}: shared sign-ins in the inventory\n${JSON.stringify(cluster.node(node)?.inventory?.agents?.map(({ models, ...a }) => a))}\n${logTail()}\n${out}`);
  });
  assert.deepEqual([agent('claude').installed, agent('claude').signedIn, agent('claude').shared], [true, true, true]);
  assert.equal(fs.readFileSync(path.join(whome, 'claude-token-seen'), 'utf8'), TOKEN, 'Claude ran with the head\'s token');
  const wauth = path.join(whome, '.codex', 'auth.json');
  assert.equal(fs.readFileSync(wauth, 'utf8'), first);
  assert.equal(mode(wauth), 0o600);
  assert.ok(!fs.existsSync(path.join(whome, '.claude', '.credentials.json')), 'no Claude credentials file on the worker');
  assert.ok(!out.includes(TOKEN) && !out.includes('rt-at-1'), 'no secret in the worker\'s log');

  // Codex refreshes its token on the worker: the head adopts the newer login.
  const refreshed = codexAuth('acct-1', '2026-09-28T00:00:00Z', 'at-2');
  fs.writeFileSync(wauth, refreshed, { mode: 0o600 });
  await waitFor(() => fs.readFileSync(path.join(headHome(), '.codex', 'auth.json'), 'utf8') === refreshed, { timeout: 10000, message: `head adopted the refresh\n${out}` });

  // The head stops sharing Claude, and signs out of Codex: the worker drops both.
  share.setClaudeToken(null);
  fs.rmSync(path.join(headHome(), '.codex', 'auth.json'));
  await waitFor(() => agent('claude')?.signedIn === false && !fs.existsSync(wauth), { timeout: 10000, message: `worker dropped both\n${out}` });
  assert.equal(agent('codex').shared, false);
});

// The installer's re-run check (worker.mjs check → WHOAMI_PATH): keep a pairing the head still knows, never add the
// machine twice; pair again once the head removed it or for another head; keep it when the head can't be asked.
test('worker.mjs check: known to the head, paired with another head, removed there, or the head unreachable', { timeout: 60000 }, async () => {
  const home = path.join(whome, '.agent-orch-worker');
  const { node, name } = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.deepEqual(await checkPairing({ home, controller: base }), { state: 'ok', name });
  assert.equal((await checkPairing({ home, controller: 'https://another-head.example' })).state, 'unpaired');
  const cli = async (...args) => promisify(execFile)(process.execPath, ['worker.mjs', 'check', ...args], { cwd: ROOT, env: env() })
    .then((r) => ({ code: 0, out: r.stdout }), (e) => ({ code: e.code, out: e.stdout }));
  assert.deepEqual(await cli('--controller', base), { code: 0, out: `paired as ${name}\n` });
  // A bad token asking is refused without revealing anything; the machine is removed on the head: pair again.
  const r = await fetch(new URL(WHOAMI_PATH, base), { headers: { authorization: 'Bearer aon_nope' } });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).node, undefined);
  cluster.revoke(node);
  assert.deepEqual(await checkPairing({ home, controller: base }), { state: 'unpaired', why: 'the head removed this machine' });
  assert.equal((await cli('--controller', base)).code, 3);
  // The head can't be asked (down, or a head too old to answer): keep the pairing (exit 2).
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...cfg, controller: 'http://127.0.0.1:9' }), { mode: 0o600 });
  assert.equal((await checkPairing({ home })).state, 'unknown');
  assert.equal((await cli()).code, 2);
});
