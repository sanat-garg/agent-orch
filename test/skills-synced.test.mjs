// Skills synced from the owner's Claude account (~/.claude/skills/synced/<bucket>/[<sub>/]<skill>/SKILL.md): listed with
// source 'synced' next to local ones, dot entries skipped, read-only (no edit, delete or name clash), and left out of
// the extension bundle workers get.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExtensions } from '../extensions.mjs';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const skill = (dir, name, description = `The ${name} skill`) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nDo ${name}\n`);
};
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-synced-'));
  dirs.push(home);
  const root = path.join(home, '.claude/skills'), synced = path.join(root, 'synced');
  skill(path.join(root, 'apple-design'), 'apple-design');
  skill(path.join(synced, 'acct-1234/morning'), 'morning');
  skill(path.join(synced, 'acct-1234/pdf'), 'pdf');
  fs.writeFileSync(path.join(synced, 'acct-1234/pdf/forms.md'), 'forms');
  skill(path.join(synced, 'acct-1234/nested-bucket/docx'), 'docx'); // a bucket folder one level down
  skill(path.join(synced, '.bucket-abc/hidden'), 'hidden');
  skill(path.join(synced, 'acct-1234/.last-complete-round'), 'round');
  fs.writeFileSync(path.join(synced, '.last-complete-round'), '42');
  return { home, x: createExtensions({ dataDir: path.join(home, 'data'), home }) };
}

test('nested synced skills are listed with the synced source; dot entries are ignored', () => {
  const { x } = setup();
  const list = x.listSkills();
  assert.deepEqual(list.map((s) => `${s.folder}:${s.source}`), ['apple-design:local', 'docx:synced', 'morning:synced', 'pdf:synced']);
  const pdf = list.find((s) => s.folder === 'pdf');
  assert.deepEqual([pdf.agents, pdf.readOnly, pdf.files, pdf.path, pdf.description], [['claude'], true, 2, 'synced/acct-1234/pdf', 'The pdf skill']);
  assert.equal(list.find((s) => s.folder === 'docx').path, 'synced/acct-1234/nested-bucket/docx');
  assert.ok(!list.find((s) => s.folder === 'apple-design').readOnly);
  assert.deepEqual(x.list('skills').skills.length, 4);
});

test('synced skills refuse edit and delete, and their names stay taken; local skills stay editable', () => {
  const { home, x } = setup();
  assert.throws(() => x.saveSkill({ prev: 'pdf', name: 'pdf', description: 'd', body: 'b', agents: ['claude'] }), /synced from your Claude account/);
  assert.throws(() => x.removeSkill('morning'), /synced from your Claude account/);
  assert.throws(() => x.saveSkill({ name: 'pdf', description: 'd', body: 'b' }), /already synced from your Claude account/);
  assert.ok(fs.existsSync(path.join(home, '.claude/skills/synced/acct-1234/pdf/SKILL.md')));
  assert.ok(fs.existsSync(path.join(home, '.claude/skills/synced/acct-1234/morning/SKILL.md')));
  const s = x.saveSkill({ prev: 'apple-design', name: 'apple-design', description: 'HIG', body: 'Review', agents: ['claude'] });
  assert.equal(s.description, 'HIG');
  x.removeSkill('apple-design');
  assert.deepEqual(x.listSkills().map((k) => k.folder), ['docx', 'morning', 'pdf']);
});

test('synced skills stay on this machine: the worker bundle holds only local skills', () => {
  const { x } = setup();
  assert.deepEqual(x.syncInfo().skills.map((s) => `${s.agent}/${s.name}`), ['claude/apple-design']);
});
