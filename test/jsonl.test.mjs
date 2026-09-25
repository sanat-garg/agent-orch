// parseJsonl: chat logs and task run logs survive a corrupt or partial line (AUDIT #13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonl } from '../orchestrator.mjs';

test('parseJsonl skips a corrupt line and keeps the other entries', () => {
  const text = '{"k":"user","text":"hi"}\n{"k":"assist\n\n{"k":"result","ok":true}\n{"k":"text","te';
  assert.deepEqual(parseJsonl(text), [{ k: 'user', text: 'hi' }, { k: 'result', ok: true }]);
  assert.deepEqual(parseJsonl(''), []);
});
