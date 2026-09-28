// connections.mjs: pane parsing against recorded tmux captures, and the login flow against a fake tmux (no real login).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePane, createConnections, SPECS } from '../connections.mjs';

const pane = (f) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/panes', f), 'utf8');

test('codex device-auth pane: URL and one-time code, still running', () => {
  const p = parsePane(SPECS.codex, pane('codex-device.txt'));
  assert.equal(p.url, 'https://auth.openai.com/codex/device');
  assert.equal(p.code, 'WVH5-RVUT0');
  assert.deepEqual([p.exited, p.ok, p.error], [false, false, null]);
});

test('codex pane: success and expiry are detected from the exit marker', () => {
  const ok = parsePane(SPECS.codex, pane('codex-success.txt'));
  assert.deepEqual([ok.exited, ok.exitCode, ok.ok, ok.error], [true, 0, true, null]);
  const bad = parsePane(SPECS.codex, pane('codex-expired.txt'));
  assert.deepEqual([bad.exited, bad.exitCode, bad.ok], [true, 1, false]);
  assert.match(bad.error, /device code expired/);
});

test('codex login forces the ChatGPT login method', () => {
  assert.ok(SPECS.codex.start.includes('forced_login_method="chatgpt"'));
});

test('gh pane: code, fallback device URL, prompts to answer, success', () => {
  const p = parsePane(SPECS.github, pane('gh-device.txt'));
  assert.equal(p.code, '1A2B-3C4D');
  assert.equal(p.url, 'https://github.com/login/device');
  assert.deepEqual(p.prompts, [0, 1]);
  assert.equal(p.exited, false);
  const done = parsePane(SPECS.github, pane('gh-success.txt'));
  assert.deepEqual([done.exited, done.ok], [true, true]);
});

test('claude pane (recorded): subscription OAuth URL, waits for a pasted code; failure from the exit marker', () => {
  assert.deepEqual(SPECS.claude.start.slice(1), ['auth', 'login', '--claudeai']);
  assert.ok(!SPECS.claude.start.includes('--console'), 'never the API-billing Console login');
  const p = parsePane(SPECS.claude, pane('claude-login.txt'));
  assert.match(p.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&client_id=[\w-]+&.*state=[\w-]+$/);
  assert.deepEqual([p.code, p.exited, SPECS.claude.needsPastedCode], [null, false, true]);
  const bad = parsePane(SPECS.claude, pane('claude-failed.txt'));
  assert.deepEqual([bad.exited, bad.exitCode, bad.ok], [true, 1, false]);
  assert.match(bad.error, /^Paste code here if prompted > Login failed: Request failed with status code 400$/);
  const ok = parsePane(SPECS.claude, `${pane('claude-login.txt')}\nLogin successful.\n__AO_EXIT:0\n`);
  assert.deepEqual([ok.exited, ok.ok], [true, true]);
});

test('an empty pane yields nothing yet', () => {
  assert.deepEqual(parsePane(SPECS.codex, ''), { url: null, code: null, prompts: [], exited: false, exitCode: null, ok: false, error: null });
});

test('unknown CLI prompts are surfaced instead of waiting forever', async () => {
  const t = fakeTmux();
  const conn = createConnections({ entries: [{ id: 'x', label: 'X', installed: () => true, signedIn: () => false, spec: SPECS.codex }],
    tmux: t.run, pollMs: 1, promptTimeoutMs: 0 });
  await conn.start('x');
  t.screen = 'Continue setup? (y/N)';
  await until(() => conn.list()[0].login?.prompt);
  assert.match(conn.list()[0].login.prompt, /Continue setup/);
  await conn.cancel('x');
});

// A fake tmux: records every call and serves pane text from `screen`; `failSend` makes send-keys fail; `delay` (ms)
// makes every call slow, to open race windows.
function fakeTmux() {
  const calls = [];
  const t = { calls, screen: '', alive: false, delay: 0 };
  t.run = async (args) => {
    calls.push(args);
    if (t.delay) await new Promise((r) => setTimeout(r, t.delay));
    if (args[0] === 'new-session') { t.alive = true; return { ok: true, out: '' }; }
    if (args[0] === 'kill-session') { const was = t.alive; t.alive = false; return { ok: was, out: '' }; }
    if (args[0] === 'capture-pane') return { ok: t.alive, out: t.alive ? t.screen : '' };
    if (args[0] === 'send-keys') return { ok: !t.failSend, out: '' };
    return { ok: true, out: '' };
  };
  return t;
}
const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(fn()); };

