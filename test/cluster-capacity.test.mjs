// The scheduler's view of the cluster (orchestrator nodesNow / capacityView), with a stub hub: an Auto worker (maxSlots
// null) counts the slots its cores and free RAM allow (nodeCap), and a node change (cluster.version()) is seen by the
// next read, not after the one-second cache (else a worker that just reconnected looks offline to placement).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('capacity counts an Auto worker by its nodeCap and follows a node change at once', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-capacity-'));
  try {
    const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
      const GB = 2 ** 30, worker = { id: 'n_1', name: 'vps-2', local: false, status: 'online', connected: true, enabled: true, draining: false,
        maxSlots: null, inventory: { cores: 4, agents: [] }, resources: { memAvailable: 4 * GB, at: Date.now() } };
      let version = 1;
      const o = createOrchestrator({ query: () => (async function* () {})(), dataDir: process.argv[1], disabled: true, claudeEnv: {}, getLimits: () => [],
        onSubscription: () => false, broadcast() {}, emitChat() {}, convoExists: () => false });
      o.attachCluster({ listNodes: () => [{ id: 'controller', local: true, status: 'online', connected: true, enabled: true }, { ...worker }],
        onMessage() {}, version: () => version });
      const auto = o.stateView().capacity.workers;
      worker.draining = true; version++;
      console.log(JSON.stringify({ auto, drained: o.stateView().capacity.workers }));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir], { encoding: 'utf8', timeout: 30000 });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    // Auto: min(4 cores, (4 GB free − the 800 MB floor) / 1.2 GB per Claude run) = 2.
    assert.equal(r.auto, 2);
    assert.equal(r.drained, 0, 'the drain is seen by the next read');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
