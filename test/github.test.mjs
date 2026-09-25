import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHub } from '../github.mjs';

// test/fixtures/gh-stub.mjs stands in for `gh`, linked into a temp bin dir on PATH.
const STUB = fileURLToPath(new URL('./fixtures/gh-stub.mjs', import.meta.url));

test('concurrent ensureRepo calls for one dir create a single repo (AUDIT #12)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-test-'));
  const bin = path.join(tmp, 'bin'), dir = path.join(tmp, 'my-proj'), log = path.join(tmp, 'creates.log');
  fs.mkdirSync(bin); fs.mkdirSync(dir);
  fs.symlinkSync(STUB, path.join(bin, 'gh'));
  const gh = createGitHub({ env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_STUB_LOG: log }, log: () => {} });
  try {
    const [a, b] = await Promise.all([gh.ensureRepo(dir), gh.ensureRepo(dir)]);
    const creates = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(creates.length, 1);
    assert.equal(JSON.parse(creates[0])[2], 'my-proj');
    assert.deepEqual(a, { full: 'tester/my-proj', url: 'https://github.com/tester/my-proj' });
    assert.deepEqual(b, a);
    // Once settled, a later call finds the existing origin instead of creating again.
    assert.deepEqual(await gh.ensureRepo(dir), a);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