function setup(spec, extra = {}) {
  const t = fakeTmux(), changes = [];
  let signedIn = false, after = 0;
  const conn = createConnections({
    entries: [{ id: 'x', label: 'X', installed: () => true, signedIn: () => signedIn, spec, envFilter: /^SECRET_KEY$/, afterChange: () => { after++; signedIn = true; } }],
    env: { SECRET_KEY: 'k', PATH: '/usr/bin' }, tmux: t.run, pollMs: 5, onChange: (l) => changes.push(l), ...extra,
  });
  return { t, conn, changes, after: () => after };
}

test('login flow: start, surface URL/code, succeed, clean up', async () => {
  const { t, conn, changes, after } = setup(SPECS.codex);
  const r = await conn.start('x');
  assert.equal(r.status, 200);
  const ns = t.calls.find((c) => c[0] === 'new-session');
  assert.match(ns.at(-1), /^unset SECRET_KEY; 'codex' 'login' '--device-auth'/);
  assert.match(ns.at(-1), /__AO_EXIT/);
  t.screen = pane('codex-device.txt');
  await until(() => conn.list()[0].login?.code === 'WVH5-RVUT0');
  assert.equal(conn.list()[0].login.url, 'https://auth.openai.com/codex/device');
  t.screen = pane('codex-success.txt');
  await until(() => conn.list()[0].login.state === 'done');
  assert.equal(t.alive, false, 'session killed');
  assert.equal(after(), 1);
  assert.equal(conn.list()[0].signedIn, true);
  assert.ok(changes.length >= 3);
});

test('login flow: auto-answers prompts once, forwards a pasted code, cancels', async () => {
  const spec = { ...SPECS.github, needsPastedCode: true };
  const { t, conn } = setup(spec);
  await conn.start('x');
  t.screen = pane('gh-device.txt');
  await until(() => conn.list()[0].login.code === '1A2B-3C4D');
  await new Promise((r) => setTimeout(r, 30));
  const keys = t.calls.filter((c) => c[0] === 'send-keys').map((c) => c.slice(3));
  assert.deepEqual(keys, [['Y', 'Enter'], ['Enter']]);
  assert.equal((await conn.submitCode('x', 'bad\ncode')).status, 400);
  assert.equal((await conn.submitCode('x', ' abc123 ')).status, 200);
  assert.deepEqual(t.calls.slice(-2).map((c) => c.slice(3)), [['-l', '--', 'abc123'], ['Enter']]);
  assert.equal((await conn.cancel('x')).status, 200);
  assert.equal(conn.list()[0].login.state, 'cancelled');
  assert.equal(t.alive, false);
  assert.equal((await conn.submitCode('x', 'abc')).status, 409);
});

test('submitCode: a leading-dash code goes after --, and a failed send skips Enter (AUDIT #25)', async () => {
  const { t, conn } = setup(SPECS.claude);
  await conn.start('x');
  assert.equal((await conn.submitCode('x', '-abc_def')).status, 200);
  assert.deepEqual(t.calls.slice(-2).map((c) => c.slice(3)), [['-l', '--', '-abc_def'], ['Enter']]);
  t.failSend = true;
  const n = t.calls.length, r = await conn.submitCode('x', '-abc_def');
  assert.equal(r.status, 500);
  assert.match(r.error, /could not send/);
  assert.deepEqual(t.calls.slice(n).filter((c) => c[0] === 'send-keys').map((c) => c.slice(3)), [['-l', '--', '-abc_def']], 'no Enter');
  await conn.cancel('x');
});

test('login flow: times out and kills the session', async () => {
  const { t, conn } = setup(SPECS.codex, { timeoutMs: 30 });
  await conn.start('x');
  await until(() => conn.list()[0].login.state === 'failed');
  assert.match(conn.list()[0].login.error, /timed out/);
  assert.equal(t.alive, false);
});

