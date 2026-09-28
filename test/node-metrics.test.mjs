// Node telemetry (node-metrics.mjs): a frame can't store more than 256 cores, and read() of an oversized file loads only
// its newest 8 MB (AUDIT #42).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_READ, createNodeMetrics, sampleOf } from '../node-metrics.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-metrics-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('sampleOf: a frame with 1000 cpu entries stores 256, each a number in 0..100', () => {
  const m = createNodeMetrics({ dir: path.join(tmp, 'cores') });
  const s = m.record('w1', { cpu: Array.from({ length: 1000 }, (_, i) => i) });
  assert.equal(s.cores.length, 256);
  assert.equal(m.read('w1')[0].cores.length, 256);
  assert.ok(s.cores.every((c) => typeof c === 'number' && c >= 0 && c <= 100));
  assert.deepEqual(sampleOf({ cpu: [-5, 250, 'x', '40', null, 12.34] }, 1).cores, [0, 100, 0, 40, 0, 12.3]);
});

test('read: a file padded past 8 MB still reads its newest samples, and logs once', () => {
  const dir = path.join(tmp, 'big'), logs = [];
  fs.mkdirSync(dir, { recursive: true });
  const m = createNodeMetrics({ dir, log: (l) => logs.push(l) });
  const now = Date.now(), old = JSON.stringify({ t: now - 3600e3, cpu: 1, pad: 'x'.repeat(1000) }) + '\n';
  fs.writeFileSync(m.file('w2'), old.repeat(Math.ceil((MAX_READ + 1e6) / old.length)));
  fs.appendFileSync(m.file('w2'), JSON.stringify({ t: now - 1000, cpu: 42 }) + '\n' + JSON.stringify({ t: now, cpu: 43 }) + '\n');
  assert.ok(fs.statSync(m.file('w2')).size > MAX_READ);
  const rows = m.read('w2');
  assert.deepEqual(rows.slice(-2).map((r) => r.cpu), [42, 43]);
  assert.ok(rows.every((r) => Number.isFinite(r.t)), 'the partial first line is dropped');
  assert.ok(rows.length < MAX_READ / old.length + 3);
  m.read('w2');
  assert.equal(logs.filter((l) => /newest/.test(l)).length, 1);
});
