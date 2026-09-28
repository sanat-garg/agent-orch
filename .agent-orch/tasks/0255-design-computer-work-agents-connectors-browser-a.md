# Task #255: Design computer-work agents: connectors, browser, approvals (AGENTIC.md)

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 01:58  
- files: .agent-orch/AGENTIC.md

## Prompt

Write .agent-orch/AGENTIC.md, the design for BRIEF goal 12 (agents doing office work: email, Canva, spreadsheets, accounting, web apps). No code in this task. First read BRIEF, CONTEXT, CLUSTER.md, extensions.mjs (MCP servers given to runs; skills/subagents/MCP sync to workers) and agents.mjs. Research with web search and document concretely, with install commands, auth method, scopes, and read vs write capability: (a) connectors: Gmail/Google Workspace (Gmail API via an OAuth desktop client, or an MCP server such as a Google Workspace MCP; IMAP as a fallback), Canva (the Canva Connect API / Canva's MCP server: what editing is possible via the API vs the UI only), Google Sheets/Drive, and accounting (QuickBooks Online, Xero, Zoho Books MCP/APIs), plus bank statement ingestion (CSV/PDF); (b) the browser fallback: @playwright/mcp (or Chrome DevTools MCP) given to Claude/Codex runs, persistent per-identity browser profiles, headed vs headless, where it runs (prefer a paired Mac worker; the VPS has 1 core), and how the owner signs in once (a live view streamed to the UI via a CDP screencast, with input passthrough); (c) the safety model: classify tools as read / draft / outbound-irreversible, require the owner's approval for outbound actions (send, pay, delete, publish, share, submit forms) via a pause-and-ask flow with a screenshot and the exact action, an audit log with screenshots, credential storage (tokens encrypted at rest in <DATA>/secrets, never in prompts or logs), per-task capability grants, and prompt-injection defences (content from emails and web pages is untrusted data, never instructions); (d) task shape: a 'workspace' project type for non-code work (files and outputs, still git-tracked for audit), task templates (inbox triage, invoice processing, bank reconciliation, Canva edit), and how done_when checks work for non-code tasks (output files exist, draft counts, owner review checkpoints); (e) a phased rollout, and the honest limits (CAPTCHAs, 2FA, sites' terms of service, reliability of UI automation).

## Done when

.agent-orch/AGENTIC.md exists with sections Connectors, Browser, Safety, Task shape and Rollout, each connector naming its auth method and read/write scope

## Result — done (2026-09-28 02:22)

AGENT-ORCH-STATUS: done — AGENTIC.md covers connectors, browser, safety, task shape and rollout
