// connections.mjs: pane parsing against recorded tmux captures, and the login flow against a fake tmux (no real login).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { parsePane, createConnections, SPECS, agyAccount, agyLogout, agyTokenFile } from '../connections.mjs';

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

test('agy panes (recorded): picks Google OAuth, rejoins the wrapped URL, reads the TUI error', () => {
  const menu = parsePane(SPECS.antigravity, pane('agy-select.txt'));
  assert.deepEqual([menu.url, menu.prompts, menu.exited], [null, [0], false]);
  assert.deepEqual(SPECS.antigravity.answers[0][1], ['Enter']);
  const p = parsePane(SPECS.antigravity, pane('agy-url.txt'));
  assert.match(p.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?access_type=offline&client_id=[\w.-]+&/);
  assert.ok(p.url.includes('&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&'), 'wrapped lines rejoined');
  assert.ok(p.url.includes('userinfo.profile+'), 'mid-word wrap rejoined');
  assert.ok(p.url.endsWith('+openid&state=kMk9I9CTODCHtI5FVNl_yg'));
  assert.ok(!/\s/.test(p.url));
  assert.deepEqual([p.prompts, p.exited, SPECS.antigravity.needsPastedCode], [[], false, true]);
  const bad = parsePane(SPECS.antigravity, pane('agy-error.txt'));
  assert.deepEqual([bad.exited, bad.exitCode, bad.ok], [true, null, false]);
  assert.match(bad.error, /^Got an error: token exchange failed: .*Malformed auth code/);
  const ok = parsePane(SPECS.antigravity, 'Authentication successful!\n');
  assert.deepEqual([ok.exited, ok.ok], [true, true]);
});

test('an empty pane yields nothing yet', () => {
  assert.deepEqual(parsePane(SPECS.codex, ''), { url: null, code: null, prompts: [], exited: false, exitCode: null, ok: false, error: null });
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

test('login flow: a probe that reports signed in ends the login as done', async () => {
  const t = fakeTmux();
  let probes = 0, signed = false;
  const conn2 = createConnections({
    entries: [{ id: 'a', label: 'A', installed: () => true, signedIn: () => signed, spec: SPECS.antigravity, probe: async () => { probes++; return signed; } }],
    tmux: t.run, pollMs: 5, probeMs: 20,
  });
  await conn2.start('a');
  t.screen = pane('agy-url.txt');
  await until(() => conn2.list()[0].login.url?.includes('oauth2'));
  await until(() => probes >= 1);
  assert.equal(conn2.list()[0].login.state, 'waiting');
  signed = true;
  await until(() => conn2.list()[0].login.state === 'done');
  assert.equal(t.alive, false);
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

// A fake agy home: the token file with an unsigned JWT id_token, plus agy's other files that must survive a logout.
function fakeAgyHome(claims = { iss: 'https://accounts.google.com', sub: '123', email: 'owner@example.com', email_verified: true }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-')), dir = path.join(home, '.gemini/antigravity-cli');
  fs.mkdirSync(dir, { recursive: true });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  fs.writeFileSync(path.join(dir, 'antigravity-oauth-token'), JSON.stringify({
    token: { access_token: 'ya29.fake', token_type: 'Bearer', refresh_token: '1//fake', expiry: '2026-09-25T15:00:00Z' },
    auth_method: 'consumer', id_token: `${b64({ alg: 'RS256' })}.${b64(claims)}.sig` }));
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
  fs.writeFileSync(path.join(dir, 'installation_id'), 'x');
  return { home, dir };
}

test('agy account email comes from the token file id_token', () => {
  assert.equal(agyAccount(fakeAgyHome().home), 'owner@example.com');
  assert.equal(agyAccount(fakeAgyHome({ sub: '1' }).home), null);
  assert.equal(agyAccount(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-none-'))), null);
});

test('agy logout removes only the token file, and fails when there is none', async () => {
  const { home, dir } = fakeAgyHome();
  const conn = createConnections({ entries: [{ id: 'antigravity', label: 'Antigravity CLI', installed: () => true, signedIn: () => fs.existsSync(agyTokenFile(home)),
    account: () => agyAccount(home), spec: { ...SPECS.antigravity, logout: () => agyLogout(home) } }], tmux: async () => ({ ok: true, out: '' }) });
  assert.deepEqual([conn.list()[0].canLogout, conn.list()[0].account, conn.list()[0].logoutWarning], [true, 'owner@example.com', undefined]);
  assert.equal((await conn.logout('antigravity')).status, 200);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['installation_id', 'settings.json']);
  assert.deepEqual([conn.list()[0].signedIn, conn.list()[0].account], [false, null]);
  const r = await conn.logout('antigravity');
  assert.equal(r.status, 500);
  assert.match(r.error, /no Antigravity token file/);
  assert.equal(SPECS.antigravity.logout, agyLogout);
});
