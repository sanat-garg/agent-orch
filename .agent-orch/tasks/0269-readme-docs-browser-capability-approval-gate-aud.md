# Task #269: README docs: browser capability, approval gate, audit log, live browser view and worker extension sync

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 05:17  
- files: README.md

## Prompt

README.md does not mention any of the computer-work features that landed on 2026-09-28. Add one section 'Computer work: browser, approvals and audit' (place it after 'Skills, MCP servers, subagents and personas') that documents, from the code, not from memory: (1) the browser capability: tasks with capabilities ['browser'] and an identity get the pinned @playwright/mcp on a persistent profile under ~/.agent-orch-browser/profiles/<identity> (browser.mjs), where such tasks are placed (a worker with Chromium, or the controller only when 'controllerBrowser' is on), how a worker installs Chromium (AGENT_ORCH_WORKER_BROWSER=off|check|install in worker.mjs); (2) the approval gate (gate.mjs, gate-proxy.mjs, approvals.mjs): read/draft/outbound classification, outbound calls held until the owner approves in the UI, the audit log at data/audit/<task>.jsonl, gate settings, and that held time does not count toward the task timeout; (3) the live browser view (sidebar globe → Browser sheet, public/browser.js, browser-live.mjs): sign in once on a profile, watch a run, take over; (4) worker extension sync (extensions.mjs applyBundle, ext.sync): skills/subagents/MCP/personas reach worker jobs automatically. Also add the env vars AGENT_ORCH_BROWSER_HOME and AGENT_ORCH_WORKER_BROWSER to the 'Environment variables' section, and link .agent-orch/AGENTIC.md for the design. Keep the README's existing tone and heading style; no marketing. Read the header comments of browser.mjs, gate.mjs, approvals.mjs, browser-live.mjs and extensions.mjs before writing.

## Done when

`grep -q 'Computer work' README.md` and `grep -q 'approval' README.md` and `grep -q 'AGENT_ORCH_WORKER_BROWSER' README.md` and `grep -q 'data/audit' README.md` and `grep -q 'AGENTIC.md' README.md`

## Result — done (check passed) (2026-09-28 05:18)

AGENT-ORCH-STATUS: done — README documents browser tasks, approval gate, audit, live view, sync
