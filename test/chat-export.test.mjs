// chat-export.mjs: a small chat log (prompt with an attachment, reply, tool call with its output, hidden events, a commit)
// as Markdown, an empty log as just the header, tool input summaries and safe download names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatMarkdown, exportFileName, toolSummary } from '../chat-export.mjs';

const NOW = Date.UTC(2026, 9, 19, 12);
const HEADER = '# Fix the login\n\nFolder: `/home/ubuntu/workspace/app` · Exported 2026-10-19\n';
const opts = { title: 'Fix the login', cwd: '/home/ubuntu/workspace/app', now: NOW };

test('a prompt, reply, tool call and commit; output and hidden events left out', () => {
  const events = [
    { t: 'user', text: 'Why does login fail?', attachments: [{ id: 'u1', name: 'error.png', size: 10 }], ts: 1 },
    { t: 'delta', text: 'Let me' },
    { t: 'text', text: 'Let me look.' },
    { t: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test\n  -- login', description: 'Run tests' } },
    { t: 'tool_result', id: 't1', text: 'SECRET OUTPUT', isError: false },
    { t: 'text', text: 'Sub-agent chatter', sub: 't9' },
    { t: 'text', text: 'Fixed: the cookie was missing.' },
    { t: 'result', ok: true, ms: 1200 },
    { t: 'perm_done', id: 'p1' },
    { t: 'commit', sha: '0123456789abcdef0123456789abcdef01234567', ts: 2 },
  ];
  const md = chatMarkdown(events, opts);
  assert.equal(md, HEADER + [
    '', '## You', '', 'Why does login fail?', '', 'Attachments: error.png',
    '', '## Claude', '', 'Let me look.', '', '> Tool: Bash — npm test -- login', '', 'Fixed: the cookie was missing.', '', 'Commit 0123456',
  ].join('\n') + '\n');
  assert.doesNotMatch(md, /SECRET OUTPUT|Sub-agent|Let me\n/);
});

test('an empty log is just the header; the agent name heads replies', () => {
  assert.equal(chatMarkdown([], opts), HEADER);
  assert.equal(chatMarkdown(undefined, opts), HEADER);
  const md = chatMarkdown([{ t: 'user', text: 'hi' }, { t: 'text', text: 'hello' }, { t: 'user', text: 'again' }], { ...opts, agent: 'Codex' });
  assert.match(md, /## You\n\nhi\n\n## Codex\n\nhello\n\n## You\n\nagain\n$/);
});

test('tool summaries are one short line', () => {
  assert.equal(toolSummary({ file_path: '/a/b.js', content: 'x' }), '/a/b.js');
  assert.equal(toolSummary({ foo: 1, bar: 'first string' }), 'first string');
  assert.equal(toolSummary({}), '');
  assert.equal(toolSummary({ command: 'x'.repeat(500) }).length, 120);
});

test('download names are safe', () => {
  assert.equal(exportFileName('Fix: a/b "login"?'), 'Fix a b login.md');
  assert.equal(exportFileName(''), 'chat.md');
  assert.equal(exportFileName('..'), 'chat.md');
  assert.equal(exportFileName('Résumé ✓'), 'Résumé ✓.md');
});
