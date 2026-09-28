// bin/install-worker-macos.sh for many Macs: the default service is a LaunchDaemon running the worker as agentorch from
// boot, the dry run shows the power policy with its caffeinate keep-awake, a multi-use --code pairs without --name (each
// Mac names itself), and switching modes or uninstalling removes the other mode's pieces. --dry-run changes nothing,
// so it runs on this Linux box; HOME is a temp dir so nothing real is inspected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'install-worker-macos.sh');
function dry(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-macinst-'));
  try { return spawnSync('bash', [MAC, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, NVM_DIR: path.join(home, 'nvm') } }); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('`bash bin/install-worker-macos.sh --dry-run --code TEST` exits 0 and shows the LaunchDaemon and caffeinate setup', () => {
  const r = dry(['--dry-run', '--code', 'TEST']);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /sysadminctl -addUser agentorch/);
  // Pairs with the (multi-use) code under the Mac's own name: no --name.
  assert.match(out, /worker\.mjs pair --controller https:\/\/<controller> --code TEST\n/);
  assert.match(out, /names itself "<model> \(<host name>\)"/);
  // The LaunchDaemon: root-owned, runs as agentorch from boot, restarted by launchd.
  assert.match(out, /\+ write \/Library\/LaunchDaemons\/com\.agent-orch\.worker\.plist \(mode 0644, root\)/);
  for (const key of ['<key>UserName</key><string>agentorch</string>', '<key>KeepAlive</key><true/>', '<key>RunAtLoad</key><true/>',
    '<key>HOME</key><string>/Users/agentorch</string>', '<string>/Users/agentorch/agent-orch-worker/worker.mjs</string>', '<key>Nice</key><integer>5</integer>']) {
    assert.ok(out.includes(key), key);
  }
  assert.match(out, /\+ launchctl bootstrap system \/Library\/LaunchDaemons\/com\.agent-orch\.worker\.plist/);
  assert.doesNotMatch(out, /LimitLoadToSessionType|sudoers\.d\/agent-orch-worker\b(?!-status)|LaunchAgents/, 'no login-mode pieces');
  // The one-word status view, always: it re-runs itself as agentorch under a sudoers rule for exactly it.
  assert.match(out, /\+ write \/usr\/local\/bin\/agent-orch-worker-status \(mode 0755, root\)/);
  assert.match(out, /NOPASSWD: \/usr\/local\/bin\/agent-orch-worker-status\n/);
  assert.match(out, /Progress: agent-orch-worker-status\n/);
  // The power policy, with caffeinate holding the Mac awake while connected, on battery too; the lid still sleeps it.
  assert.match(out, /caffeinate -i -w <worker pid>/);
  assert.match(out, /keeps the Mac awake, on battery too/);
  assert.match(out, /closing the lid still sleeps the Mac/);
  assert.match(out, /on battery above 50%/);
  assert.match(out, /cores − 1 tasks at once \(Max tasks: Auto\), leaving 3 GB of RAM free for you/);
  assert.match(out, /whether or not anyone is logged in/);
});

test('--service login keeps the start-at-login LaunchAgent; bad combinations are refused', () => {
  const r = dry(['--dry-run', '--controller', 'https://head.example', '--code', 'ABCD-2345', '--service', 'login']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NOPASSWD: \/usr\/local\/bin\/agent-orch-worker-run/);
  assert.match(r.stdout, /Library\/LaunchAgents\/com\.agent-orch\.worker\.plist/);
  assert.match(r.stdout, /launchctl bootstrap gui\/\d+/);
  assert.doesNotMatch(r.stdout, /LaunchDaemons/);
  assert.match(r.stdout, /caffeinate -i -w <worker pid>/);
  assert.notEqual(dry(['--dry-run', '--service', 'cron']).status, 0);
  const self = dry(['--dry-run', '--no-dedicated-user', '--service', 'daemon']);
  assert.notEqual(self.status, 0);
  assert.match(self.stderr, /LaunchDaemon needs the dedicated user/);
});

test('--uninstall removes the LaunchDaemon and the login-mode pieces', () => {
  const r = dry(['--dry-run', '--uninstall']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /launchctl bootout system\/com\.agent-orch\.worker/);
  assert.match(r.stdout, /rm -f \/Library\/LaunchDaemons\/com\.agent-orch\.worker\.plist \/etc\/sudoers\.d\/agent-orch-worker \/usr\/local\/bin\/agent-orch-worker-run/);
  assert.match(r.stdout, /rm -rf \/Users\/agentorch\/agent-orch-worker\n/);
});
