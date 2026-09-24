// Project memory moved from .ao2/ to .agent-orch/; the orchestrator migrates old projects on init.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { migrateMemDir } from '../orchestrator.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cw-memdir-'));

// createOrchestrator starts timers, so drive initMemory/readMemory in a child process that exits.
test('initMemory moves .ao2/ to .agent-orch/', () => {
  const dataDir = tmp(), proj = tmp();
  try {
    fs.mkdirSync(path.join(proj, '.ao2'));
    fs.writeFileSync(path.join(proj, '.ao2', 'BRIEF.md'), '# My brief\n');
    const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
      const o = createOrchestrator({ dataDir: process.argv[1], claudeEnv: {}, getLimits: () => ({}), broadcast() {}, emitChat() {}, convoExists: () => false });
      o.initMemory(process.argv[2]); o.initMemory(process.argv[2]);
      console.log(JSON.stringify(o.readMemory(process.argv[2]))); process.exit(0);`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script, dataDir, proj], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(JSON.parse(out.trim().split('\n').pop()).brief, '# My brief\n');
    assert.equal(fs.existsSync(path.join(proj, '.ao2')), false);
    assert.equal(fs.readFileSync(path.join(proj, '.agent-orch', 'BRIEF.md'), 'utf8'), '# My brief\n');
    assert.ok(fs.existsSync(path.join(proj, '.agent-orch', 'CONTEXT.md')));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('migrateMemDir merges a .ao2/ recreated by an old server', () => {
  const proj = tmp();
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(proj, f)), { recursive: true }); fs.writeFileSync(path.join(proj, f), s); };
  const r = (f) => fs.readFileSync(path.join(proj, f), 'utf8');
  try {
    assert.equal(migrateMemDir(proj), false);
    w('.agent-orch/BRIEF.md', 'real brief');
    w('.agent-orch/JOURNAL.md', '# Journal\n\n## a\n');
    w('.agent-orch/tasks/0001-x.md', 'spec\n');
    w('.ao2/BRIEF.md', '# Project Brief\n\n_Maintained by the orchestrator\'s planner from conversations with the owner._\n\n## Vision\n\n(not yet defined)\n\n## Goals\n\n## Constraints & Preferences\n\n## Definition of Done\n');
    w('.ao2/JOURNAL.md', '# Journal\n\n_Append-only._\n\n## b\n');
    w('.ao2/tasks/0001-x.md', 'spec\nresult\n');
    w('.ao2/tasks/0002-y.md', 'new');
    assert.equal(migrateMemDir(proj), true);
    assert.equal(fs.existsSync(path.join(proj, '.ao2')), false);
    assert.equal(r('.agent-orch/BRIEF.md'), 'real brief');
    assert.equal(r('.agent-orch/JOURNAL.md'), '# Journal\n\n## a\n\n## b\n');
    assert.equal(r('.agent-orch/tasks/0001-x.md'), 'spec\nresult\n');
    assert.equal(r('.agent-orch/tasks/0002-y.md'), 'new');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
