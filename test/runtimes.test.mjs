// Chat runtime ownership: a retired runtime must not remove or speak for its replacement (AUDIT #3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownsRuntime, retireRuntime } from '../runtimes.mjs';

const fakeRt = () => { const rt = { closed: 0 }; rt.q = { close: () => { rt.closed++; } }; return rt; };

test('the registered runtime owns its slot', () => {
  const runtimes = new Map();
  const rt = fakeRt();
  runtimes.set('c', rt);
  assert.equal(ownsRuntime(runtimes, 'c', rt), true);
});

test('after a rollover the old runtime no longer owns the slot, the new one does', () => {
  const runtimes = new Map();
  const old = fakeRt();
  runtimes.set('c', old);
  retireRuntime(runtimes, 'c');
  assert.equal(old.retired, true);
  assert.equal(old.closed, 1);
  assert.equal(runtimes.has('c'), false);
  const next = fakeRt();
  runtimes.set('c', next);
  assert.equal(ownsRuntime(runtimes, 'c', old), false);
  assert.equal(ownsRuntime(runtimes, 'c', next), true);
});

test('a retired runtime never owns the slot, even if still registered', () => {
  const runtimes = new Map();
  const rt = fakeRt();
  runtimes.set('c', rt);
  rt.retired = true;
  assert.equal(ownsRuntime(runtimes, 'c', rt), false);
});

test('retiring an empty slot is a no-op', () => {
  const runtimes = new Map();
  assert.doesNotThrow(() => retireRuntime(runtimes, 'c'));
});
