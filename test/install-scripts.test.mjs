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
