// storage.mjs against a fake disk in a temp folder (real du, no sudo): the split into categories, what it suggests, and
// above all what it refuses to remove.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStorage } from '../storage.mjs';

const MB = 2 ** 20, DAY = 864e5, skip = process.platform !== 'linux' && 'GNU du only (the head runs on Linux)';
let root, home, app, data, project, workspace, st;
const put = (p, mb = 2) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(mb * MB, 1)); return p; };
// Everything under p looks untouched for `days`.
function age(p, days) {
  const t = new Date(Date.now() - days * DAY);
  if (fs.lstatSync(p).isDirectory()) for (const n of fs.readdirSync(p)) age(path.join(p, n), days);
  fs.utimesSync(p, t, t);
}
const exists = (p) => fs.existsSync(p);

before(() => {
  if (skip) return;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-storage-')));
  home = path.join(root, 'home', 'me');
  workspace = path.join(home, 'workspace');
  app = path.join(home, 'agent-orch');
  data = path.join(app, 'data');
  project = path.join(workspace, 'live');
  put(path.join(root, 'usr', 'lib', 'big'), 3);
  put(path.join(root, 'var', 'lib', 'db'), 2);
  put(path.join(root, 'var', 'cache', 'x'), 2);
  put(path.join(root, 'swapfile'), 2);
  put(path.join(root, 'tmp', 'old', 'a'), 2);
  put(path.join(root, 'tmp', 'fresh', 'a'), 2);
  put(path.join(app, 'server.mjs'), 2);
  put(path.join(data, 'x.db'), 2);
  put(path.join(project, 'src', 'a'), 2);
  fs.writeFileSync(path.join(project, '.env'), 'KEY=1');
  fs.writeFileSync(path.join(project, '.env.example'), 'KEY=');
  fs.mkdirSync(path.join(project, '.agent-orch'));
  put(path.join(project, '.git', 'objects', 'a'), 2);
  put(path.join(project, 'junk', 'a'), 2);
  put(path.join(workspace, 'idle', 'node_modules', 'a'), 2);
  fs.writeFileSync(path.join(workspace, 'idle', 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(workspace, 'idle', 'package.json'), '{}');
  put(path.join(workspace, 'nolock', 'node_modules', 'a'), 2);
  put(path.join(workspace, 'recent', 'node_modules', 'a'), 2);
  fs.writeFileSync(path.join(workspace, 'recent', 'package-lock.json'), '{}');
  put(path.join(home, '.cache', 'pip', 'a'), 2);
  put(path.join(home, '.cache', 'ms-playwright', 'a'), 2);
  put(path.join(home, '.npm', '_cacache', 'a'), 2);
  put(path.join(home, '.claude', 'skills', 'a'), 2);
  put(path.join(home, '.local', 'lib', 'a'), 2);
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', 'id'), 'k');
  fs.mkdirSync(path.join(home, '.agent-orch-worktrees', 'p-task-7'), { recursive: true });
  const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
  put(path.join(home, '.claude', 'projects', enc(path.join(home, '.agent-orch-worktrees', 'p-task-7')), 's.jsonl'), 1);
  put(path.join(home, '.claude', 'projects', enc(path.join(home, '.agent-orch-worktrees', 'p-task-6')), 's.jsonl'), 2);
  put(path.join(home, '.claude', 'projects', enc(project), 'chat.jsonl'), 1);
  for (const p of ['tmp/old', 'home/me/workspace/idle', 'home/me/workspace/nolock', 'home/me/.claude/projects', 'home/me/.cache/pip']) age(path.join(root, p), 40);
  st = createStorage({ root, home, appRoot: app, dataDir: data, workspace, tmpDirs: [path.join(root, 'tmp')], projects: () => [project], sudo: false, minItem: MB });
});
after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

test('the disk is split into categories that add up, largest first', { skip, timeout: 60000 }, async () => {
  const d = await st.overview();
  const of = Object.fromEntries(d.categories.map((c) => [c.id, c]));
  for (const id of ['projects', 'agents', 'system', 'caches', 'temp', 'swap', 'data', 'tools', 'app']) assert.ok(of[id]?.bytes > 0, `${id} is there`);
  assert.ok(of.projects.bytes >= 10 * MB && of.swap.bytes >= 2 * MB);
  assert.ok(of.caches.bytes >= 8 * MB, 'home caches and /var/cache together');
  assert.ok(of.data.items.every((i) => !i.path.includes('/var/cache')), '/var/cache left /var for Caches');
  assert.ok(of.app.bytes >= 4 * MB && !of.projects.items.some((i) => i.path === app), 'agent-orch is its own category');
  assert.ok(of.tools.items.some((i) => i.path.includes('/.local')), 'hidden home folders are tools');
  const real = d.categories.filter((c) => c.id !== 'other'), sizes = real.map((c) => c.bytes);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
  assert.ok(d.disk.total > 0 && d.disk.free > 0 && d.at > 0);
});

test('a scan is shared and kept until the owner asks for a fresh one', { skip, timeout: 60000 }, async () => {
  const fresh = await st.overview({ fresh: true }), again = await st.overview();
  assert.equal(again.at, fresh.at);
  const [a, b] = await Promise.all([st.overview({ fresh: true }), st.overview({ fresh: true })]);
  assert.equal(a.at, b.at);
});

test('suggestions: only what can come back or has sat untouched', { skip, timeout: 60000 }, async () => {
  const d = await st.overview({ fresh: true }), group = (id) => d.cleanups.find((g) => g.id === id);
  assert.deepEqual(group('temp').items.map((i) => i.path), [path.join(root, 'tmp', 'old')], 'old temp only, not what was just written');
  const deps = group('deps').items;
  assert.deepEqual(deps.map((i) => i.path), [path.join(workspace, 'idle', 'node_modules')], 'needs a lockfile, and an idle project');
  assert.equal(deps[0].restore, 'npm ci in ~/workspace/idle');
  const caches = group('caches').items.map((i) => i.path);
  assert.ok(caches.includes(path.join(home, '.cache', 'pip')) && caches.includes(path.join(home, '.npm', '_cacache')));
  assert.ok(!caches.some((p) => p.endsWith('ms-playwright')), "agent-orch's browser stays");
  const t = group('transcripts').items[0];
  assert.equal(t.clean, 'transcripts');
  assert.match(t.label, /^1 finished task$/, 'the worktree still on disk keeps its transcripts, and chats are never listed');
  assert.equal(d.reclaimable, d.cleanups.reduce((a, g) => a + g.bytes, 0));
});

test('the gate refuses what would break things, with a reason', { skip, timeout: 30000 }, async () => {
  const cases = [
    [root, /system/i], [path.join(root, 'usr'), /system/i], [home, /system/i], [path.join(root, 'tmp'), /system/i],
    [app, /agent-orch/], [path.join(app, 'server.mjs'), /agent-orch/], [data, /agent-orch/], [path.dirname(home), /system/i],
    [workspace, /projects live/], [project, /project folder/], [path.join(home, '.agent-orch-worktrees'), /worktrees/],
    [path.join(home, '.ssh'), /agent-orch|credential/i], [path.join(home, '.claude'), /agents/], [path.join(home, '.claude', 'skills'), /agents/],
    [path.join(home, '.local', 'lib'), /tools and settings/], [path.join(project, '.git'), /history/], [path.join(project, '.env'), /credentials/], [path.join(project, '.agent-orch'), /notes/],
    [path.join(home, '.cache', 'ms-playwright'), /agent-orch/], [path.join(home, '.cache'), /agent-orch/], [path.join(root, 'nope'), /Not found/],
  ];
  for (const [p, re] of cases) assert.match(String(await st.whyNot(p)), re, p);
  for (const p of [path.join(project, 'junk'), path.join(project, 'src', 'a'), path.join(project, '.env.example'), path.join(home, '.cache', 'pip'), path.join(root, 'tmp', 'old')]) assert.equal(await st.whyNot(p), null, p);
});

test('a folder a running program uses is refused, and free again once it stops', { skip, timeout: 30000 }, async () => {
  const dir = path.join(workspace, 'running');
  fs.mkdirSync(dir, { recursive: true });
  put(path.join(dir, 'node_modules', 'pkg', 'a'), 1);
  put(path.join(dir, '.next', 'server', 'a'), 1);
  put(path.join(dir, 'tools', 'data', 'a'), 1);
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  age(dir, 40);
  const child = spawn('sleep', ['60'], { cwd: dir });
  await new Promise((r) => child.once('spawn', r));
  // procs() caches for 5 s, so a fresh gate sees this process.
  const fresh = () => createStorage({ root, home, appRoot: app, dataDir: data, workspace, tmpDirs: [path.join(root, 'tmp')], projects: () => [project], sudo: false });
  assert.match(String(await fresh().whyNot(dir)), /In use by sleep/);
  // What the app needs at run time goes with it, however deep; other folders in the project stay removable.
  for (const p of ['node_modules', 'node_modules/pkg', '.next', '.next/server']) assert.match(String(await fresh().whyNot(path.join(dir, p))), /In use by sleep/, p);
  assert.equal(await fresh().whyNot(path.join(dir, 'tools', 'data')), null);
  const suggested = (await fresh().overview()).cleanups.find((g) => g.id === 'deps')?.items.map((i) => i.path) || [];
  assert.ok(!suggested.includes(path.join(dir, 'node_modules')), `never suggested while it runs: ${suggested}`);
  const r = await fresh().remove([dir]);
  assert.equal(r.removed.length, 0);
  assert.ok(exists(dir));
  child.kill('SIGKILL');
  await new Promise((res) => child.once('exit', res));
  assert.equal(await fresh().whyNot(dir), null);
  assert.equal(await fresh().whyNot(path.join(dir, 'node_modules')), null);
  fs.rmSync(dir, { recursive: true });
});

test('remove deletes only what passes the gate, one by one, and reports the rest', { skip, timeout: 30000 }, async () => {
  const junk = path.join(project, 'junk');
  const link = path.join(project, 'link-to-app');
  fs.symlinkSync(app, link);
  const r = await st.remove([junk, app, project, path.join(project, '.env'), 'relative/path', link, path.join(workspace, '..', '.ssh')]);
  assert.deepEqual(r.removed.map((x) => x.path), [junk]);
  assert.ok(r.removed[0].bytes >= 2 * MB);
  assert.ok(!exists(junk));
  for (const p of [app, project, path.join(project, '.env'), path.join(home, '.ssh', 'id'), link]) assert.ok(exists(p), p);
  assert.equal(r.skipped.length, 6);
  assert.ok(r.skipped.every((s) => s.reason));
  await assert.rejects(st.remove([]), { status: 400 });
  await assert.rejects(st.remove('nope'), { status: 400 });
  fs.rmSync(link);
});

test('clean removes transcripts of gone worktrees only; other ids are refused', { skip, timeout: 30000 }, async () => {
  const base = path.join(home, '.claude', 'projects'), enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
  const r = await st.clean('transcripts');
  assert.equal(r.removed.length, 1);
  assert.ok(!exists(path.join(base, enc(path.join(home, '.agent-orch-worktrees', 'p-task-6')))));
  assert.ok(exists(path.join(base, enc(path.join(home, '.agent-orch-worktrees', 'p-task-7')))), 'its worktree is still there');
  assert.ok(exists(path.join(base, enc(project))), 'chat history stays');
  await assert.rejects(st.clean('everything'), { status: 404 });
  await assert.rejects(st.clean('apt'), { status: 409 }, 'no sudo here');
});
