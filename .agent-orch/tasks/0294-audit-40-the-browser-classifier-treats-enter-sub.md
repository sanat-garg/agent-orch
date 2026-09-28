# Task #294: AUDIT #40: the browser classifier treats Enter, submit and common outbound buttons as outbound

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 08:44  
- files: gate.mjs, test/approval-gate.test.mjs, test/approval-gate-browser.test.mjs, .agent-orch/AUDIT.md

## Prompt

Fix AUDIT.md Round 6 item #40 (read it first). In gate.mjs `classify()` (around lines 120–175; DEFAULT_PATTERNS at line 16): `browser_press_key` is always draft, `browser_type` with `submit: true` is draft unless the field's own name matches a pattern, DEFAULT_PATTERNS lacks Post, Reply, Submit, Buy, Order, Checkout, Tweet and 'Save & send', and a button with no accessible name is matched only against the agent's own `element` text. In Slack, WhatsApp, LinkedIn and Gmail, Enter or Ctrl/Meta+Enter sends.

Change: (1) `browser_press_key` with key Enter, NumpadEnter, Control+Enter, Meta+Enter or Cmd+Enter is outbound with reason 'may submit the focused field' when the snapshot shows a focused text field (Playwright snapshots mark it `[active]`; check how `fieldsOf`/the snapshot parser in gate.mjs represents focus and extend it if it doesn't) or when no snapshot is available; other keys stay draft. (2) `browser_type` with `submit: true` is outbound unless the target is a searchbox or a field whose name matches /search|filter|find/i. (3) Add Post, Reply, Submit, Buy, Order, Checkout, Tweet and 'Save & send' to DEFAULT_PATTERNS, and extend BENIGN_RE so nouns like 'Order history', 'Orders', 'Posts', 'Replies', 'Checkout history' stay draft. (4) A clicked element with role button and no name, no selector text and no href is outbound with reason 'button with no accessible name'. Keep the `key` values stable so 'Always allow' still works, and keep the action text readable.

Update test/approval-gate.test.mjs `classify:` cases with these four behaviours (a Slack-like snapshot with a focused textbox, Ctrl+Enter, a 'Post' button, a nameless button) and check test/approval-gate-browser.test.mjs still passes. Mark #40 **Fixed** in .agent-orch/AUDIT.md.

## Done when

`npm test -- test/approval-gate.test.mjs test/approval-gate-browser.test.mjs` passes
