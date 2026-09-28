// Adding a skill (extensions.mjs previewSkill → installSkill): a .zip/.skill upload or a GitHub link (fetch mocked) is
// staged, checked for SKILL.md name/description frontmatter, previewed (name, description, files), then installed and listed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createExtensions, readZip, parseRawGitHubUrl } from '../extensions.mjs';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const setup = (opts = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-import-'));
  dirs.push(home);
  return { home, x: createExtensions({ dataDir: path.join(home, 'data'), home, ...opts }) };
};
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const stages = (home) => { try { return fs.readdirSync(path.join(home, 'data/extensions/tmp')); } catch { return []; } };
const SKILL = (name, description = `The ${name} skill`) => `---\nname: ${name}\ndescription: ${description}\n---\nDo ${name}\n`;

// A zip: entries {name, data, mode?, deflate?} (mode 0o120777 = a symlink).
function zip(entries) {
  const locals = [], central = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), raw = Buffer.from(e.data ?? ''), body = e.deflate ? zlib.deflateRawSync(raw) : raw;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(e.deflate ? 8 : 0, 8);
    l.writeUInt32LE(zlib.crc32(raw), 14); l.writeUInt32LE(body.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x031e, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(e.deflate ? 8 : 0, 10);
    c.writeUInt32LE(zlib.crc32(raw), 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((e.mode ?? (e.name.endsWith('/') ? 0o40755 : 0o100644)) << 16) >>> 0, 38); c.writeUInt32LE(off, 42);
    locals.push(l, name, body);
    central.push(c, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('a .zip (or .skill) upload: previewed, then installed for each agent and listed', async () => {
  const { home, x } = setup();
  const buf = zip([
    { name: 'notes/' },
    { name: 'notes/SKILL.md', data: SKILL('notes', 'Use when: writing notes'), deflate: true },
    { name: 'notes/scripts/run.sh', data: '#!/bin/sh\necho hi\n', mode: 0o100755 },
    { name: 'notes/leak', data: '/etc/passwd', mode: 0o120777 },
    { name: '__MACOSX/notes/._SKILL.md', data: 'junk' },
    { name: 'notes/.DS_Store', data: 'junk' },
  ]);
  assert.equal(readZip(buf).length, 6);
  const p = await x.previewSkill({ zip: buf });
  assert.match(p.id, /^[0-9a-f]{16}$/);
  assert.deepEqual([p.folder, p.name, p.description, p.files, p.exists], ['notes', 'notes', 'Use when: writing notes', ['SKILL.md', 'scripts/run.sh'], null]);
  assert.deepEqual(x.listSkills(), [], 'a preview installs nothing');
  const s = x.installSkill({ id: p.id, agents: ['claude', 'codex'] });
  assert.deepEqual([s.folder, s.agents, s.files, s.source], ['notes', ['claude', 'codex'], 2, 'local']);
  assert.equal(read(home, '.codex/skills/notes/scripts/run.sh'), '#!/bin/sh\necho hi\n');
  assert.ok(fs.statSync(path.join(home, '.claude/skills/notes/scripts/run.sh')).mode & 0o100, 'executable bit kept');
  assert.ok(!fs.existsSync(path.join(home, '.claude/skills/notes/leak')), 'symlinks are left out');
  assert.deepEqual(x.listSkills().map((k) => k.folder), ['notes']);
  assert.deepEqual(stages(home), [], 'the stage is cleaned up');
  assert.throws(() => x.installSkill({ id: p.id }), /expired/);

  // Again: it exists, so replacing needs asking; a SKILL.md at the archive root works too.
  const again = await x.previewSkill({ zip: zip([{ name: 'SKILL.md', data: SKILL('notes', 'v2') }]) });
  assert.equal(again.exists, 'local');
  assert.throws(() => x.installSkill({ id: again.id, agents: ['claude'] }), /already exists/);
  assert.deepEqual(x.installSkill({ id: again.id, agents: ['claude'], replace: true }).agents, ['claude']);
  assert.match(read(home, '.claude/skills/notes/SKILL.md'), /description: v2/);
  assert.ok(!fs.existsSync(path.join(home, '.codex/skills/notes')), 'replacing drops the unchosen agent copy');
});

test('uploads are validated: frontmatter, one skill, safe paths, a real zip', async () => {
  const { home, x } = setup();
  await assert.rejects(x.previewSkill({ zip: zip([{ name: 'a/SKILL.md', data: '---\nname: a\n---\nx' }]) }), /name and a description/);
  await assert.rejects(x.previewSkill({ zip: zip([{ name: 'a/SKILL.md', data: 'no frontmatter' }]) }), /name and a description/);
  await assert.rejects(x.previewSkill({ zip: zip([{ name: 'a/SKILL.md', data: SKILL('a') }, { name: 'b/SKILL.md', data: SKILL('b') }]) }), /holds 2 skills \(a, b\)\. Upload one/);
  await assert.rejects(x.previewSkill({ zip: zip([{ name: 'README.md', data: 'hi' }]) }), /No SKILL\.md/);
  await assert.rejects(x.previewSkill({ zip: zip([{ name: 'SKILL.md', data: SKILL('a') }, { name: '../evil', data: 'x' }]) }), /unsafe path/);
  await assert.rejects(x.previewSkill({ zip: Buffer.from('not a zip at all, just text') }), /not a readable/);
  assert.deepEqual(stages(home), [], 'failed previews leave nothing behind');
  assert.ok(!fs.existsSync(path.join(home, 'evil')) && !fs.existsSync(path.join(home, 'data/extensions/evil')));
});

// A mocked GitHub: the repo o/skills (default branch main) with skills/pdf (two files) and skills/docx.
function github(calls, { files = {}, fail = false } = {}) {
  const tree = { 'skills/pdf/SKILL.md': SKILL('pdf'), 'skills/pdf/scripts/fill.py': 'print(1)', 'skills/docx/SKILL.md': SKILL('docx'), 'README.md': 'hi', ...files };
  const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new TextEncoder().encode(String(body)).buffer });
  return async (url) => {
    calls.push(url);
    if (fail && url.startsWith('https://api.github.com/')) return res({ message: 'Not Found' }, 404);
    if (url === 'https://api.github.com/repos/o/skills') return res({ default_branch: 'main' });
    if (url === 'https://api.github.com/repos/o/skills/git/trees/main?recursive=1') {
      const dirsIn = new Set(Object.keys(tree).flatMap((p) => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))));
      return res({ truncated: false, tree: [...[...dirsIn].map((p) => ({ path: p, type: 'tree', mode: '040000' })),
        ...Object.entries(tree).map(([p, v]) => ({ path: p, type: 'blob', mode: p.endsWith('.py') ? '100755' : '100644', size: v.length }))] });
    }
    const m = /^https:\/\/raw\.githubusercontent\.com\/o\/skills\/main\/(.+)$/.exec(url);
    if (m && tree[decodeURIComponent(m[1])] != null) return res(tree[decodeURIComponent(m[1])]);
    return res('404: Not Found', 404);
  };
}

