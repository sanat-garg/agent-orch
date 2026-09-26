// #146: a codex limit recorded without a reset time is settled at startup from the newest rollout snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { usageHistory, readRecords } from '../usage.mjs';

const fixture = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));

// Boots createOrchestrator in a child process on a data dir whose usage log already holds a codex hit with
// resetsAt null, and HOME/.codex/sessions holding `rollout` (text). Returns the usage records, kv and events.
async function boot(rollout) {
  const dirs = ['cw-cl-', 'cw-cl-home-'].map((p) => fs.mkdtempSync(path.join(os.tmpdir(), p)));
  const [dataDir, home] = dirs;
  try {
    fs.mkdirSync(path.join(dataDir, 'metrics'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'metrics', 'usage.jsonl'), JSON.stringify({ t: Date.now() - 60e3, agent: 'codex', kind: 'limit', status: 'hit', resetsAt: null }) + '\n');
    const day = path.join(home, '.codex', 'sessions', '2026', '09', '25');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, 'rollout-2026-09-25T20-51-03-01a0da55-fd33-72e3-bed4-8f315516d2aa.jsonl'), rollout);
    const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
      import { DatabaseSync } from 'node:sqlite';
      import path from 'node:path';
      const [dataDir] = process.argv.slice(1);
      const o = createOrchestrator({ query: () => (async function* () {})(), dataDir, claudeEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, getLimits: () => [], onSubscription: () => true,
        broadcast() {}, emitChat() {}, convoExists: () => true });
      const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
      const kv = Object.fromEntries(db.prepare("SELECT key, value FROM kv WHERE key LIKE '%:codex'").all().map((r) => [r.key, r.value]));
      console.log(JSON.stringify({ kv, blocks: o.stateView().blocks, events: db.prepare('SELECT message FROM events').all().map((e) => e.message), again: o.reconcileCodexLimit() }));
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir], { encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: home, CW_CODEX_HOME: '' } });
    return { ...JSON.parse(stdout.trim().split('\n').pop()), records: readRecords(path.join(dataDir, 'metrics', 'usage.jsonl')) };
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
}

test('startup clears a codex hit with no reset time when the latest snapshot has headroom', { timeout: 60000 }, async () => {
  // codex-rollout.jsonl: 5h 0%, weekly 17% (recorded from a real rollout).
  const r = await boot(fs.readFileSync(fixture('codex-rollout.jsonl'), 'utf8').replace('__NOW__', new Date().toISOString()));
  const last = r.records.filter((x) => x.kind === 'limit').at(-1);
  assert.equal(last.status, 'cleared');
  assert.equal(usageHistory(r.records, '6h').agents.codex.status.blocked, false);
  assert.ok(r.events.some((m) => /^Cleared a Codex usage limit with no reset time: its latest snapshot shows 5h 0%, weekly 17%/.test(m)), JSON.stringify(r.events));
  assert.equal(r.blocks.codex, undefined);
  assert.equal(r.again, null); // settled: nothing left to reconcile
});

test('startup confirms a real codex hit and takes its reset from the rollout', { timeout: 60000 }, async () => {
  // The recorded real limit, with its 'try again at' moved into the future so the block is still current.
  const text = fs.readFileSync(fixture('codex-rollout-real-limit.jsonl'), 'utf8').replace('Sep 26th, 2026 1:20 AM', 'Sep 26th, 2099 1:20 AM');
  const r = await boot(text);
  const reset = Math.floor(new Date(2099, 8, 26, 1, 20).getTime() / 1000);
  const last = r.records.filter((x) => x.kind === 'limit').at(-1);
  assert.deepEqual([last.status, last.resetsAt, last.window], ['hit', reset, '5h']);
  const status = usageHistory(r.records, '6h').agents.codex.status;
  assert.equal(status.blocked, true);
  assert.equal(status.resetsAt, reset);
  assert.equal(r.kv['blocked_known:codex'], '1');
  assert.equal(r.kv['blocked_reason:codex'], '5h');
  assert.ok(r.blocks.codex.known && r.blocks.codex.until >= reset);
  assert.equal(r.again, null);
});
