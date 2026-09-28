// One-time kv migration (removed_agents_kv_migrated): boot drops kv rows left by the agents removed in goal 10
// (antigravity, opencode, kiro, copilot) and keeps everything else. Boots createOrchestrator in a child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('boot drops kv rows of removed agents once and keeps the rest', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-kvm-'));
  try {
    const dbFile = path.join(dataDir, 'orchestrator', 'agent-orch.db');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const gone = ['planner_session:2:antigravity', 'unknown_limit_streak:antigravity', 'unknown_limit_streak:antigravity:3p',
      'unknown_limit_streak:copilot', 'planner_session:5:opencode', 'unknown_limit_streak:kiro:3p'];
    const kept = ['planner_session:2:claude', 'unknown_limit_streak:codex', 'copilot_note', 'planner_session:3:kirowatch'];
    let db = new DatabaseSync(dbFile);
    db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
    for (const k of [...gone, ...kept]) db.prepare('INSERT INTO kv(key,value) VALUES(?,?)').run(k, 'x');
    db.close();
    const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
    const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
      createOrchestrator({ query: () => (async function* () {})(), dataDir: process.argv[1], disabled: true, claudeEnv: {}, getLimits: () => [],
        onSubscription: () => false, broadcast() {}, emitChat() {}, convoExists: () => false });
      process.exit(0);`;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir], { encoding: 'utf8', timeout: 30000 });
    db = new DatabaseSync(dbFile);
    const keys = new Set(db.prepare('SELECT key FROM kv').all().map((r) => r.key));
    db.close();
    for (const k of gone) assert.ok(!keys.has(k), `${k} is dropped`);
    for (const k of kept) assert.ok(keys.has(k), `${k} is kept`);
    assert.ok(keys.has('removed_agents_kv_migrated'), 'the guard is set');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
