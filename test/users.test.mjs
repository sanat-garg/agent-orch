// users.mjs: the admin migrated from the old single password, sign-in by name (blank = admin, alias 'claude'), account
// rules, each user's estimated share of a weekly window from their tokens, and the cap check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsers, shareOf, windowCovers, windowName, ADMIN_ID } from '../users.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cw-users-'));
const legacyAuth = (dir, pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') }));
};
const NOW = 1_800_000_000_000, RESET = NOW / 1000 + 2 * 86400; // the week began five days ago
// A fake usage log: plan windows now, and tokens records.
const fakeLog = (windows, tokens) => ({ current: (agent) => windows.filter((w) => w.agent === agent), tokensSince: (t) => tokens.filter((r) => r.t >= t) });
const tok = (user, model, output, agent = 'claude', t = NOW - 86400e3) => ({ t, kind: 'tokens', agent, input: 0, cached: 0, output, ...(user && { user }), model });

test('migrates the old password into the admin, who signs in by blank name, "admin" or the old "claude"', () => {
  const dir = tmp();
  legacyAuth(dir, 'old-password');
  const users = createUsers({ dataDir: dir });
  assert.equal(users.list().length, 1);
  assert.equal(users.check('', 'old-password')?.id, ADMIN_ID);
  assert.equal(users.check('admin', 'old-password')?.id, ADMIN_ID);
  assert.equal(users.check('Claude', 'old-password')?.id, ADMIN_ID, 'saved passwords carry the old hidden username');
  assert.equal(users.check('admin', 'wrong'), null);
  assert.ok(fs.existsSync(path.join(dir, 'users.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('accounts: add, sign in, roles, caps validation, at least one admin', () => {
  const dir = tmp();
  legacyAuth(dir, 'old-password');
  const users = createUsers({ dataDir: dir });
  const sam = users.add({ name: 'Sam', password: 'sam-password', caps: { 'claude/Fable': 10 } });
  assert.equal(sam.name, 'sam');
  assert.equal(sam.role, 'user');
  assert.deepEqual(sam.caps, { 'claude/Fable': 10 });
  assert.equal(users.check('sam', 'sam-password')?.id, sam.id);
  assert.throws(() => users.add({ name: 'sam', password: 'another-pw' }), /taken/);
  assert.throws(() => users.add({ name: 'kim', password: 'short' }), /8 characters/);
  assert.throws(() => users.update(sam.id, { caps: { 'claude/five_hour': 10 } }), /weekly/);
  assert.throws(() => users.update(sam.id, { caps: { 'claude/seven_day': 150 } }), /0 to 100/);
  assert.deepEqual(users.update(sam.id, { caps: { 'claude/seven_day': 25, 'claude/Fable': null } }).caps, { 'claude/seven_day': 25 });
  assert.throws(() => users.update(ADMIN_ID, { role: 'user' }), /one admin/);
  assert.throws(() => users.remove(ADMIN_ID), /one admin/);
  assert.deepEqual(users.update(sam.id, { role: 'admin' }).caps, {}, 'admins are never capped');
  users.update(sam.id, { role: 'user' });
  users.remove(sam.id);
  assert.equal(users.check('sam', 'sam-password'), null);
  // Another process (set-password) rewriting the file is picked up.
  const again = createUsers({ dataDir: dir });
  again.setAdminPassword('brand-new-password');
  assert.equal(users.check('', 'brand-new-password')?.id, ADMIN_ID);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('windows: which models count toward which weekly window', () => {
  assert.ok(windowCovers('claude', 'seven_day', 'haiku'));
  assert.ok(windowCovers('claude', 'Fable', 'claude-fable-5-1'));
  assert.ok(!windowCovers('claude', 'Fable', 'opus'));
  assert.ok(windowCovers('claude', 'seven_day_opus', 'opus'));
  assert.ok(windowCovers('codex', 'weekly', 'gpt-5'));
  assert.equal(windowName('claude', 'seven_day'), 'Claude · all models');
  assert.equal(windowName('claude', 'Fable'), 'Claude · Fable');
  assert.equal(windowName('codex', 'weekly'), 'Codex · all models');
});

test("a user's share of a window is the account's pct split by weighted tokens since the window began", () => {
  const records = [
    tok('sam', 'claude-fable-5-1', 300), tok(null, 'claude-fable-5-1', 900), // older records without a user are the admin's
    tok('sam', 'opus', 1000), tok('sam', 'claude-fable-5-1', 5000, 'claude', NOW - 6 * 86400e3), // before the week began
  ];
  const fable = shareOf(records, { user: 'sam', agent: 'claude', window: 'Fable', pct: 40, resetsAt: RESET }, NOW);
  assert.equal(fable.mine, 10); // 300 of 1200 weighted Fable tokens this week, of 40%
  const all = shareOf(records, { user: 'sam', agent: 'claude', window: 'seven_day', pct: 22, resetsAt: RESET }, NOW);
  assert.equal(all.mine, 22 * 1300 / 2200);
  assert.equal(shareOf([], { user: 'sam', agent: 'claude', window: 'seven_day', pct: 50, resetsAt: RESET }, NOW).mine, 0);
});

test('capBlock: a user over their cap for that model is blocked until the reset; other models and admins are not', () => {
  const dir = tmp();
  legacyAuth(dir, 'old-password');
  const tokens = [];
  const log = fakeLog([{ agent: 'claude', window: 'seven_day', pct: 50, resetsAt: RESET }, { agent: 'claude', window: 'Fable', pct: 40, resetsAt: RESET },
    { agent: 'claude', window: 'five_hour', pct: 90, resetsAt: NOW / 1000 + 3600 }],
  tokens);
  const users = createUsers({ dataDir: dir, usageLog: log, now: () => NOW });
  const sam = users.add({ name: 'sam', password: 'sam-password', caps: { 'claude/Fable': 10 } });
  tokens.push(tok(sam.id, 'claude-fable-5-1', 300), tok(null, 'claude-fable-5-1', 900), tok(null, 'opus', 9000)); // records carry the user's id
  const usage = users.usage(sam.id);
  assert.deepEqual(usage.map((w) => w.window), ['seven_day', 'Fable'], 'only weekly windows');
  assert.equal(usage.find((w) => w.window === 'Fable').mine, 10);
  const b = users.capBlock(sam.id, 'claude', 'claude-fable-5-1');
  assert.equal(b?.window, 'Fable');
  assert.equal(b.resetsAt, RESET);
  assert.equal(users.capBlock(sam.id, 'claude', 'opus'), null, 'the Fable cap leaves other models alone');
  users.update(sam.id, { caps: { 'claude/Fable': 10.5 } });
  assert.equal(users.capBlock(sam.id, 'claude', 'claude-fable-5-1'), null, 'under the cap');
  users.update(sam.id, { caps: { 'claude/seven_day': 1 } });
  assert.equal(users.capBlock(sam.id, 'claude', 'opus')?.window, 'seven_day', 'an all-models cap covers every model');
  assert.equal(users.capBlock(ADMIN_ID, 'claude', 'claude-fable-5-1'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