test('a GitHub link (fetch mocked): a folder, a repo of several, a raw SKILL.md; installs and lists', async () => {
  const calls = [];
  const { home, x } = setup({ fetch: github(calls), gitBin: '/nonexistent/git' });
  const p = await x.previewSkill({ url: 'https://github.com/o/skills/tree/main/skills/pdf' });
  assert.deepEqual([p.name, p.description, p.files], ['pdf', 'The pdf skill', ['SKILL.md', 'scripts/fill.py']]);
  assert.ok(calls.includes('https://raw.githubusercontent.com/o/skills/main/skills/pdf/scripts/fill.py'));
  assert.ok(!calls.some((u) => u.includes('docx')), 'only the linked folder is downloaded');
  const s = x.installSkill({ id: p.id, agents: ['claude'] });
  assert.deepEqual([s.folder, s.agents, s.files], ['pdf', ['claude'], 2]);
  assert.equal(read(home, '.claude/skills/pdf/scripts/fill.py'), 'print(1)');

  // The repo root holds two skills: the owner is asked to link one.
  await assert.rejects(x.previewSkill({ url: 'https://github.com/o/skills' }), /holds 2 skills \(docx, pdf\)\. Link one/);
  await assert.rejects(x.previewSkill({ url: 'https://github.com/o/skills/tree/main/nope' }), /No folder nope/);
  // A raw SKILL.md link brings its whole folder; importSkill previews and installs in one go.
  const d = await x.importSkill({ url: 'https://raw.githubusercontent.com/o/skills/main/skills/docx/SKILL.md', agents: ['codex'] });
  assert.deepEqual([d.folder, d.agents], ['docx', ['codex']]);
  const b = await x.previewSkill({ url: 'https://github.com/o/skills/blob/main/skills/docx/SKILL.md' });
  assert.equal(b.exists, 'local');
  assert.deepEqual(x.listSkills().map((k) => `${k.folder}:${k.agents}`), ['pdf:claude', 'docx:codex']);
  assert.deepEqual(parseRawGitHubUrl('https://example.com/SKILL.md'), null);
  assert.throws(() => parseRawGitHubUrl('https://raw.githubusercontent.com/o/skills/main/README.md'), /SKILL\.md/);
});

test('a GitHub link whose API fails: a raw SKILL.md falls back to just that file; bad frontmatter is refused', async () => {
  const calls = [];
  const { home, x } = setup({ fetch: github(calls, { fail: true, files: { 'bad/SKILL.md': '---\nname: bad\n---\n' } }) });
  const p = await x.previewSkill({ url: 'https://raw.githubusercontent.com/o/skills/main/skills/pdf/SKILL.md' });
  assert.deepEqual(p.files, ['SKILL.md']);
  x.installSkill({ id: p.id });
  assert.equal(read(home, '.claude/skills/pdf/SKILL.md'), SKILL('pdf'));
  await assert.rejects(x.previewSkill({ url: 'https://raw.githubusercontent.com/o/skills/main/bad/SKILL.md' }), /name and a description/);
  await assert.rejects(x.previewSkill({ url: 'https://gitlab.com/o/skills' }), /Only https:\/\/github\.com/);
  assert.deepEqual(stages(home), []);
});
