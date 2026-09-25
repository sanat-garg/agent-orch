# Task #138: Show LiveBench in the simplified delegation popup

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 20:49  
- starts after: #137

## Prompt

After the ranking switch, adapt the simplified fallback popup produced by #133; inspect and reuse its completed implementation rather than repeat the simplification. Read .agent-orch/CONTEXT.md and the LiveBench check notes. Keep the compact ranked list and optional score details. Replace Artificial Analysis labels and setup prompts in the delegation flow with LiveBench provenance, benchmark release and freshness; show unscored or stale states honestly. Explanations must reflect the actual ranking, including owner-defined order. Remove the obsolete Artificial Analysis connection control if it has no remaining consumer, without deleting stored credentials. Verify with real fetched data and fixture states at desktop and 375 CSS-pixel widths, confirming no overflow and that displayed fallback order matches the engine. Record browser evidence in .agent-orch/LIVEBENCH-UI-CHECK.md and update CONTEXT.md.

## Done when

.agent-orch/LIVEBENCH-UI-CHECK.md contains desktop and mobile browser evidence showing LiveBench-backed fallback order, score provenance and accurate unavailable/stale states with no Artificial Analysis setup requirement.
