// A Claude limit ends as soon as a /usage reading taken after the hit shows headroom (a plan upgrade),
// instead of waiting out the old reset time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { usageHeadroom } from '../orchestrator.mjs';

const t = 1_000_000;
const row = (type, u, observed) => ({ limit_type: type, status: u >= 1 ? 'rejected' : 'allowed', utilization: u, resets_at: t + 86400, observed_at: observed });

test('usageHeadroom needs a reading after the hit with every window under 100%', () => {
  assert.equal(usageHeadroom([], t), null);
  assert.equal(usageHeadroom([row('five_hour', 0.01, t - 5), row('seven_day', 0, t - 5)], t), null); // taken before the hit
  assert.equal(usageHeadroom([row('five_hour', 0.2, t + 5), row('seven_day', 1, t + 5)], t), null); // still exhausted
  assert.equal(usageHeadroom([row('five_hour', 1.01, t + 5), row('seven_day', 0.3, t + 5)], t), null); // another window full
  assert.deepEqual(usageHeadroom([row('five_hour', 0.01, t + 5), row('seven_day', 0, t + 5)], t).map((l) => l.limit_type), ['five_hour', 'seven_day']);
});

test('a fresh /usage reading with headroom clears the block; a re-hit right after keeps it until the reset', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-clc-'));
  try {
    const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
      const [dataDir] = process.argv.slice(1);
      const now = () => Date.now() / 1000;
      let limits = [];
      const o = createOrchestrator({ query: () => (async function* () {})(), dataDir, claudeEnv: {}, getLimits: () => limits, onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => true, config: { pollMs: 3600e3 } });
      const read = (u, at = now() + 1) => { limits = [{ limit_type: 'five_hour', status: 'allowed', utilization: 0.01, resets_at: now() + 3600, observed_at: at },
        { limit_type: 'seven_day', status: u >= 1 ? 'rejected' : 'allowed', utilization: u, resets_at: now() + 86400, observed_at: at }]; };
      const out = {};
      read(0, now() - 60); // taken before the hit
      o.recordLimit({ outcome: 'rate_limited', resetsAt: now() + 86400, limitType: 'seven_day' });
      out.stale = [o.reconcileClaudeLimit(), !!o.stateView().blockedUntil];
      read(1);
      out.full = [o.reconcileClaudeLimit(), !!o.stateView().blockedUntil];
      read(0);
      out.upgraded = [o.reconcileClaudeLimit(), !!o.stateView().blockedUntil];
      o.recordLimit({ outcome: 'rate_limited', resetsAt: now() + 86400, limitType: 'seven_day' });
      read(0, now() + 120);
      out.rehit = [o.reconcileClaudeLimit(), !!o.stateView().blockedUntil];
      console.log(JSON.stringify(out));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir], { encoding: 'utf8', timeout: 60000 });
    const r = JSON.parse(stdout.trim().split('\n').pop());
    assert.deepEqual(r.stale, [false, true]);
    assert.deepEqual(r.full, [false, true]);
    assert.deepEqual(r.upgraded, [true, false]);
    assert.deepEqual(r.rehit, [false, true]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
