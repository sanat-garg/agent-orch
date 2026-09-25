import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheck } from '../orchestrator.mjs';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('runCheck resolves promptly as failed when aborted', async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  const p = runCheck('sleep 30', tmpdir(), process.env, 60, ac.signal);
  setTimeout(() => ac.abort(), 100);
  const [ok, out, code] = await p;
  assert.equal(ok, false);
  assert.match(out, /\(aborted\)/);
  assert.equal(code, null);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

test('runCheck with an already-aborted signal does not run', async () => {
  const ac = new AbortController();
  ac.abort();
  const [ok, out] = await runCheck('sleep 30', tmpdir(), process.env, 60, ac.signal);
  assert.equal(ok, false);
  assert.match(out, /\(aborted\)/);
});

test('runCheck kills background processes the check started', async () => {
  const f = join(mkdtempSync(join(tmpdir(), 'runcheck-')), 'pid');
  const t0 = Date.now();
  const [ok, out] = await runCheck(`sleep 30 & echo $! > ${f}; echo ok`, tmpdir(), process.env, 60);
  assert.equal(ok, true);
  assert.match(out, /ok/);
  const pid = Number(readFileSync(f, 'utf8'));
  assert.ok(pid > 0);
  assert.ok(Date.now() - t0 < 5000, 'background job held the check open');
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(pid), false);
});
