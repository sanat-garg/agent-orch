// project-name.mjs: Haiku's one-word project name, its options, and the fallbacks (null) the server relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectWord, cleanWord, namePrompt, NAME_MODEL } from '../project-name.mjs';

const replying = (text, seen = {}) => (args) => {
  Object.assign(seen, args);
  return (async function* () {
    yield { type: 'system', subtype: 'init' };
    yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
    yield { type: 'result', subtype: 'success', result: text };
  })();
};

test('one word from Haiku: a tool-less, thinking-off single turn that lists the taken names', async () => {
  const seen = {};
  assert.equal(await projectWord('a website for my bakery', { taken: ['ledger'], query: replying('Knead\n', seen) }), 'knead');
  assert.equal(seen.options.model, NAME_MODEL);
  assert.deepEqual(seen.options.tools, []);
  assert.deepEqual(seen.options.thinking, { type: 'disabled' });
  assert.equal(seen.options.maxTurns, 1);
  assert.match(seen.prompt, /a website for my bakery/);
  assert.match(seen.prompt, /ledger/);
});

test('anything but one fresh plain word is null, so the server falls back to the message', async () => {
  assert.equal(await projectWord('a budget app', { taken: ['ledger'], query: replying('Ledger') }), null);
  assert.equal(await projectWord('a budget app', { query: replying('Penny Wise') }), null);
  assert.equal(await projectWord('a budget app', { query: replying('**Rise**\n\nThis name works well because…') }), null);
  assert.equal(await projectWord('a budget app', { query: () => { throw new Error('signed out'); } }), null);
  assert.equal(await projectWord('   ', { query: replying('never') }), null);
  assert.equal(cleanWord('"Tempo."'), 'tempo');
  assert.equal(cleanWord('ab'), null);
});

test('a slow Haiku is given up on at the timeout', async () => {
  const hang = ({ options }) => (async function* () {
    await new Promise((resolve) => options.abortController.signal.addEventListener('abort', resolve));
    throw new Error('aborted');
  })();
  const t0 = Date.now();
  assert.equal(await projectWord('a budget app', { query: hang, timeoutMs: 50 }), null);
  assert.ok(Date.now() - t0 < 2000);
});

test('the prompt caps the message and the taken list', () => {
  const p = namePrompt('x'.repeat(5000), Array.from({ length: 300 }, (_, i) => `n${i}`));
  assert.ok(!p.includes('x'.repeat(2001)));
  assert.ok(p.includes('n199') && !p.includes('n200,'));
});
