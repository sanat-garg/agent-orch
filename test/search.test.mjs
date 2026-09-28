// searchConvos: every term must match (title or message text), results come newest hit first with at most perConvo
// hits each, a log is read only up to maxBytes, a corrupt line or a missing log is skipped, and short queries find nothing.
import { test } from 'node:test';
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
  // big: padded past maxBytes, with the only match at the very end.
  fs.writeFileSync(path.join(logsDir, 'big.jsonl'),
    Array.from({ length: 200 }, (_, i) => line({ t: 'text', text: 'padding '.repeat(20), ts: 10 + i })).join('')
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
    assert.deepEqual(res.map((r) => r.id), ['title', 'titleonly', 'a']);
    const [title, titleOnly, a] = res;
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
    assert.deepEqual((await searchConvos({ logsDir, convos, q: 'banana parser', limit: 2, maxBytes: 16 * 1024 })).map((r) => r.id), ['title', 'titleonly']);
  } finally { fs.rmSync(logsDir, { recursive: true, force: true }); }
});

test('searchConvos reads at most maxBytes of a log', async () => {
  const { logsDir, convos } = setup();
  try {
    assert.ok(fs.statSync(path.join(logsDir, 'big.jsonl')).size > 16 * 1024);
    const capped = await searchConvos({ logsDir, convos, q: 'deep in the log', maxBytes: 16 * 1024 });
    assert.deepEqual(capped, []);
    const whole = await searchConvos({ logsDir, convos, q: 'deep in the log' });
    assert.deepEqual(whole.map((r) => [r.id, r.at]), [['big', 5000]]);
    assert.equal(whole[0].hits[0].snippet, 'banana parser deep in the log');
    // With the whole log read, big's hit is the newest of all.
    assert.equal((await searchConvos({ logsDir, convos, q: 'banana parser' }))[0].id, 'big');
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
