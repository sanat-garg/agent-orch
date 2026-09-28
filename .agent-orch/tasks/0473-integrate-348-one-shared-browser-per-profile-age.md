# Task #473: Integrate #348: One shared browser per profile: agents attach to the live view, self-healing, run on a Mac

- kind: work  
- source: planner  
- priority: 95 (normal)  
- created: 2026-09-28 17:33  
- files: browser-live.mjs, browser.mjs, bin/browser-mcp.mjs, browser-view.mjs, public/browser.js, orchestrator.mjs, test/browser-shared*.test.mjs

## Prompt

Task #348 ("One shared browser per profile: agents attach to the live view, self-healing, run on a Mac") finished in its own git worktree, but its branch `agent-orch/task-348` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md, bin/browser-mcp.mjs, browser-live.mjs, browser.mjs, orchestrator.mjs). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #348's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #348's instructions were:

The owner reports the Browser tab is a black, unresponsive screen, and agents can't use the browser well. The planner found at 12:28: the live view's Chromium for profile 'default' (launched by browser-live.mjs launchChrome with --user-data-dir=~/.agent-orch-browser/profiles/default and a remote-debugging port) had died: DevToolsActivePort says 43615, but nothing listens there. Meanwhile an agent's Playwright MCP had launched its OWN chrome-headless-shell (Playwright launch flags) because browser.mjs (~line 92) starts @playwright/mcp with `--user-data-dir <profile>`. Chromium allows one process per user-data-dir, so the viewer and the agent fight over the profile. bin/browser-mcp.mjs already implements the right idea (start or attach to the profile's browser and run @playwright/mcp with --cdp-endpoint), but runs don't consistently use it. Also the controller VPS has 1 core (cpu PSI avg10 ~57% with 9 tasks), which is too weak to stream a browser. Build on #347's fixes: 1) Exactly ONE Chromium per profile per node, owned by a small supervisor in browser-live.mjs: it launches FULL Chromium (not chrome-headless-shell; use the Playwright chromium build or system Chrome, with `--headless=new` only where there's no display), records the endpoint, health-checks it every 5 s via /json/version, restarts it on crash, and keeps the profile lock. 2) Every agent browser run goes through bin/browser-mcp.mjs → @playwright/mcp --cdp-endpoint <supervised endpoint>, never --user-data-dir (change browser.mjs's MCP config builder; remove the direct-launch path or keep it only when explicitly isolated). The agent works in its own tab that the live view follows (the viewer switches to the agent's active target and shows 'Agent tab'). The owner's input still takes priority via Take over. 3) The viewer reconnects automatically when the browser restarts (with a 'Reconnecting…' overlay instead of black), requests a fresh frame on attach (Page.captureScreenshot as the first frame, then the screencast), acks frames promptly, and shows a clear error if the browser can't start. It never shows a silent black canvas. 4) Placement: browser profiles live on a Mac worker by default. The Browser tab's machine picker defaults to the least-loaded online Mac, browser tasks pin to that profile's node, and the controller is used only if no Mac is online (with a note 'Running on the VPS (slow)'). 5) E2E test (test/browser-shared*.test.mjs, with real Chromium): a viewer attached and an @playwright/mcp client via bin/browser-mcp.mjs on the SAME profile at the same time; the MCP navigates and clicks, and the viewer receives non-black frames of that page (check that the pixel variance of a decoded frame is > 0); killing the Chromium process leads to a supervised restart within 10 s, the viewer resumes frames and the next MCP call succeeds; only one Chromium main process exists for the profile throughout. Run only the touched test files.

## Done when

`node --test test/browser-shared*.test.mjs` passes without skipping (shared browser, non-black frames while the MCP drives it, auto-recovery after kill, a single Chromium per profile)

## Result — verify failed (1) (2026-09-28 17:48)

Command: node --test test/browser-shared*.test.mjs

TAP version 13
# Subtest: a browser run's MCP attaches to the profile's shared Chromium, never launching one on the profile
ok 1 - a browser run's MCP attaches to the profile's shared Chromium, never launching one on the profile
  ---
  duration_ms: 1262.5748
  type: 'test'
  ...
# Subtest: the live view and the agent's MCP share one self-healing Chromium on the profile
not ok 2 - the live view and the agent's MCP share one self-healing Chromium on the profile
  ---
  duration_ms: 38895.837532
  type: 'test'
  location: '/home/ubuntu/.agent-orch-worktrees/agent-orch-task-348/test/browser-shared.test.mjs:163:1'
  failureType: 'testCodeFailure'
  error: `Timed out: the viewer shows the agent's page: {"t":"bv_state","node":"controller","identity":"shared","url":"http://127.0.0.1:34533/home","title":"Shared /home","active":true,"takeover":false,"reconnecting":false,"agentTab":false,"role":"watch","task":null,"at":1790617696281}`
  code: 'ERR_TEST_FAILURE'
  stack: |-
    file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-348/test/browser-shared.test.mjs:32:83
    async TestContext.<anonymous> (file:///home/ubuntu/.agent-orch-worktrees/agent-orch-task-348/test/browser-shared.test.mjs:233:5)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
1..2
# tests 2
# suites 0
# pass 1
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 50971.778338

## Result — done (check passed) (2026-09-28 17:52)

AGENT-ORCH-STATUS: done — viewer follows agent's new tab after restart; tests pass
