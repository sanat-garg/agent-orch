// Discovery/limit/status helpers (helpers.mjs): a timeout kills the helper's whole process tree, even members that ignore
// SIGTERM; nothing outlives the parent; concurrent discoveries of one agent share one spawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runHelper, singleFlight } from '../helpers.mjs';
import { discoverModels, clearLoginCache, setModelCatalog } from '../agents.mjs';
import { waitFor } from './helpers/wait.mjs';

const stub = fileURLToPath(new URL('./fixtures/tree-stub.mjs', import.meta.url));
const parent = fileURLToPath(new URL('./fixtures/helper-parent.mjs', import.meta.url));
const marker = () => `tree-stub-${process.pid}-${Math.random().toString(36).slice(2)}`;
// Live (non-zombie) processes whose command line carries the marker, from a /proc scan.
function procsWith(mark) {
  const out = [];
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(mark)) continue;
      if (/^\S+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) continue;
      out.push(Number(pid));
    } catch {}
  }
  return out;
}

test('helper timeout kills the whole tree (SIGTERM, then SIGKILL) and the promise settles', async () => {
  const mark = marker(), t0 = Date.now();
  // Long enough for both to start (and ignore SIGTERM) on a loaded machine.
  const p = runHelper(stub, [mark], { timeoutMs: 5000 });
  await waitFor(() => procsWith(mark).length === 2, { timeout: 4500, message: 'stub and its child started' });
  const r = await p;
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 12_000, 'settles within the kill grace');
  await waitFor(() => procsWith(mark).length === 0, { timeout: 2000, message: 'no stub process survives' });
});

test('helper exits normally: members it left behind are killed too', async () => {
  const mark = marker();
  const r = await runHelper(stub, [mark, 'exit'], { timeoutMs: 20_000 });
  assert.equal(r.timedOut, false);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /done/);
  await waitFor(() => procsWith(mark).length === 0, { timeout: 5000, message: 'the leftover child is killed' });
});

test('an abort kills the tree; a missing binary settles with an error', async () => {
  const mark = marker(), ac = new AbortController();
  const p = runHelper(stub, [mark], { signal: ac.signal });
  await waitFor(() => procsWith(mark).length === 2, { timeout: 10_000 });
  ac.abort();
  assert.equal((await p).aborted, true);
  await waitFor(() => procsWith(mark).length === 0, { timeout: 2000 });
  assert.ok((await runHelper('/nonexistent/helper', [])).error);
});

test('nothing outlives the parent: a SIGKILLed parent\'s helper tree is killed by its watchdog', async () => {
  const mark = marker();
  const child = spawn(process.execPath, [parent, stub, mark], { stdio: 'ignore' });
  await waitFor(() => procsWith(mark).length === 2, { timeout: 10_000, message: 'helper started under the parent' });
  child.kill('SIGKILL');
  await waitFor(() => procsWith(mark).length === 0, { timeout: 8000, message: 'the orphaned helper tree is killed' });
});

test('single-flight: 5 concurrent discoveries of one agent spawn its CLI once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-sf-')), count = path.join(dir, 'count'), prev = process.env.PATH;
  fs.symlinkSync(stub, path.join(dir, 'opencode'));
  process.env.PATH = `${dir}:${prev}`;
  t.after(() => { process.env.PATH = prev; clearLoginCache(); setModelCatalog('opencode', { models: [], error: 'reset', at: Date.now() }); fs.rmSync(dir, { recursive: true, force: true }); });
  const opts = { bin: stub, env: { ...process.env, TREE_STUB_COUNT: count }, home: dir };
  const all = await Promise.all(Array.from({ length: 5 }, () => discoverModels('opencode', opts)));
  assert.equal(fs.readFileSync(count, 'utf8').split('\n').filter(Boolean).length, 1);
  for (const e of all) assert.deepEqual(e.models.map((m) => m.id), ['opencode/big-pickle']);
  // A later call starts a fresh discovery.
  await discoverModels('opencode', opts);
  assert.equal(fs.readFileSync(count, 'utf8').split('\n').filter(Boolean).length, 2);
  let n = 0;
  await Promise.all([1, 2, 3].map(() => singleFlight('k', async () => { n++; })));
  assert.equal(n, 1);
});