test('race: two starts at once make one session and one poller (AUDIT #22)', async () => {
  const { t, conn } = setup(SPECS.codex);
  t.delay = 10;
  const orig = globalThis.setInterval;
  let intervals = 0;
  globalThis.setInterval = (...a) => { intervals++; return orig(...a); };
  try {
    const [a, b] = await Promise.all([conn.start('x'), conn.start('x')]);
    assert.deepEqual([a.status, b.status], [200, 200]);
  } finally { globalThis.setInterval = orig; }
  assert.equal(t.calls.filter((c) => c[0] === 'new-session').length, 1);
  assert.equal(intervals, 1);
  assert.equal(conn.list()[0].login.state, 'waiting');
  await conn.cancel('x');
});

test('race: start, cancel, start again: the old deadline does not fail the new login (AUDIT #22)', async () => {
  const { t, conn } = setup(SPECS.codex, { timeoutMs: 200 });
  t.delay = 5;
  await Promise.all([conn.start('x'), conn.start('x')]);
  await conn.cancel('x');
  assert.equal(conn.list()[0].login.state, 'cancelled');
  await new Promise((r) => setTimeout(r, 100));
  await conn.start('x');
  await new Promise((r) => setTimeout(r, 150)); // past the first login's deadline, before the second's
  assert.equal(conn.list()[0].login.state, 'waiting');
  assert.equal(t.alive, true);
  await conn.cancel('x');
});

test('race: a cancel while start is in flight wins and kills the new session (AUDIT #22)', async () => {
  const { t, conn } = setup(SPECS.codex);
  t.delay = 10;
  const started = conn.start('x');
  await new Promise((r) => setTimeout(r, 15)); // between kill-session and new-session
  assert.equal((await conn.cancel('x')).status, 200);
  await started;
  await new Promise((r) => setTimeout(r, 30));
  assert.notEqual(conn.list()[0].login.state, 'waiting');
  assert.equal(t.alive, false, 'the session start() made was killed');
  assert.equal(t.calls.filter((c) => c[0] === 'capture-pane').length, 0, 'no poller');
});

test('entries without a spec cannot start a login', async () => {
  const conn = createConnections({ entries: [{ id: 'c', label: 'C', installed: () => true, signedIn: () => true }], tmux: async () => assert.fail('no tmux') });
  assert.equal((await conn.start('c')).status, 400);
  assert.equal((await conn.logout('c')).status, 400);
  assert.equal((await conn.start('nope')).status, 404);
  assert.deepEqual(conn.list()[0], { id: 'c', label: 'C', installed: true, signedIn: true, account: null, canLogin: false, canLogout: false, login: null });
});

test('claude logout needs an explicit confirmation and carries the warning', async () => {
  const conn = createConnections({ entries: [{ id: 'claude', label: 'Claude Code', installed: () => true, signedIn: () => true, spec: { ...SPECS.claude, logout: ['true'] } }], tmux: async () => ({ ok: true, out: '' }) });
  assert.match(conn.list()[0].logoutWarning, /Every chat and orchestrator agent/);
  const r = await conn.logout('claude', {});
  assert.deepEqual([r.status, r.needsConfirm], [409, true]);
  assert.equal((await conn.logout('claude', { confirm: true })).status, 200);
});

test('startup kills logins orphaned by a previous server on the login socket (AUDIT #23)', async () => {
  const { t, conn } = setup(SPECS.codex);
  await until(() => t.calls.length > 0);
  assert.deepEqual(t.calls[0], ['kill-server']);
  await conn.start('x');
  assert.deepEqual(t.calls.slice(0, 3).map((c) => c[0]), ['kill-server', 'kill-session', 'new-session'], 'start waits for it');
  await conn.cancel('x');
  // A failing tmux (e.g. no server running) is ignored.
  createConnections({ entries: [], tmux: async () => { throw new Error('no server'); } });
});

test('cancel with no login returns login: null so a stale panel clears (AUDIT #23)', async () => {
  const { conn } = setup(SPECS.codex);
  const { status, ...body } = await conn.cancel('x');
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, login: null });
  await conn.start('x');
  assert.equal((await conn.cancel('x')).login.state, 'cancelled');
});

