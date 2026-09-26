// Own every temporary fixture for this run, including leftovers from failed setup hooks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(cache, { recursive: true });
const temp = fs.mkdtempSync(path.join(cache, 'agent-orch-test-'));
const child = spawn(process.execPath, ['--test', 'test/**/*.test.mjs'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error(error); });
child.on('close', (code) => {
  fs.rmSync(temp, { recursive: true, force: true });
  process.exitCode = code ?? 1;
});
