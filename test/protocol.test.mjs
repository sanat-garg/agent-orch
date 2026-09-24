// Protocol parsing (tasks fence, status line) and the ao2.db → agent-orch.db migration; both old and new names must work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseStatus, extractTasks, stripTasksBlock, migrateDbFile } from '../orchestrator.mjs';

const block = (fence) => `Plan below.\n\n\`\`\`${fence}\n{"tasks": [{"title": "Do it", "prompt": "Do the thing"}]}\n\`\`\`\n`;

for (const fence of ['agent-orch-tasks', 'ao2-tasks']) {
  test(`extractTasks parses the ${fence} fence`, () => {
    const [clean, payload] = extractTasks(block(fence));
    assert.equal(clean, 'Plan below.');
    assert.equal(payload.tasks.length, 1);
    assert.equal(payload.tasks[0].title, 'Do it');
    assert.equal(stripTasksBlock(`Hi\n\`\`\`${fence}\n{"tasks": [`), 'Hi');
  });
}

for (const marker of ['AGENT-ORCH-STATUS', 'AO2-STATUS']) {
  test(`parseStatus parses ${marker}`, () => {
    assert.deepEqual(parseStatus(`work\n${marker}: continue — tests remain`), ['continue', 'tests remain']);
    assert.deepEqual(parseStatus(`${marker}: done — all green`), ['done', 'all green']);
  });
}

test('migrateDbFile renames ao2.db and its WAL/SHM files once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-migrate-'));
  try {
    for (const f of ['ao2.db', 'ao2.db-wal', 'ao2.db-shm']) fs.writeFileSync(path.join(dir, f), f);
    assert.equal(migrateDbFile(dir), true);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['agent-orch.db', 'agent-orch.db-shm', 'agent-orch.db-wal']);
    assert.equal(fs.readFileSync(path.join(dir, 'agent-orch.db-wal'), 'utf8'), 'ao2.db-wal');
    // An existing agent-orch.db wins: a stray ao2.db is left alone.
    fs.writeFileSync(path.join(dir, 'ao2.db'), 'old');
    assert.equal(migrateDbFile(dir), false);
    assert.equal(fs.readFileSync(path.join(dir, 'agent-orch.db'), 'utf8'), 'ao2.db');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
