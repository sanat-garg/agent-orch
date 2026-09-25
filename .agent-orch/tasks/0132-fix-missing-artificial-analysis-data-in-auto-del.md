# Task #132: Fix missing Artificial Analysis data in Auto Delegate fallback popup

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 20:38

## Prompt

Investigate and fix the owner's report that Artificial Analysis data is absent from the Auto Delegate model fallback popup. Read repository instructions and .agent-orch/BRIEF.md and CONTEXT.md. Locate the Artificial Analysis integration from task #108, delegation ranking from #109, and current fallback popup. Trace saved connection configuration, provider fetch/cache, model identifier mapping, API serialization and popup consumption; fix the demonstrated failure without guessing the cause. Distinguish loading, missing configuration, provider failure and genuinely unavailable model metrics from valid data. Never fabricate scores or expose API keys. Add a focused regression test using a representative mocked provider response through the affected path, including unmatched models and provider failure. Preserve existing ranking and saved per-chat fallback semantics from #129. Refresh BRIEF.md with the owner's missing-data and simplification goals, and CONTEXT.md with verified architecture and diagnosis. Record the regression command and result in .agent-orch/DELEGATE-DATA-CHECK.md.

## Done when

.agent-orch/DELEGATE-DATA-CHECK.md identifies the verified cause and records a passing automated regression showing provider metrics reach popup data and unavailable/error cases remain distinguishable.

## Result — done (2026-09-25 20:45)

AGENT-ORCH-STATUS: done — Free-tier metrics reach popup; distinct data states pass regression.
