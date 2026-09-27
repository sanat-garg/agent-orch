// Own every temporary fixture for this run, including leftovers from failed setup hooks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(cache, { recursive: true });
const temp = fs.mkdtempSync(path.join(cache, 'agent-orch-test-'));
// One suite at a time per machine (several sessions share this 1-core box), at low CPU priority so the live server and
// chats stay responsive. flock waits for the lock; AGENT_ORCH_TEST_NOLOCK=1 skips it.
const lock = path.join(cache, 'agent-orch-test.lock');
const cmd = [process.execPath, '--test', 'test/**/*.test.mjs'];
const [bin, ...args] = process.env.AGENT_ORCH_TEST_NOLOCK ? ['nice', '-n', '10', ...cmd] : ['flock', lock, 'nice', '-n', '10', ...cmd];
// Ample memory: scheduling tests stay deterministic on a busy server (memory-guard tests point at their own file).
const child = spawn(bin, args, {
  cwd: root, stdio: 'inherit', detached: true, // its own process group, so a signal reaches node past flock and nice
  env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, AGENT_ORCH_MEMINFO: path.join(root, 'test/fixtures/meminfo-ample') },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { try { process.kill(-child.pid, signal); } catch {} });
child.on('error', (error) => { console.error(error); });
child.on('close', (code) => {
  fs.rmSync(temp, { recursive: true, force: true });
  process.exitCode = code ?? 1;
});
