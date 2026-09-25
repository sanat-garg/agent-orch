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

test('an empty pane yields nothing yet', () => {
  assert.deepEqual(parsePane(SPECS.codex, ''), { url: null, code: null, prompts: [], exited: false, exitCode: null, ok: false, error: null });
});

// A fake tmux: records every call and serves pane text from `screen`.
function fakeTmux() {
  const calls = [];
  const t = { calls, screen: '', alive: false };
  t.run = async (args) => {
    calls.push(args);
    if (args[0] === 'new-session') { t.alive = true; return { ok: true, out: '' }; }
    if (args[0] === 'kill-session') { const was = t.alive; t.alive = false; return { ok: was, out: '' }; }
    if (args[0] === 'capture-pane') return { ok: t.alive, out: t.alive ? t.screen : '' };
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
  assert.deepEqual(t.calls.slice(-2).map((c) => c.slice(3)), [['-l', 'abc123'], ['Enter']]);
  assert.equal((await conn.cancel('x')).status, 200);
  assert.equal(conn.list()[0].login.state, 'cancelled');
  assert.equal(t.alive, false);
  assert.equal((await conn.submitCode('x', 'abc')).status, 409);
});

test('login flow: times out and kills the session', async () => {
  const { t, conn } = setup(SPECS.codex, { timeoutMs: 30 });
  await conn.start('x');
  await until(() => conn.list()[0].login.state === 'failed');
  assert.match(conn.list()[0].login.error, /timed out/);
  assert.equal(t.alive, false);
});

test('entries without a spec cannot start a login', async () => {
  const conn = createConnections({ entries: [{ id: 'c', label: 'C', installed: () => true, signedIn: () => true }], tmux: async () => assert.fail('no tmux') });
  assert.equal((await conn.start('c')).status, 400);
  assert.equal((await conn.logout('c')).status, 400);
  assert.equal((await conn.start('nope')).status, 404);
  assert.deepEqual(conn.list()[0], { id: 'c', label: 'C', installed: true, signedIn: true, account: null, canLogin: false, canLogout: false, login: null });
});