// "Invalid OAuth Request: Missing state parameter" (a real sign-in): `claude setup-token`'s Ink screen hard-wraps its
// long OAuth URL at the pane width, so the captured line lacked `&state=…`. The rest of the URL is on the next line(s).
test('a hard-wrapped Claude OAuth URL is joined back whole; one still missing its state is not shown yet', () => {
  const head = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=j2MmaCS9Wr5PTOY4YbRZMdnJ';
  const tail = 'jm5pTG8Q-_DJXCeaiMU&code_challenge_method=S256&state=myv1DK5P8J9yRC_fBPCfnX5YzeX_qwbBLGT54WkJraE';
  const wrapped = `Browser didn't open? Use the url below to sign in (c to copy)\n\n${head}\n${tail}\n\n Hold Shift while selecting to copy\n\nPaste code here if prompted >`;
  assert.equal(parsePane(SPECS.claudeShare, wrapped).url, head + tail);
  assert.equal(new URL(parsePane(SPECS.claudeShare, wrapped).url).searchParams.get('state'), 'myv1DK5P8J9yRC_fBPCfnX5YzeX_qwbBLGT54WkJraE');
  // Output still arriving (the rest not printed yet): no URL, rather than a broken one.
  assert.equal(parsePane(SPECS.claudeShare, `${head}\n`).url, null);
  assert.equal(parsePane(SPECS.claude, `If the browser didn't open, visit: ${head}\n`).url, null);
  // A whole URL on one line is left as is, and the prompt after it is not glued on.
  const one = `If the browser didn't open, visit: ${head}${tail}\nPaste code here if prompted >`;
  assert.equal(parsePane(SPECS.claude, one).url, head + tail);
  // A short URL is never extended by the line after it (codex prints its one-time code right below the link).
  assert.equal(parsePane(SPECS.codex, 'Follow these steps:\n   https://auth.openai.com/codex/device\nABCD-12345\n').url, 'https://auth.openai.com/codex/device');
});

test('sign-in sessions run 1000 columns wide, so a long OAuth URL fits on one line', async () => {
  const calls = [];
  const tmux = async (args) => { calls.push(args); return { ok: true, out: '' }; };
  const c = createConnections({ tmux, pollMs: 60_000, entries: [{ id: 'claude', label: 'Claude Code', installed: () => true, signedIn: () => false, spec: SPECS.claude }] });
  await c.start('claude');
  const ns = calls.find((a) => a[0] === 'new-session');
  assert.equal(ns[ns.indexOf('-x') + 1], '1000');
  await c.cancel('claude');
});

// "Sign-in failed: the sign-in session ended unexpectedly" (a real sign-in on the live server): every instance clears
// its tmux socket at boot, and test servers booting on the same machine used the live server's socket.
test('each server instance signs in on its own tmux socket; one booting never ends another\'s sign-in', async () => {
  const { loginSocketFor, tmuxRunnerFor, SOCKET } = await import('../connections.mjs');
  assert.equal(loginSocketFor('/srv/agent-orch/data', '/srv/agent-orch/data/'), SOCKET, 'the live server keeps its socket');
  const a = loginSocketFor('/tmp/cw-test-a', '/srv/agent-orch/data'), b = loginSocketFor('/tmp/cw-test-b', '/srv/agent-orch/data');
  assert.notEqual(a, SOCKET);
  assert.notEqual(a, b);
  assert.equal(loginSocketFor('/tmp/cw-test-a', '/srv/agent-orch/data'), a, 'stable across restarts');
  assert.ok(a.startsWith('agent-orch-login'), 'the reaper still knows it for a login session');

  const { spawnSync } = await import('node:child_process');
  if (spawnSync('tmux', ['-V']).status !== 0) return; // no tmux here: the naming above is what matters
  const tag = `cwtest-${process.pid}-${Date.now()}`, live = `${tag}-live`, other = `${tag}-other`;
  const entry = { id: 'x', label: 'X', installed: () => true, signedIn: () => false, spec: { start: ['sleep', '30'], url: /(https:\/\/\S+)/ } };
  const alive = () => spawnSync('tmux', ['-L', live, 'has-session', '-t', '=login-x']).status === 0;
  try {
    const liveConns = createConnections({ tmux: tmuxRunnerFor(live), pollMs: 60_000, entries: [entry] });
    await liveConns.start('x');
    assert.ok(alive(), 'the sign-in session runs');
    createConnections({ tmux: tmuxRunnerFor(other), entries: [entry] }); // a test server boots: clears only its own socket
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(alive(), 'still running after another instance booted');
    createConnections({ tmux: tmuxRunnerFor(live), entries: [entry] }); // what used to happen: the same socket
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(alive(), false, 'booting on the same socket ends it (why each instance has its own)');
    await liveConns.cancel('x');
  } finally {
    for (const s of [live, other]) spawnSync('tmux', ['-L', s, 'kill-server']);
  }
});
