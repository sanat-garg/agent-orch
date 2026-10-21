// The owner's standing design rule (server.mjs DESIGN_RULE) reaches every chat (chatSystemAppend) and every planner and
// task run (convoPersona). server.mjs can't be imported in a test (it boots the app), so check its source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('every chat, planner and task run gets the design rule', () => {
  const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const rule = src.match(/^const DESIGN_RULE = '(.+)';$/m)?.[1];
  assert.ok(rule, 'DESIGN_RULE defined');
  assert.match(rule, /Human Interface Guidelines/);
  assert.match(rule, /No gradients/);
  assert.match(src, /convoPersona: [^\n]*DESIGN_RULE/, 'planner and task runs');
  assert.match(src.slice(src.indexOf('function chatSystemAppend')), /^\$\{DESIGN_RULE\}$/m, 'chats');
});
