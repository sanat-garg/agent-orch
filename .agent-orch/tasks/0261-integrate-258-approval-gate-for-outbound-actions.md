# Task #261: Integrate #258: Approval gate for outbound actions, with an audit log

- kind: work  
- source: planner  
- priority: 60 (normal)  
- created: 2026-09-28 03:40  
- files: approvals.mjs, mcp-proxy.mjs, agents.mjs, orchestrator.mjs, server.mjs, public/app.js, public/app.css, test/approval-gate*.test.mjs

## Prompt

Task #258 ("Approval gate for outbound actions, with an audit log") finished in its own git worktree, but its branch `agent-orch/task-258` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md, cluster-protocol.mjs, test/cluster-protocol.test.mjs, test/compute-only.test.mjs, worker.mjs). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #258's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #258's instructions were:

Implement the safety model from .agent-orch/AGENTIC.md. 1) Classify tool calls in agent runs as read / draft / outbound. Outbound means: connector tools marked outbound (send email, create payment, delete, publish, share, change permissions); and browser actions whose target, from the MCP tool args plus an accessibility-snapshot lookup of the element's name, matches a configurable pattern list (Send, Pay, Transfer, Submit order, Publish, Share, Delete, Confirm, Place order, Sign, and the owner's custom patterns), or which navigate to checkout/payment URLs. 2) Gate: intercept outbound calls BEFORE they execute. For Claude runs use the SDK's canUseTool/permission hook for the MCP tools; for Codex and workers use an equivalent MCP proxy that wraps the Playwright/connector MCP servers and holds the call. The task pauses in 'awaiting approval', and the owner gets a UI card, chat notice and sound with the exact action ('Click Send in Gmail compose to: bob@…, subject …'), a screenshot of the page, and Approve once / Always allow this action for this task / Deny (with a reason fed back to the agent). There's a timeout (default: deny after 24 h). 3) Audit: every tool call of a browser/connector run is logged to <DATA>/audit/<task>.jsonl with a timestamp, classification, args (secrets redacted) and screenshot id, viewable in the task drawer as an 'Actions' timeline. 4) Tests: a click on a 'Send' button is held until approved, Deny returns an error to the agent and the page is unchanged, read actions pass without prompting, and the audit entries are written.

## Done when

`node --test test/approval-gate*.test.mjs` passes (send held until approval, deny leaves page unchanged, reads not gated, audit written)

## Result — done (check passed) (2026-09-28 03:44)

AGENT-ORCH-STATUS: done — Merge conflicts resolved; approval-gate, protocol and browser tests pass
