// extractCommand: which "Done when" text becomes the verifier's shell command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCommand } from '../orchestrator.mjs';

test('extractCommand joins every command snippet with &&', () => {
  assert.equal(extractCommand('`! grep -q foo x.mjs` and `npm test` passes'), '! grep -q foo x.mjs && npm test');
  assert.equal(extractCommand('`grep -n foo x.mjs` prints nothing and `npm test` passes'), '{ grep -n foo x.mjs; test $? -eq 1; } && npm test');
});

test('extractCommand ignores file-name and identifier snippets', () => {
  assert.equal(extractCommand('`server.mjs` sets `loggedIn` and `npm test` passes'), 'npm test');
  assert.equal(extractCommand('`server.mjs` exports `loggedIn`'), null);
});

test('extractCommand leaves a single command unchanged', () => {
  assert.equal(extractCommand('`npm test` passes'), 'npm test');
  assert.equal(extractCommand('`grep -n foo x.mjs` prints nothing'), 'grep -n foo x.mjs; test $? -eq 1');
  assert.equal(extractCommand('Run:\n```bash\nnode --test\n```\nand `npm test`'), 'node --test');
  assert.equal(extractCommand('npm run build succeeds'), 'npm run build succeeds');
});

test('extractCommand refuses when any command snippet is unsafe', () => {
  assert.equal(extractCommand('`npm test` and `node x.mjs > out`'), null);
  assert.equal(extractCommand('`curl -s localhost` and `npm test`'), null);
});

test('extractCommand keeps a backslash-escaped backtick inside the snippet', () => {
  assert.equal(extractCommand('`! grep -nE "signed in\\`|x" a.js` finds nothing, and `node --check a.js && npm test` passes'),
    '! grep -nE "signed in\\`|x" a.js && node --check a.js && npm test');
});
