// bin/install-worker.sh (Linux/systemd) and bin/install-worker-macos.sh (macOS/launchd): syntax, and --dry-run output
// (which changes nothing, so it runs on this Linux box for both). HOME is a temp dir so nothing real is inspected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');
const LINUX = path.join(BIN, 'install-worker.sh'), MAC = path.join(BIN, 'install-worker-macos.sh');
const ARGS = ['--dry-run', '--controller', 'https://head.example', '--code', 'ABCD-2345', '--name', 'box', '--agents', 'claude,codex'];

function dry(script, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-install-'));
  try {
    const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, NVM_DIR: path.join(home, 'nvm') } });
    return { ...r, home };
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('both scripts pass bash -n', () => {
  for (const s of [LINUX, MAC]) execFileSync('bash', ['-n', s]);
});

// macOS's /bin/bash is 3.2. The installer hands the worker stage's functions (WORKER_FUNCS) to the worker account's bash
// as text (declare -f), and 3.2 reprints `cat <<EOF | cmd` with the pipe after EOF, which no bash parses back (on a real
// Mac: "bash: -c: line 208: syntax error near unexpected token `|'"). So no here-document may feed a pipe, the text must
// parse again, and the worker stage must run from it alone (every function it calls is in the list).
// CW_BASH32=/path/to/bash-3.2 (or /bin/bash on a Mac) repeats this with the real 3.2.
test('macos: the worker stage survives the declare -f hand-over (bash 3.2 on macOS)', () => {
  const code = (s) => fs.readFileSync(s, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'); // comments may quote the pattern
  for (const s of [LINUX, MAC]) assert.doesNotMatch(code(s), /<<-?\s*['"]?\w+['"]?[^\n]*\|/, `${path.basename(s)}: a here-document feeds a pipe`);
  const body = fs.readFileSync(MAC, 'utf8').replace(/\n(?:\[\[[^\n]*\]\] \|\| )?main "\$@"\s*$/, '\n');
  const shells = ['bash', process.env.CW_BASH32, process.platform === 'darwin' ? '/bin/bash' : null].filter(Boolean);
  for (const sh of shells) {
    const dumps = execFileSync(sh, ['-c', `${body}\ndeclare -f; echo '#---'; declare -f "\${WORKER_FUNCS[@]}"`], { encoding: 'utf8' });
    for (const part of dumps.split('#---')) execFileSync(sh, ['-n'], { input: part }); // throws on a syntax error
    // Every script function the handed-over ones call is handed over too (a missing one only fails on its branch).
    const [defined, listed] = execFileSync(sh, ['-c', `${body}\ndeclare -F | awk '{print $3}' | tr '\\n' ' '; echo; echo "\${WORKER_FUNCS[*]}"`], { encoding: 'utf8' })
      .trim().split('\n').map((l) => l.trim().split(/\s+/));
    const handed = dumps.split('#---')[1];
    const missing = defined.filter((f) => !listed.includes(f) && new RegExp(`(^|[\\s;(&|])${f}([\\s;)]|$)`, 'm').test(handed));
    assert.deepEqual(missing, [], `${sh}: WORKER_FUNCS lacks functions the worker stage calls`);
    // Exactly what main runs as the worker account (here in dry-run, as this user, in a temp HOME).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-install-'));
    try {
      const script = `${body}\nREPO=sanat-garg/agent-orch CONTROLLER=https://head.example CODE=ABCD-2345 NAME=box AGENTS=claude DRY=1\n` +
        `vars="$(declare -p "\${WORKER_VARS[@]}")"\n` +
        `exec ${sh} -c "set -euo pipefail; $vars; $(declare -f "\${WORKER_FUNCS[@]}"); cd; worker_stage; node_path"`;
      const r = spawnSync(sh, ['-c', script], { encoding: 'utf8', env: { ...process.env, HOME: home, NVM_DIR: path.join(home, 'nvm') } });
      assert.equal(r.status, 0, `${sh}: ${r.stderr}`);
      assert.match(r.stdout, /worker\.mjs pair --controller https:\/\/head\.example --code ABCD-2345/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

// Agent CLIs go into the worker's own ~/.local: npm -g would write to the Node's prefix, which under Homebrew belongs
// to the Mac's admin (a real Mac: EACCES on /opt/homebrew/lib/node_modules/@openai). PATH here has node but no codex.
test('macos --dry-run: codex installs into the worker account\'s ~/.local, never the Node\'s global prefix', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-install-bin-'));
  try {
    for (const t of ['node', 'id', 'uname', 'sed', 'dirname', 'cat', 'tr', 'awk', 'mkdir']) {
      const p = execFileSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim();
      fs.symlinkSync(p, path.join(bin, t));
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-install-'));
    try {
      const r = spawnSync(execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim(), [MAC, ...ARGS.filter((a) => a !== 'claude,codex'), 'codex', '--no-dedicated-user', '--service', 'login'],
        { encoding: 'utf8', env: { HOME: home, PATH: bin, NVM_DIR: path.join(home, 'nvm') } });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes(`+ npm i -g --prefix ${home}/.local @openai/codex`), r.stdout);
      assert.doesNotMatch(r.stdout, /npm i -g @openai\/codex/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

// Re-running the installer on a paired Mac keeps the pairing the head still knows (a real Mac got "… 2" each time);
// --repair pairs it again.
test('macos --dry-run on a paired Mac: checks the pairing instead of adding the Mac again; --repair pairs again', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-install-'));
  try {
    fs.mkdirSync(path.join(home, '.agent-orch-worker'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agent-orch-worker', 'config.json'), '{}');
    const run = (extra) => spawnSync('bash', [MAC, ...ARGS, '--no-dedicated-user', '--service', 'login', ...extra],
      { encoding: 'utf8', env: { ...process.env, HOME: home, NVM_DIR: path.join(home, 'nvm') } });
    const kept = run([]);
    assert.equal(kept.status, 0, kept.stderr);
    assert.match(kept.stdout, /\+ node \S+\/worker\.mjs check --controller https:\/\/head\.example/);
    const again = run(['--repair']);
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /worker\.mjs check/);
    assert.match(again.stdout, /Pairing again as a new machine \(--repair/);
    assert.match(again.stdout, /worker\.mjs pair --controller https:\/\/head\.example --code ABCD-2345/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// launchd: bootout returns before the old worker is gone, and a bootstrap then fails with "5: Input/output error" (a
// real Mac on a re-run). relaunch waits for the label to go and retries; here launchctl/plutil/sleep are stand-ins.
test('macos relaunch: waits for the old job to leave, then loads it, retrying a failed bootstrap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-launchd-'));
  try {
    const bin = path.join(dir, 'bin'), log = path.join(dir, 'calls');
    fs.mkdirSync(bin);
    // `print` succeeds twice (still loaded), then fails (gone); the first bootstrap fails with launchd's error 5.
    fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  print) n=$(grep -c '^print' "${log}"); [ "$n" -le 2 ] && exit 0; exit 113 ;;
  bootstrap) n=$(grep -c '^bootstrap' "${log}"); if [ "$n" -eq 1 ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi ;;
esac
exit 0
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'plutil'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const body = fs.readFileSync(MAC, 'utf8').replace(/\nmain "\$@"\s*$/, '\n');
    const r = spawnSync('bash', ['-c', `${body}\nDRY=0; relaunch system com.agent-orch.worker /Library/LaunchDaemons/w.plist; echo loaded`],
      { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /loaded/);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')[0]);
    assert.deepEqual(calls, ['bootout', 'print', 'print', 'print', 'enable', 'bootstrap', 'bootstrap']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('linux --dry-run: clones, pairs and writes a systemd unit with Restart=always and MemoryHigh', () => {
  const r = dry(LINUX, ARGS);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Dry run/);
  assert.match(r.stdout, /\+ gh repo clone sanat-garg\/agent-orch \S+\/agent-orch-worker/);
  assert.match(r.stdout, /npm ci/);
  assert.match(r.stdout, /worker\.mjs pair --controller https:\/\/head\.example --code ABCD-2345 --name box/);
  assert.match(r.stdout, /write \/etc\/systemd\/system\/agent-orch-worker\.service/);
  assert.match(r.stdout, /Restart=always/);
  assert.match(r.stdout, /MemoryHigh=\d+%/);
  assert.match(r.stdout, /ExecStart=\S+node \S+\/worker\.mjs run/);
  assert.match(r.stdout, /systemctl enable agent-orch-worker\.service/);
});

test('linux --dry-run --uninstall removes the unit and the checkout', () => {
  const r = dry(LINUX, ['--dry-run', '--uninstall']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /systemctl disable --now agent-orch-worker\.service/);
  assert.match(r.stdout, /rm -rf \S+\/agent-orch-worker\n/);
});

test('macos --service login --dry-run: dedicated agentorch user, sudoers rule for one launcher, a KeepAlive LaunchAgent', () => {
  const r = dry(MAC, [...ARGS, '--service', 'login']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Why a dedicated user/);
  assert.match(r.stdout, /sysadminctl -addUser agentorch/);
  assert.match(r.stdout, /agentorch\/agent-orch-worker\/worker\.mjs pair --controller https:\/\/head\.example --code ABCD-2345/);
  assert.match(r.stdout, /NOPASSWD: \/usr\/local\/bin\/agent-orch-worker-run/);
  assert.match(r.stdout, /Library\/LaunchAgents\/com\.agent-orch\.worker\.plist/);
  assert.match(r.stdout, /<key>KeepAlive<\/key><true\/>/);
  assert.match(r.stdout, /<string>Aqua<\/string>/);
  assert.match(r.stdout, /launchctl bootstrap gui\/\d+/);
});

test('macos --no-dedicated-user --dry-run warns and runs the worker as the caller', () => {
  const r = dry(MAC, [...ARGS, '--no-dedicated-user']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Warning: installing under your own account/);
  assert.doesNotMatch(r.stdout, /sysadminctl/);
  assert.match(r.stdout, /<key>EnvironmentVariables<\/key>/);
});

test('bad arguments are refused', () => {
  for (const s of [LINUX, MAC]) {
    assert.notEqual(dry(s, ['--dry-run', '--agents', 'gemini']).status, 0);
    assert.notEqual(dry(s, ['--dry-run', '--controller', 'ftp://x']).status, 0);
    assert.notEqual(dry(s, ['--bogus']).status, 0);
  }
});
