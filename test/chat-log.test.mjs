// chat-log.mjs: a chat opens with only its recent events (logWindow), older windows page back to the start, long tool
// input/output is clipped (clipEvent) and toolEvents serves a clipped call whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logWindow, logSince, clipEvent, toolEvents, HISTORY_WINDOW, CLIP_CHARS, LOG_CHUNK } from '../chat-log.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-chatlog-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name, events, extra = '') => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, events.map((e) => JSON.stringify(e)).join('\n') + '\n' + extra);
  return f;
};
// Every window from the end back to byte 0, oldest first.
function pageAll(f) {
  const all = [], starts = [];
  let before = Infinity;
  do {
    const w = logWindow(f, before);
    assert.ok(w.events.length, `a window before ${before} has events`);
    all.unshift(...w.events);
    starts.push(w.start);
    before = w.start;
  } while (before > 0);
  return { all, starts };
}

test('a short chat comes whole; a missing log is empty', () => {
  const evs = [{ t: 'user', text: 'hi', ts: 1 }, { t: 'text', text: 'hello ✓ ünïcode' }];
  const f = write('short.jsonl', evs);
  assert.deepEqual(logWindow(f), { events: evs, start: 0, end: fs.statSync(f).size });
  assert.deepEqual(logWindow(path.join(dir, 'nope.jsonl')), { events: [], start: 0, end: 0 });
});

test('a long chat opens at a prompt with about HISTORY_WINDOW events, and paging back rebuilds it exactly', () => {
  // Turns of 37 events; long multibyte results so lines straddle the read chunks; a blank and a broken line are skipped.
  const evs = [];
  for (let turn = 0; evs.length < 6 * HISTORY_WINDOW; turn++) {
    evs.push({ t: 'user', text: `prompt ${turn} — ✓`, ts: turn + 1 });
    for (let k = 0; k < 18; k++) {
      evs.push({ t: 'tool_use', id: `toolu_${turn}_${k}`, name: 'Bash', input: { command: `echo ${k}` } });
      evs.push({ t: 'tool_result', id: `toolu_${turn}_${k}`, text: (k === 5 ? 'é'.repeat(LOG_CHUNK / 3) : `out ${k} ✓`) });
    }
  }
  const f = path.join(dir, 'long.jsonl');
  fs.writeFileSync(f, evs.slice(0, 40).map((e) => JSON.stringify(e)).join('\n') + '\n\nnot json\n' + evs.slice(40).map((e) => JSON.stringify(e)).join('\n') + '\n');
  const w = logWindow(f);
  assert.equal(w.events[0].t, 'user', 'the window begins at a prompt');
  assert.ok(w.events.length >= HISTORY_WINDOW && w.events.length <= 2 * HISTORY_WINDOW, `${w.events.length} events`);
  assert.deepEqual(w.events, evs.slice(-w.events.length).map(clipEvent));
  assert.ok(w.start > 0 && fs.readFileSync(f).subarray(w.start).toString().startsWith('{"t":"user"'), 'start is the prompt line\'s byte offset');
  const { all, starts } = pageAll(f);
  assert.deepEqual(all, evs.map(clipEvent));
  assert.ok(starts.length > 3);
  assert.deepEqual(logWindow(f, 0), { events: [], start: 0, end: 0 }, 'nothing before byte 0');
});

test('a turn longer than twice the window is cut there rather than sent whole', () => {
  const evs = [{ t: 'user', text: 'go', ts: 1 }, ...Array.from({ length: 3 * HISTORY_WINDOW }, (_, i) => ({ t: 'text', text: `step ${i}` }))];
  const f = write('one-turn.jsonl', evs);
  const w = logWindow(f);
  assert.equal(w.events.length, 2 * HISTORY_WINDOW);
  assert.deepEqual(w.events, evs.slice(-2 * HISTORY_WINDOW));
  assert.deepEqual(pageAll(f).all, evs);
});

test('long tool output and input are clipped and marked; toolEvents has them whole', () => {
  const long = 'x'.repeat(CLIP_CHARS + 1234);
  const use = { t: 'tool_use', id: 'toolu_big', name: 'Write', input: { file_path: '/a', content: long, edits: [{ old_string: long, n: 3 }] } };
  const res = { t: 'tool_result', id: 'toolu_big', text: long };
  const small = { t: 'tool_result', id: 'toolu_small', text: 'ok' };
  const r = clipEvent(res), u = clipEvent(use);
  assert.equal(r.cut, true);
  assert.equal(r.text, `${'x'.repeat(CLIP_CHARS)}\n… 1,234 more characters`);
  assert.equal(u.cut, true);
  assert.equal(u.input.file_path, '/a');
  assert.equal(u.input.content, r.text);
  assert.deepEqual(u.input.edits, [{ old_string: r.text, n: 3 }]);
  assert.equal(clipEvent(small), small, 'short events pass through untouched');
  const f = write('tools.jsonl', [{ t: 'user', text: 'mentions "toolu_big" in passing', ts: 1 }, use, small, res]);
  assert.deepEqual(toolEvents(f, 'toolu_big'), { use, result: res });
  assert.deepEqual(toolEvents(f, 'toolu_none'), { use: null, result: null });
  assert.deepEqual(toolEvents(path.join(dir, 'nope.jsonl'), 'toolu_big'), { use: null, result: null });
});

test('logSince: just the events appended after a byte, clipped; null when the mark is past the end or too much was added', () => {
  const evs = Array.from({ length: 10 }, (_, i) => ({ t: 'text', text: `m${i}` }));
  const f = write('since.jsonl', evs);
  const mark = logWindow(f).end;
  assert.equal(mark, fs.statSync(f).size);
  assert.deepEqual(logSince(f, mark), { events: [], end: mark });
  const big = 'x'.repeat(CLIP_CHARS + 50);
  fs.appendFileSync(f, [{ t: 'user', text: 'new' }, { t: 'tool_result', id: 'a', text: big }].map((e) => JSON.stringify(e) + '\n').join(''));
  const s = logSince(f, mark);
  assert.equal(s.end, fs.statSync(f).size);
  assert.deepEqual(s.events.map((e) => e.t), ['user', 'tool_result']);
  assert.equal(s.events[1].cut, true);
  assert.equal(logSince(f, s.end + 1), null, 'past the end: the log was rewritten shorter');
  assert.equal(logSince(path.join(dir, 'missing.jsonl'), 0), null);
  const many = write('since-many.jsonl', []);
  fs.appendFileSync(many, Array.from({ length: 2 * HISTORY_WINDOW + 1 }, (_, i) => JSON.stringify({ t: 'text', text: `${i}` }) + '\n').join(''));
  assert.equal(logSince(many, 0), null, 'more than a window was added');
});
