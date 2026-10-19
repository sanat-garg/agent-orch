// searchConvos: every term must match (title or message text), results come newest hit first with at most perConvo
// hits each, only the newest maxBytes of a log are read (a record cut by that window is dropped), a corrupt line or a
// missing log is skipped, and short queries find nothing.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchConvos } from '../search.mjs';

const line = (ev) => JSON.stringify(ev) + '\n';

function setup() {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-search-'));
  // a: several matching messages, a corrupt line, a tool call and an image that mention the word but must not count.
  fs.writeFileSync(path.join(logsDir, 'a.jsonl'), [
    line({ t: 'user', text: 'Please fix the Banana parser', ts: 1000 }),
    '{"t":"text","text":"banana parser broken\n',
    line({ t: 'tool_use', id: 'x', name: 'Bash', input: { command: 'grep banana parser' }, ts: 1100 }),
    line({ t: 'text', text: 'Looking at the banana parser now. ' + 'filler '.repeat(40) + 'end', ts: 1200 }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'YmFuYW5hIHBhcnNlcg==' } }, { type: 'text', text: 'banana PARSER screenshot' }] }, ts: 1300 }),
    line({ t: 'tool_result', id: 'x', text: 'banana parser.js', ts: 1350 }),
    line({ t: 'text', text: 'The banana parser is fixed.', ts: 1400 }),
    line({ t: 'text', text: 'Only banana here, no second term.', ts: 1500 }),
  ].join(''));
  // big: padded past maxBytes, with a recent match at the very end and an old one at the very start.
  fs.writeFileSync(path.join(logsDir, 'big.jsonl'),
    line({ t: 'text', text: 'kiwi parser from long ago', ts: 5 })
    + Array.from({ length: 200 }, (_, i) => line({ t: 'text', text: 'padding '.repeat(20), ts: 10 + i })).join('')
    + line({ t: 'text', text: 'banana parser deep in the log', ts: 5000 }));
  // title: its title holds "banana", its messages hold "parser" but never "banana".
  fs.writeFileSync(path.join(logsDir, 'title.jsonl'), line({ t: 'user', text: 'write a parser', ts: 3000 }));
  const convos = [
    { id: 'a', title: 'Fruit work', updatedAt: 1500 },
    { id: 'big', title: 'Big one', updatedAt: 5000 },
    { id: 'title', title: 'Banana ideas', updatedAt: 3000 },
    { id: 'titleonly', title: 'Banana Parser plans', updatedAt: 2000 },
    { id: 'missing', title: 'No log here', updatedAt: 9000 },
    { id: 'none', title: 'Unrelated', updatedAt: 100 },
  ];
  fs.writeFileSync(path.join(logsDir, 'none.jsonl'), line({ t: 'user', text: 'nothing to see', ts: 100 }));
  return { logsDir, convos };
}

test('searchConvos matches every term, orders by newest hit and caps hits per chat', async () => {
  const { logsDir, convos } = setup();
  try {
    const res = await searchConvos({ logsDir, convos, q: '  BANANA   parser ', maxBytes: 16 * 1024 });
    // big's match sits past 16 KB but in its newest 16 KB, so it is found and is the newest hit of all.
    assert.deepEqual(res.map((r) => r.id), ['big', 'title', 'titleonly', 'a']);
    const [, title, titleOnly, a] = res;
    // "banana" comes from the title, so a message needs only "parser".
    assert.deepEqual(title.hits, [{ role: 'user', at: 3000, snippet: 'write a parser' }]);
    assert.equal(title.at, 3000);
    // Title-only: no hits, dated by updatedAt.
    assert.deepEqual(titleOnly, { id: 'titleonly', title: 'Banana Parser plans', at: 2000, hits: [] });
    // The newest three hits, newest first; the corrupt line, tool call, tool result and image are skipped.
    assert.equal(a.at, 1400);
    assert.deepEqual(a.hits.map((h) => [h.role, h.at]), [['assistant', 1400], ['user', 1300], ['assistant', 1200]]);
    assert.equal(a.hits[0].snippet, 'The banana parser is fixed.');
    assert.equal(a.hits[1].snippet, 'banana PARSER screenshot');
    assert.ok(a.hits[2].snippet.length <= 122 && /banana parser/.test(a.hits[2].snippet), a.hits[2].snippet);
    assert.ok(!a.hits[2].snippet.startsWith('…') && a.hits[2].snippet.endsWith('…'));

    const one = await searchConvos({ logsDir, convos, q: 'banana parser', perConvo: 1, maxBytes: 16 * 1024 });
    assert.deepEqual(one.find((r) => r.id === 'a').hits.map((h) => h.at), [1400]);
    assert.deepEqual((await searchConvos({ logsDir, convos, q: 'banana parser', limit: 2, maxBytes: 16 * 1024 })).map((r) => r.id), ['big', 'title']);
  } finally { fs.rmSync(logsDir, { recursive: true, force: true }); }
});

