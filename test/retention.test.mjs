import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gcRetention } from '../retention.mjs';
import { saveMedia, setStar } from '../media.mjs';

const DAY = 86400e3;
const hex = (c) => c.repeat(64);

test('gcRetention prunes old finished run logs, and screenshots older than 3 days even when a chat shows them', () => {
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
  assert.deepEqual(fs.readdirSync(mediaDir), [unrefNew]); // a chat's reference no longer keeps a screenshot
  assert.equal(r.runs, 1);
  assert.equal(r.media, 3);
  assert.ok(r.bytes > 0);

  assert.deepEqual(gcRetention({ dataDir, runsDir, db, now }), { runs: 0, media: 0, shots: 0, uploads: 0, browserTasks: 0, bytes: 0 });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('gcRetention falls back to mtimes without a DB and tolerates missing dirs', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
  assert.deepEqual(gcRetention({ dataDir }), { runs: 0, media: 0, shots: 0, uploads: 0, browserTasks: 0, bytes: 0 });
  const runsDir = path.join(dataDir, 'orchestrator', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const old = new Date(Date.now() - 40 * DAY);
  for (const f of ['run-000007.jsonl', 'notes.txt']) { fs.writeFileSync(path.join(runsDir, f), 'x'); fs.utimesSync(path.join(runsDir, f), old, old); }
  fs.writeFileSync(path.join(runsDir, 'run-000008.jsonl'), 'x');
  assert.equal(gcRetention({ dataDir }).runs, 1);
  assert.deepEqual(fs.readdirSync(runsDir).sort(), ['notes.txt', 'run-000008.jsonl']);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('gcRetention keeps pending approvals\' screenshots and surviving uploads\' images, and prunes stale uploads', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
  const mediaDir = path.join(dataDir, 'media'), auditDir = path.join(dataDir, 'audit'), logsDir = path.join(dataDir, 'logs'), uploadsDir = path.join(dataDir, 'uploads');
  for (const d of [mediaDir, auditDir, logsDir, uploadsDir]) fs.mkdirSync(d, { recursive: true });
  const now = Date.now(), ago = (days) => new Date(now - days * DAY);
  const put = (f, body, days) => { fs.writeFileSync(f, body); fs.utimesSync(f, ago(days), ago(days)); };

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE tasks(id INTEGER PRIMARY KEY, status TEXT, finished_at REAL, result TEXT);
    CREATE TABLE runs(id INTEGER PRIMARY KEY, task_id INTEGER, finished_at REAL, log_path TEXT);
    CREATE TABLE approvals(id TEXT PRIMARY KEY, task_id INTEGER, screenshot TEXT, status TEXT);`);
  const byAudit = `${hex('1')}.png`, byApproval = `${hex('2')}.png`, byResult = `${hex('3')}.png`, unref = `${hex('4')}.png`;
  const decided = `${hex('8')}.png`, upImage = `${hex('9')}.png`, staleImage = `${hex('0')}.png`;
  put(path.join(auditDir, '12.jsonl'), `{"tool":"click","screenshot":"${byAudit}"}\n`, 8);
  db.prepare('INSERT INTO approvals VALUES(?,?,?,?)').run('a1', 12, byApproval, 'pending');
  db.prepare('INSERT INTO approvals VALUES(?,?,?,?)').run('a2', 12, decided, 'approved');
  db.prepare('INSERT INTO tasks VALUES(?,?,?,?)').run(12, 'review', null, JSON.stringify({ shots: [byResult] }));
  for (const name of [byAudit, byApproval, byResult, unref, decided, upImage, staleImage]) put(path.join(mediaDir, name), 'img', 8);

  const upStale = '5'.repeat(24), upRef = '6'.repeat(24), upNew = '7'.repeat(24);
  for (const [id, days] of [[upStale, 8], [upRef, 8], [upNew, 1]]) {
    fs.mkdirSync(path.join(uploadsDir, id));
    fs.writeFileSync(path.join(uploadsDir, id, 'a.txt'), 'hello');
    const image = { [upRef]: upImage, [upStale]: staleImage }[id];
    fs.writeFileSync(path.join(uploadsDir, id, 'meta.json'), JSON.stringify({ id, name: 'a.txt', size: 5, at: now - days * DAY, ...(image && { image: { id: image } }) }));
  }
  put(path.join(logsDir, 'chat.jsonl'), `{"t":"user","attachments":[{"id":"${upRef}","name":"a.txt"}]}\n`, 8);

  const r = gcRetention({ dataDir, db, now });
  assert.deepEqual(fs.readdirSync(mediaDir).sort(), [byApproval, upImage].sort()); // audit logs and task results no longer keep one
  assert.deepEqual(fs.readdirSync(uploadsDir).sort(), [upRef, upNew].sort());
  assert.equal(r.media, 5);
  assert.equal(r.uploads, 1);
  assert.ok(r.bytes >= 3 + 5);

  // An old DB without the approvals table still runs; the approval shot then has no reference.
  const oldDb = new DatabaseSync(':memory:');
  oldDb.exec('CREATE TABLE tasks(id INTEGER PRIMARY KEY, status TEXT, finished_at REAL); CREATE TABLE runs(id INTEGER PRIMARY KEY, task_id INTEGER, finished_at REAL);');
  assert.equal(gcRetention({ dataDir, db: oldDb, now }).media, 1);
  assert.deepEqual(fs.readdirSync(mediaDir), [upImage]);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('gcRetention sweeps finished and orphaned screen-prompt workspaces under browser-tasks/', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
  const browserDir = path.join(dataDir, 'orchestrator', 'browser-tasks');
  const now = Date.now(), ago = (days) => new Date(now - days * DAY);
  const workspace = (name, days = 0) => {
    const shots = path.join(browserDir, name, '.agent-orch', 'shots');
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, 'a.png'), 'png-bytes'); // 9 bytes
    for (const d of [shots, path.join(browserDir, name)]) fs.utimesSync(d, ago(days), ago(days));
  };

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE tasks(id INTEGER PRIMARY KEY, status TEXT, finished_at REAL);
    CREATE TABLE runs(id INTEGER PRIMARY KEY, task_id INTEGER, finished_at REAL);`);
  const statuses = { 21: 'done', 22: 'failed', 23: 'cancelled', 24: 'running', 25: 'queued', 26: 'awaiting_review', 27: 'needs_integration', 28: 'paused' };
  for (const [id, status] of Object.entries(statuses)) db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(Number(id), status, now / 1000);
  for (const id of [...Object.keys(statuses), '99']) workspace(id); // 99 has no row
  workspace('scratch');
  workspace('12a');

  const r = gcRetention({ dataDir, db, now });
  assert.deepEqual(fs.readdirSync(browserDir).sort(), ['12a', '24', '25', '26', '27', '28', 'scratch']);
  assert.deepEqual(r, { runs: 0, media: 0, shots: 0, uploads: 0, browserTasks: 4, bytes: 4 * 9 });
  assert.equal(gcRetention({ dataDir, db, now }).browserTasks, 0);

  // Without a DB only workspaces older than runDays go, whatever their task's state.
  fs.rmSync(browserDir, { recursive: true });
  workspace('31', 40);
  workspace('32', 2);
  workspace('old', 40);
  const r2 = gcRetention({ dataDir, now });
  assert.equal(r2.browserTasks, 1);
  assert.equal(r2.bytes, 9);
  assert.deepEqual(fs.readdirSync(browserDir).sort(), ['32', 'old']);

  // An explicit browserDir is honoured.
  const other = path.join(dataDir, 'elsewhere');
  fs.mkdirSync(path.join(other, '21'), { recursive: true });
  assert.equal(gcRetention({ dataDir, db, now, browserDir: other }).browserTasks, 1);
  assert.deepEqual(fs.readdirSync(other), []);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('gcRetention deletes project screenshots older than 3 days unless starred or used by a webpage', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-project-'));
  const mediaDir = path.join(dataDir, 'media'), shots = path.join(project, '.agent-orch', 'shots');
  for (const d of [mediaDir, path.join(shots, 'sub'), path.join(project, 'docs'), path.join(project, 'node_modules', 'x')]) fs.mkdirSync(d, { recursive: true });
  const now = Date.now(), ago = (days) => new Date(now - days * DAY);
  const put = (f, body, days) => { fs.writeFileSync(f, body); fs.utimesSync(f, ago(days), ago(days)); };
  const sha = (body) => crypto.createHash('sha256').update(body).digest('hex');

  // Media: starred, used by a page (by id), and recent stay; an old one a chat shows goes.
  const starred = `${hex('a')}.png`, onPage = `${hex('b')}.png`, recent = `${hex('c')}.png`, old = `${hex('d')}.png`, inDeps = `${hex('e')}.png`;
  for (const [name, days] of [[starred, 9], [onPage, 9], [recent, 2], [old, 4], [inDeps, 9]]) put(path.join(mediaDir, name), 'img', days);
  fs.writeFileSync(path.join(project, 'index.html'), `<img src="/api/media/${onPage}"> <img src="hero-final.png">`);
  fs.writeFileSync(path.join(project, 'node_modules', 'x', 'a.js'), `"${inDeps}"`); // not the project's own page
  fs.writeFileSync(path.join(project, 'docs', 'README.md'), '![](../.agent-orch/shots/sub/readme-shot.png)');
  fs.writeFileSync(path.join(project, 'app.py'), 'old-shot.png'); // not a web file
  fs.mkdirSync(path.join(project, 'tests', 'e2e'), { recursive: true });
  fs.writeFileSync(path.join(project, 'tests', 'e2e', 'shoot.mjs'), 'shot("old-shot.png")'); // the script that took it
  fs.writeFileSync(path.join(project, 'home.spec.ts'), 'old-shot.png');
  fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules/\n');

  // Shot files: by name in a web file, starred by content, recent, old.
  put(path.join(shots, 'hero-final.png'), 'a', 9);
  put(path.join(shots, 'sub', 'readme-shot.png'), 'b', 9);
  put(path.join(shots, 'starred-shot.png'), 'starred bytes', 9);
  put(path.join(shots, 'new.png'), 'c', 1);
  put(path.join(shots, 'old-shot.png'), 'dd', 9);
  put(path.join(shots, 'notes.txt'), 'x', 9); // not an image

  // No git repo here: the walk fallback finds the web files.
  const stars = new Set([starred, `${sha('starred bytes')}.png`]);
  const r = gcRetention({ dataDir, now, projectDirs: [project, project], stars });
  assert.deepEqual(fs.readdirSync(mediaDir).sort(), [starred, onPage, recent].sort());
  assert.deepEqual(fs.readdirSync(shots, { recursive: true }).sort(), ['hero-final.png', 'new.png', 'notes.txt', 'starred-shot.png', 'sub', 'sub/readme-shot.png']);
  assert.equal(r.media, 2);
  assert.equal(r.shots, 1);
  assert.equal(r.bytes, 3 + 3 + 2);

  // In a git repo, ignored files (node_modules) are not pages either, and untracked new pages are.
  execFileSync('git', ['init', '-q', project]);
  fs.writeFileSync(path.join(project, 'new-page.html'), '<img src="starred-shot.png">');
  const r2 = gcRetention({ dataDir, now, projectDirs: [project], stars: new Set() });
  assert.equal(r2.shots, 0);
  assert.equal(r2.media, 1); // the unstarred one
  assert.deepEqual(fs.readdirSync(mediaDir).sort(), [onPage, recent].sort());

  // The default stars come from <DATA>/media-stars.json.
  setStar(dataDir, onPage, true);
  fs.writeFileSync(path.join(project, 'index.html'), '');
  assert.equal(gcRetention({ dataDir, now, projectDirs: [project] }).media, 0);
  setStar(dataDir, onPage, false);
  assert.equal(gcRetention({ dataDir, now, projectDirs: [project] }).media, 1);
  for (const d of [dataDir, project]) fs.rmSync(d, { recursive: true, force: true });
});

test('saveMedia restarts an existing screenshot\'s clock', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');
  const { id } = saveMedia(dataDir, png, 'a.png');
  const f = path.join(dataDir, 'media', id), old = new Date(Date.now() - 9 * DAY);
  fs.utimesSync(f, old, old);
  saveMedia(dataDir, png, 'again.png');
  assert.ok(Date.now() - fs.statSync(f).mtimeMs < DAY);
  assert.equal(gcRetention({ dataDir }).media, 0);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
