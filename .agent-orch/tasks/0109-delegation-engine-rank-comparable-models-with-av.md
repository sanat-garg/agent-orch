# Task #109: Delegation engine: rank comparable models with available usage for a task

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 13:22  
- starts after: #108

## Prompt

Build delegate.mjs, used by the orchestrator. candidates(task) returns the models from connected agents that are NOT currently rate-limited (per-agent blocks and usage windows below ~90%), ranked by similarity to the task's current model on the metrics from /api/models/metrics (aa.mjs). The task category decides which metrics weigh most: coding/implementation uses Coding Index + Terminal-Bench, agentic/multi-step uses Agentic Index, scientific/data uses SciCode, and a general fallback uses the Intelligence Index. Use the task title/prompt keywords or a planner-provided category. A model is 'comparable' if its weighted score is ≥ 95% of the original's, or it's within 2 ranks among available models (configurable in CFG). Return a score, the key metrics and a short reason for each candidate. Policy, per .agent-orch/BRIEF.md goal 8: eligible(task) is true for tasks created by reflection; for tasks from the owner's chat only if the originating chat message had autoDelegate=true (add tasks.auto_delegate and tasks.origin columns, with migration); and never if the owner pinned a specific model for that message. Orchestrator integration: when a task's resolved agent is blocked and eligible(task), reassign it to the top candidate (record delegated_from and delegated_reason, log an event, and show it on the task badge). Otherwise it waits as now. The planner prompt gets a short line saying reflection tasks may be delegated. Tests cover the policy matrix (reflect / chat+auto / chat+pinned / chat default) and ranking with fixture metrics.

## Done when

`npm test` passes with delegate.mjs policy-matrix and ranking tests
