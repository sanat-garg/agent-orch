// bin/test-select.mjs: `npm test` runs the test files a change can reach and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { selectTests, checkoutChanges, readIn } from '../bin/test-select.mjs';

const repo = {
  'core.mjs': "export const x = 1; // server.mjs names this file in a comment only",
  'lib.mjs': "import { x } from './core.mjs';\nconst shot = new URL('./bin/tool.mjs', import.meta.url);",
  'server.mjs': "import './lib.mjs'; // comment naming other.mjs",
  'other.mjs': 'export const y = 2;',
  'bin/tool.mjs': '',
  'public/app.js': '',
  'test/helpers/wait.mjs': '',
  'test/fixtures/stub.mjs': "import '../../other.mjs';",
  'test/fixtures/panes/a.txt': '',
  'test/fixtures/orphan': '',
  'test/core.test.mjs': "import { x } from '../core.mjs';",
  'test/server.test.mjs': "spawn(process.execPath, ['server.mjs']); import { wait } from './helpers/wait.mjs';",
  'test/ui.test.mjs': "import { chromium } from 'playwright-core'; spawn('server.mjs');",
  'test/stub.test.mjs': "const f = fixture('stub.mjs'); const dir = fixture('panes');",
};
const pick = (...changed) => selectTests({ files: Object.keys(repo), read: (f) => repo[f] ?? '', changed });

test('a change runs the tests that import it, directly or through other modules and spawned files; browser tests wait for the full suite', () => {
  assert.deepEqual(pick('core.mjs').tests, ['test/core.test.mjs', 'test/server.test.mjs']);
  assert.deepEqual(pick('server.mjs'), { tests: ['test/server.test.mjs'], changed: ['server.mjs'], deferred: ['test/ui.test.mjs'] });
  assert.deepEqual(pick('bin/tool.mjs').tests, ['test/server.test.mjs']); // lib.mjs loads it by URL
  // other.mjs is only named in source comments, but a fixture imports it
  assert.deepEqual(pick('other.mjs').tests, ['test/stub.test.mjs']);
});

test('test files, helpers, fixtures and public/ select their users', () => {
  assert.deepEqual(pick('test/core.test.mjs').tests, ['test/core.test.mjs']);
  assert.deepEqual(pick('test/helpers/wait.mjs').tests, ['test/server.test.mjs']);
  assert.deepEqual(pick('test/fixtures/stub.mjs').tests, ['test/stub.test.mjs']);
  assert.deepEqual(pick('test/fixtures/panes/a.txt').tests, ['test/stub.test.mjs']);
  assert.deepEqual(pick('public/app.js').tests, ['test/ui.test.mjs']);
  assert.deepEqual(pick('test/ui.test.mjs', 'server.mjs').tests, ['test/server.test.mjs', 'test/ui.test.mjs']);
});

test('notes select nothing; runner changes and unreferenced test files select everything', () => {
  assert.deepEqual(pick('.agent-orch/AUDIT.md', 'README.md', 'docs/diagram.png'), { tests: [], changed: [], deferred: [] });
  assert.equal(pick('package.json').all, true);
  assert.equal(pick('bin/test.mjs', 'core.mjs').all, true);
  assert.equal(pick('test/fixtures/orphan').all, true);
  assert.deepEqual(pick('test/gone.test.mjs').tests, []); // a deleted test has nothing left to run
});

test('checkoutChanges diffs a branch against its merge-base with main, uncommitted and untracked files included', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-select-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' });
  try {
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.mjs'), '1');
    fs.writeFileSync(path.join(dir, 'b.mjs'), '1');
    git('add', '-A'); git('commit', '-qm', 'base');
    git('checkout', '-qb', 'task');
    fs.writeFileSync(path.join(dir, 'a.mjs'), '2');
    git('commit', '-qam', 'task work');
    git('checkout', '-q', 'main'); fs.writeFileSync(path.join(dir, 'c.mjs'), '1'); git('add', '-A'); git('commit', '-qm', 'main moved on');
    git('checkout', '-q', 'task');
    fs.writeFileSync(path.join(dir, 'b.mjs'), '2');
    fs.writeFileSync(path.join(dir, 'new.mjs'), '1');
    const co = checkoutChanges(dir);
    assert.deepEqual(co.changed.sort(), ['a.mjs', 'b.mjs', 'new.mjs']); // not c.mjs: main's later commit isn't this change
    assert.deepEqual(co.files.sort(), ['a.mjs', 'b.mjs', 'new.mjs']);
    assert.equal(readIn(dir)('a.mjs'), '2');
    git('checkout', '-q', '-f', 'main'); fs.rmSync(path.join(dir, 'new.mjs'));
    assert.deepEqual(checkoutChanges(dir).changed, []); // on main itself: only uncommitted work counts
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