test('searchConvos reads at most the newest maxBytes of a log', async () => {
  const { logsDir, convos } = setup();
  const reads = mock.method(fs, 'createReadStream');
  try {
    const size = fs.statSync(path.join(logsDir, 'big.jsonl')).size;
    assert.ok(size > 16 * 1024);
    // The recent match past the first 16 KB is found; the old one before the newest 16 KB is not.
    const capped = await searchConvos({ logsDir, convos, q: 'deep in the log', maxBytes: 16 * 1024 });
    assert.deepEqual(capped.map((r) => [r.id, r.at]), [['big', 5000]]);
    assert.equal(capped[0].hits[0].snippet, 'banana parser deep in the log');
    assert.deepEqual(await searchConvos({ logsDir, convos, q: 'kiwi long ago', maxBytes: 16 * 1024 }), []);
    // Every read stays within the byte budget and the big log is read from its tail.
    for (const c of reads.mock.calls) {
      const { start, end } = c.arguments[1];
      assert.ok(end - start + 1 <= 16 * 1024, `${start}-${end}`);
    }
    assert.ok(reads.mock.calls.some((c) => c.arguments[0].endsWith('big.jsonl') && c.arguments[1].start === size - 16 * 1024 && c.arguments[1].end === size - 1));
    // Under the default 4 MB budget the whole log is read, so both matches count.
    const whole = await searchConvos({ logsDir, convos, q: 'parser kiwi' });
    assert.deepEqual(whole.map((r) => [r.id, r.at]), [['big', 5]]);
  } finally { reads.mock.restore(); fs.rmSync(logsDir, { recursive: true, force: true }); }
});

test('searchConvos finds a recent message past the old 4 MB prefix in a long chat', async () => {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-search-'));
  try {
    const pad = line({ t: 'text', text: 'padding '.repeat(120), ts: 50 });
    const count = Math.ceil((4.5 * 1024 * 1024) / pad.length);
    // The old match opens the log, 4.5 MB of padding follow, and the recent match closes it without a newline.
    fs.writeFileSync(path.join(logsDir, 'long.jsonl'), line({ t: 'user', text: 'quokka plan from the start', ts: 10 })
      + pad.repeat(count) + JSON.stringify({ t: 'text', text: 'quokka plan shipped today', ts: 900 }));
    const convos = [{ id: 'long', title: 'Long chat', updatedAt: 900 }];
    const res = await searchConvos({ logsDir, convos, q: 'quokka plan' });
    assert.deepEqual(res, [{ id: 'long', title: 'Long chat', at: 900, hits: [{ role: 'assistant', at: 900, snippet: 'quokka plan shipped today' }] }]);
  } finally { fs.rmSync(logsDir, { recursive: true, force: true }); }
});

test('searchConvos drops a record cut by the byte window and keeps one that starts exactly on it', async () => {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-search-'));
  try {
    const old = line({ t: 'text', text: 'zebra old', ts: 1 });
    // A corrupt line whose tail happens to parse: cut inside it, the tail alone must still never count.
    const tail = line({ t: 'text', text: 'zebra cut', ts: 2 });
    const cut = '{"t":"text","text":"pad"} ' + tail;
    const kept = line({ t: 'text', text: 'zebra kept', ts: 3 });
    const last = JSON.stringify({ t: 'text', text: 'zebra last', ts: 4 });
    fs.writeFileSync(path.join(logsDir, 'z.jsonl'), old + cut + kept + last);
    const convos = [{ id: 'z', title: 'Zoo', updatedAt: 4 }];
    const ats = async (maxBytes) => (await searchConvos({ logsDir, convos, q: 'zebra', perConvo: 10, maxBytes }))[0]?.hits.map((h) => h.at);
    // The window's first byte is the newline before `kept`, so `kept` is whole and found, as is the unterminated last record.
    assert.deepEqual(await ats(kept.length + last.length + 1), [4, 3]);
    // Starting on `kept` without seeing the byte before it, `kept` can't be known whole and is dropped.
    assert.deepEqual(await ats(kept.length + last.length), [4]);
    // Starting just before the parseable tail of the corrupt line, that tail is dropped.
    assert.deepEqual(await ats(tail.length + kept.length + last.length + 1), [4, 3]);
    // A window bigger than the log reads it whole from the top, keeping the first record.
    assert.deepEqual(await ats(1024), [4, 3, 1]);
  } finally { fs.rmSync(logsDir, { recursive: true, force: true }); }
});

test('searchConvos: short queries, missing logs and a missing logs dir find nothing', async () => {
  const { logsDir, convos } = setup();
  try {
    assert.deepEqual(await searchConvos({ logsDir, convos, q: 'b' }), []);
    assert.deepEqual(await searchConvos({ logsDir, convos, q: '  ' }), []);
    assert.deepEqual(await searchConvos({ logsDir, convos, q: 'log zebra' }), []);
    assert.deepEqual((await searchConvos({ logsDir, convos, q: 'no log' })).map((r) => r.id), ['missing']);
    assert.deepEqual(await searchConvos({ logsDir: path.join(logsDir, 'nope'), convos, q: 'parser' }), [{ id: 'titleonly', title: 'Banana Parser plans', at: 2000, hits: [] }]);
  } finally { fs.rmSync(logsDir, { recursive: true, force: true }); }
});
