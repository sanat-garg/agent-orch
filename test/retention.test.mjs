import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gcRetention } from '../retention.mjs';

const DAY = 86400e3;
const hex = (c) => c.repeat(64);

test('gcRetention prunes old finished run logs and old unreferenced media only', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
  const runsDir = path.join(dataDir, 'orchestrator', 'runs'), mediaDir = path.join(dataDir, 'media'), logsDir = path.join(dataDir, 'logs');
  for (const d of [runsDir, mediaDir, logsDir]) fs.mkdirSync(d, { recursive: true });
  const now = Date.now(), ago = (days) => new Date(now - days * DAY);
  const put = (f, body, days) => { fs.writeFileSync(f, body); fs.utimesSync(f, ago(days), ago(days)); };

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE tasks(id INTEGER PRIMARY KEY, status TEXT, finished_at REAL);
    CREATE TABLE runs(id INTEGER PRIMARY KEY, task_id INTEGER, finished_at REAL, log_path TEXT);`);
  const s = (days) => (now - days * DAY) / 1000;
  db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(1, 'done', s(40));      // old, finished
  db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(2, 'done', s(2));       // recent
  db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(3, 'queued', null);     // requeued: its old run stays
  db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(1, 1, s(40), null);
  db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(2, 2, s(2), null);
  db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(3, 3, s(50), null);

  const refOld = `${hex('a')}.png`, unrefOld = `${hex('b')}.png`, unrefNew = `${hex('c')}.jpg`, refByDeadRun = `${hex('d')}.png`;
  put(path.join(runsDir, 'run-000001.jsonl'), `{"k":"image","id":"${refByDeadRun}"}\n`, 40);
  put(path.join(runsDir, 'run-000002.jsonl'), '{"k":"text","text":"hi"}\n', 2);
  put(path.join(runsDir, 'run-000003.jsonl'), '{"k":"text","text":"old but live"}\n', 50);
  put(path.join(logsDir, 'chat.jsonl'), `{"t":"image","id":"${refOld}","name":"x"}\n`, 20);
  for (const [name, days] of [[refOld, 20], [unrefOld, 20], [unrefNew, 1], [refByDeadRun, 20]]) put(path.join(mediaDir, name), 'img', days);

  const r = gcRetention({ dataDir, runsDir, db, now });
  assert.deepEqual(fs.readdirSync(runsDir).sort(), ['run-000002.jsonl', 'run-000003.jsonl']);
  assert.deepEqual(fs.readdirSync(mediaDir).sort(), [refOld, unrefNew].sort());
  assert.equal(r.runs, 1);
  assert.equal(r.media, 2); // the unreferenced one and the one only the deleted run log referenced
  assert.ok(r.bytes > 0);

  assert.deepEqual(gcRetention({ dataDir, runsDir, db, now }), { runs: 0, media: 0, bytes: 0 });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('gcRetention falls back to mtimes without a DB and tolerates missing dirs', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
  assert.deepEqual(gcRetention({ dataDir }), { runs: 0, media: 0, bytes: 0 });
  const runsDir = path.join(dataDir, 'orchestrator', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const old = new Date(Date.now() - 40 * DAY);
  for (const f of ['run-000007.jsonl', 'notes.txt']) { fs.writeFileSync(path.join(runsDir, f), 'x'); fs.utimesSync(path.join(runsDir, f), old, old); }
  fs.writeFileSync(path.join(runsDir, 'run-000008.jsonl'), 'x');
  assert.equal(gcRetention({ dataDir }).runs, 1);
  assert.deepEqual(fs.readdirSync(runsDir).sort(), ['notes.txt', 'run-000008.jsonl']);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
