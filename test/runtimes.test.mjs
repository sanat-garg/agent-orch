// Chat runtime retirement: a replaced runtime is marked, unregistered and closed, so its late exit can't evict the new one (AUDIT #3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retireRuntime } from '../runtimes.mjs';

const fakeRt = () => { const rt = { closed: 0 }; rt.q = { close: () => { rt.closed++; } }; return rt; };
// Mirrors the ownership guard in startRuntime's loop (server.mjs).
const owned = (runtimes, id, rt) => !rt.retired && runtimes.get(id) === rt;

test('after a rollover the old runtime no longer owns the slot, the new one does', () => {
  const runtimes = new Map();
  const old = fakeRt();
  runtimes.set('c', old);
  assert.equal(owned(runtimes, 'c', old), true);
  retireRuntime(runtimes, 'c');
  assert.equal(old.retired, true);
  assert.equal(old.closed, 1);
  assert.equal(runtimes.has('c'), false);
  const next = fakeRt();
  runtimes.set('c', next);
  assert.equal(owned(runtimes, 'c', old), false);
  assert.equal(owned(runtimes, 'c', next), true);
});

test('retiring an empty slot is a no-op', () => {
  assert.doesNotThrow(() => retireRuntime(new Map(), 'c'));
});
