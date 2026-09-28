// gate.mjs `classify` on its own (AUDIT #68): uploads, coordinate clicks and code urls are outbound, and Enter's "always"
// key names the focused field. Pure functions only: no proxy, no Playwright, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { classify, parseSnapshot } from '../gate.mjs';

const SNAP = `### Page
- Page URL: https://app.example.com/inbox
- Page Title: Inbox
### Snapshot
\`\`\`yaml
- generic [ref=e1]:
  - searchbox "Search mail" [active] [ref=e2]
  - textbox "Message" [ref=e3]: hello
  - link "Docs" [ref=e4] [cursor=pointer]:
    - /url: https://docs.example.com/guide
  - button "Send" [ref=e5]
\`\`\``;
const snapshot = parseSnapshot(SNAP), ctx = { server: 'playwright', snapshot };

test('classify: browser_file_upload is outbound, keyed by a hash of the sorted paths', () => {
  const up = classify('browser_file_upload', { paths: ['/home/u/.codex/auth.json', '/data/agent-orch.db'] }, ctx);
  assert.equal(up.cls, 'outbound');
  assert.equal(up.reason, 'uploads local files');
  assert.equal(up.action, 'Upload /home/u/.codex/auth.json, /data/agent-orch.db on app.example.com/inbox');
  const sha = crypto.createHash('sha256').update(JSON.stringify(['/data/agent-orch.db', '/home/u/.codex/auth.json'])).digest('hex');
  assert.equal(up.key, `playwright|browser_file_upload|${sha}`);
  assert.equal(classify('browser_file_upload', { paths: ['/data/agent-orch.db', '/home/u/.codex/auth.json'] }, ctx).key, up.key, 'order does not matter');
  assert.notEqual(classify('browser_file_upload', { paths: ['/tmp/report.pdf'] }, ctx).key, up.key, 'other files are not covered');
  assert.notEqual(classify('browser_file_upload', {}, ctx).key, 'playwright|browser_file_upload', 'never a bare "always"');
  assert.match(classify('browser_file_upload', { paths: ['/x'.repeat(200)] }, ctx).action, /^Upload \/x.{190,}…/, 'paths are clipped');
});

test('classify: clicks and drags by coordinates are outbound with no "always"', () => {
  for (const [tool, args] of [['browser_mouse_click_xy', { x: 640, y: 480 }], ['browser_mouse_drag_xy', { startX: 1, startY: 2, endX: 3, endY: 4 }]]) {
    const c = classify(tool, args, ctx);
    assert.deepEqual([c.cls, c.reason, c.key], ['outbound', 'clicks by coordinates, target unknown', null], tool);
  }
  assert.equal(classify('browser_mouse_click_xy', { x: 640, y: 480 }, ctx).action, 'Click at (640, 480) on app.example.com/inbox');
});

test('classify: navigating to javascript:, data:, blob: or vbscript: runs code; file: and chrome: stay outbound', () => {
  for (const u of ['javascript:alert(1)', ' JavaScript:fetch("/x")', 'java\tscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'blob:https://example.com/0f3c', 'vbscript:msgbox(1)']) {
    const nav = classify('browser_navigate', { url: u }, ctx);
    assert.deepEqual([nav.cls, nav.reason, nav.key], ['outbound', 'runs code in the page', null], u);
  }
  for (const u of ['file:///etc/passwd', 'file:///Users/u/.codex/auth.json', 'chrome://settings/passwords']) {
    const nav = classify('browser_navigate', { url: u }, ctx);
    assert.deepEqual([nav.cls, nav.reason], ['outbound', 'opens a local or private service'], u);
  }
});

test('classify: browser_press_key\'s "always" key names the focused element', () => {
  const inSearch = classify('browser_press_key', { key: 'Enter' }, ctx);
  assert.equal(inSearch.cls, 'draft', 'Enter in a search box only searches');
  assert.equal(inSearch.key, 'playwright|browser_press_key|enter|searchbox|search mail|app.example.com');
  const composer = parseSnapshot(SNAP.replace('[active] ', '').replace('"Message" [ref=e3]', '"Message" [active] [ref=e3]'));
  const inMessage = classify('browser_press_key', { key: 'Enter' }, { ...ctx, snapshot: composer });
  assert.equal(inMessage.cls, 'outbound');
  assert.notEqual(inMessage.key, inSearch.key, 'an "always" on Enter in search does not cover Enter in the composer');
  const none = classify('browser_press_key', { key: 'Enter' }, { ...ctx, snapshot: parseSnapshot(SNAP.replace('[active] ', '')) });
  assert.equal(none.key, 'playwright|browser_press_key|enter|none|none|app.example.com', 'nothing focused');
});

test('classify: unchanged cases stay draft', () => {
  assert.equal(classify('browser_click', { element: 'Docs link', target: 'e4' }, ctx).cls, 'draft', 'a named link');
  assert.equal(classify('browser_navigate', { url: 'https://example.com' }, ctx).cls, 'draft');
  assert.equal(classify('browser_type', { target: 'e3', text: 'hi' }, ctx).cls, 'draft', 'typing without submit');
  assert.equal(classify('browser_click', { element: 'Send', target: 'e5' }, ctx).cls, 'outbound', 'Send still is not');
});
