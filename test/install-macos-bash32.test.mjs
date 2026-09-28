// bin/install-worker-macos.sh under bash 3.2.57, the /bin/bash every Mac ships (`curl … | sudo bash` runs it there). The
// bash 5 on this server hides its bugs: 3.2's `declare -f` prints `cmd <<EOF | next` with the `| next` after the EOF line,
// so the worker stage main hands `sudo -u agentorch -H bash -c` as `declare -f` text failed to parse on a real Mac
// ("syntax error near unexpected token `|'"). Skipped without the binary: build it with bin/dev/build-bash32.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'install-worker-macos.sh');
const ARGS = ['--dry-run', '--controller', 'https://x', '--code', 'TEST', '--agents', 'claude,codex'];
const B32 = path.join(os.homedir(), '.local', 'opt', 'bash-3.2.57', 'bin', 'bash');
const skip = !spawnSync(B32, ['-c', 'echo $BASH_VERSION'], { encoding: 'utf8' }).stdout?.startsWith('3.2.')
  && `bash 3.2 is missing (${B32}): build it with bin/dev/build-bash32.sh`;

// b32(args, {input, env}): bash 3.2 with a temp HOME; nothing it prints may be a parse or set -u failure.
function withB32(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-bash32-'));
  const b32 = (args, opts = {}) => {
    const r = spawnSync(B32, args, { encoding: 'utf8', input: opts.input, env: { ...process.env, HOME: home, NVM_DIR: path.join(home, 'nvm'), ...opts.env } });
    assert.doesNotMatch(r.stdout + r.stderr, /syntax error|unbound variable/, r.stderr);
    return r;
  };
  try { fn(b32, home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('bash 3.2 really prints a piped here-doc\'s `| next` after EOF (what the installer must avoid)', { skip }, () => {
  const r = spawnSync(B32, ['-c', 'f() {\n  cat <<EOF | cat\nx\nEOF\n}\n"$0" -n -c "$(declare -f f)"', B32], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /syntax error near unexpected token `\|'/);
});

test('macOS: the worker stage handed over as `declare -f` text re-parses and runs under bash 3.2', { skip }, () => {
  withB32((b32) => {
    // Load the functions without main (AGENT_ORCH_INSTALLER_NO_MAIN), then build the command main hands the worker
    // account: with every function (declare -f) and with just WORKER_FUNCS, as main does.
    const cmd = (fns, fn) => {
      const r = b32(['-c', `. "$0"; parse "$@"; vars="$(declare -p REPO LABEL CONTROLLER CODE NAME AGENTS DRY)"
        printf '%s' "set -euo pipefail; $vars; $(declare -f ${fns}); cd; ${fn}"`, MAC, ...ARGS], { env: { AGENT_ORCH_INSTALLER_NO_MAIN: '1' } });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^set -euo pipefail; declare -- REPO="sanat-garg\/agent-orch"/);
      return r.stdout;
    };
    for (const fns of ['', '"${WORKER_FUNCS[@]}"']) {
      const parsed = b32(['-n', '-c', cmd(fns, 'worker_stage')]);
      assert.equal(parsed.status, 0, `declare -f ${fns}: ${parsed.stderr}`);
      // DRY=1 rides along with the variables, so it runs here as it would for agentorch.
      const stage = b32(['-c', cmd(fns, 'worker_stage')]);
      assert.equal(stage.status, 0, `declare -f ${fns}: ${stage.stderr}`);
      assert.match(stage.stdout, /worker\.mjs pair --controller https:\/\/x --code TEST\n/);
    }
  });
});

test('macOS: --dry-run exits 0 under bash 3.2 in both user modes, as a file and piped (`curl … | sudo bash -s -- …`)', { skip }, () => {
  withB32((b32) => {
    for (const mode of [[], ['--no-dedicated-user']]) {
      const what = mode.join(' ') || 'dedicated user';
      for (const r of [b32([MAC, ...ARGS, ...mode]), b32(['-s', '--', ...ARGS, ...mode], { input: fs.readFileSync(MAC) })]) {
        assert.equal(r.status, 0, `${what}: ${r.stderr}`);
        assert.match(r.stdout, /Claude and Codex run on the head's accounts/, what);
      }
    }
  });
});
