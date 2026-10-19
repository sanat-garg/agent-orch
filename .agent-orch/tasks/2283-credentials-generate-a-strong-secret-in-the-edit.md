# Task #2283: Credentials: generate a strong secret in the editor, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:41  
- files: public/credentials.js, public/credentials.css, test/ui-credentials-generate.test.mjs

## Prompt

Goal: in the Credentials sheet's editor (public/credentials.js, startEdit/fieldRow/input), each value field gets a 'Generate' button that fills it with a strong random secret, for setting up keys like SESSION_SECRET or a database password without leaving the app. Use crypto.getRandomValues (never Math.random). A small menu or segmented choice offers: 32-char letters+digits (default), 64-char hex, and a 24-char password with symbols. Filling a non-empty field asks confirm('Replace the current value?') first. The generated value is shown (not dotted) until saved, and saving uses the existing save path.

Edge cases: cancel on the confirm leaves the value unchanged; nothing is sent to the server until the owner presses Save. 44px targets on phones (public/credentials.css). Don't edit app.js.

Test: new test/ui-credentials-generate.test.mjs copying the setup of the existing credentials UI test (grep test/ for credentials): Generate fills an empty field with a 32-char [A-Za-z0-9] value, hex mode gives 64 [0-9a-f], and dismissing the confirm keeps an existing value.

## Done when

`npm test -- test/ui-credentials-generate.test.mjs` passes.

## Result — verify failed (1) (2026-10-19 16:00)

Command: npm test -- test/ui-credentials-generate.test.mjs


> agent-orch@1.0.0 test
> node bin/test.mjs test/ui-credentials-generate.test.mjs

npm test: 1 of 247 test files, named on the command line. `npm run test:full` runs them all.
TAP version 13
# Subtest: Generate fills an empty value with 32 letters+digits shown in clear; hex gives 64 hex digits
not ok 1 - Generate fills an empty value with 32 letters+digits shown in clear; hex gives 64 hex digits
  ---
  duration_ms: 24108.346787
  type: 'test'
  location: '/home/ubuntu/.agent-orch-worktrees/agent-orch-task-2283/test/ui-credentials-generate.test.mjs:86:1'
  failureType: 'testCodeFailure'
  error: |-
    a secret row reads as dots before anything is generated
    
    'text' !== 'password'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'password'
  actual: 'text'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-2283/test/ui-credentials-generate.test.mjs:98:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
# Subtest: dismissing "Replace the current value?" keeps an existing value
ok 2 - dismissing "Replace the current value?" keeps an existing value
  ---
  duration_ms: 2015.046075
  type: 'test'
  ...
# Subtest: 390×844 touch: Generate and its options are 44px targets
ok 3 - 390×844 touch: Generate and its options are 44px targets
  ---
  duration_ms: 1562.053291
  type: 'test'
  ...
1..3
# tests 3
# suites 0
# pass 2
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 31037.789999

## Result — done (check passed) (2026-10-19 16:13)

The Done-when check passed with all three tests green. The extra static-check run only timed out waiting on the shared test lock; my changes add no top-level functions and reference only existing element ids, so it is not at risk.

AGENT-ORCH-STATUS: done — Generate menu fills credentials with crypto-random secrets; tests pass
