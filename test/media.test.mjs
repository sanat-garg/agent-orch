import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENTS } from '../agents.mjs';
import { mediaCollector, saveBase64, saveMedia, sniffImage, toolResultImages, MEDIA_ID_RE, MAX_MEDIA_BYTES } from '../media.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='; // 1x1
const GIF = Buffer.from('R0lGODlhAgADAIAAAP///wAAACwAAAAAAgADAAACAoRRADs=', 'base64'); // 2x3
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));

const toolResult = {
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [
    { type: 'text', text: 'Took a screenshot' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
  ] }] },
};

test('tool-result image blocks become image events after the text result', () => {
  assert.deepEqual(toolResultImages(toolResult.message.content[0].content), [{ mediaType: 'image/png', data: PNG }]);
  assert.deepEqual(toolResultImages('plain text'), []);
  const evs = [...AGENTS.claude.events(toolResult)];
  assert.deepEqual(evs.map((e) => e.k), ['tool_result', 'image']);
  assert.match(evs[0].text, /^Took a screenshot/);
  assert.deepEqual(evs[1], { k: 'image', tool: 'tu1', mediaType: 'image/png', data: PNG });
});

test('images are stored once by hash with their size; non-images and oversize are refused', () => {
  const dir = tmp();
  try {
    const a = saveBase64(dir, PNG, 'screenshot.png');
    assert.match(a.id, MEDIA_ID_RE);
    assert.ok(a.id.endsWith('.png'));
    assert.deepEqual({ w: a.w, h: a.h, name: a.name }, { w: 1, h: 1, name: 'screenshot.png' });
    assert.deepEqual(fs.readFileSync(path.join(dir, 'media', a.id)), Buffer.from(PNG, 'base64'));
    assert.equal(saveBase64(dir, PNG, 'again.png').id, a.id);
    assert.equal(fs.readdirSync(path.join(dir, 'media')).length, 1);
    assert.deepEqual(sniffImage(GIF), { ext: 'gif', w: 2, h: 3 });
    assert.equal(saveMedia(dir, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.equal(saveMedia(dir, Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(MAX_MEDIA_BYTES)])), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the collector picks up new and changed files in .agent-orch/shots/', () => {
  const data = tmp(), cwd = tmp(), shots = path.join(cwd, '.agent-orch', 'shots');
  try {
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, 'old.png'), Buffer.from(PNG, 'base64'));
    const c = mediaCollector(data, cwd);
    assert.deepEqual(c.shots(), []); // present before the run: not new
    fs.writeFileSync(path.join(shots, 'new.gif'), GIF);
    fs.writeFileSync(path.join(shots, 'notes.txt'), 'not an image');
    assert.deepEqual(c.shots().map((e) => [e.name, e.w, e.h]), [['new.gif', 2, 3]]);
    assert.deepEqual(c.shots(), []);
    fs.writeFileSync(path.join(shots, 'old.png'), GIF); // overwritten, so its size changes
    assert.deepEqual(c.shots().map((e) => e.name), ['old.png']);
    assert.equal(c.image({ mediaType: 'image/png', data: PNG }).name, 'screenshot.png');
  } finally { fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); }
});
