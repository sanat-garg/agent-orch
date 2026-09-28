// #302 (BRIEF goal 9, rapid development mode): the controller's own work slots are the owner's setting, any integer
// 1-16 (default from its hardware: 4 on the 2-core head, parallel.mjs headTarget); memory above the emergency floor never lowers it (the meminfo fixture has ~11 GiB available).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
const meminfo = new URL('./fixtures/meminfo-ample', import.meta.url).pathname;

test('parallelTasks: 4 by default on 2 cores, 12 is accepted and counts, 0, 17 and non-integers are rejected', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-parset-'));
  try {
    const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
      const [dataDir] = process.argv.slice(1);
      const o = createOrchestrator({ query: () => (async function* () {})(), dataDir, disabled: true, claudeEnv: {}, getLimits: () => [], onSubscription: () => false,
        broadcast() {}, emitChat() {}, convoExists: () => false, config: { meminfo: ${JSON.stringify(meminfo)}, hardware: { cores: 2 } } });
      const view = () => { const s = o.stateView(); return { setting: s.parallel.parallelTasks, controllerMax: s.capacity.controllerMax, controller: s.capacity.controller }; };
      const before = view();
      const ok = o.setParallelSettings({ parallelTasks: 12 });
      const after = view();
      const bad = [17, 0, 2.5, '4'].map((n) => o.setParallelSettings({ parallelTasks: n }).error);
      console.log(JSON.stringify({ before, ok: ok.ok, after, bad, stillTwelve: view().setting }));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir], { encoding: 'utf8', timeout: 30000 });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    assert.deepEqual(r.before, { setting: 4, controllerMax: 4, controller: 4 }, 'default: four on a 2-core server');
    assert.equal(r.ok, true);
    assert.deepEqual(r.after, { setting: 12, controllerMax: 12, controller: 12 });
    assert.deepEqual(r.bad, Array(4).fill('Expected parallelTasks 1-16'));
    assert.equal(r.stillTwelve, 12, 'a rejected value leaves the setting alone');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
