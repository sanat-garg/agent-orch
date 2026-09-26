# Task #152: Remove all benchmark scoring (LiveBench, Artificial Analysis) and automatic ranking

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 04:21

## Prompt

The owner wants NO grading/benchmark tools. Delegation will use only the owner's manual fallback lists (see .agent-orch/BRIEF.md goal 8). Remove: the LiveBench client/cache and the Artificial Analysis client (aa.mjs), its API-key row in the Connections modal, <DATA>/aa-models.json, <DATA>/livebench caches, .agent-orch/model-metrics.json and model-map.json, GET /api/models/metrics, the metric columns/scores in every UI (delegation popup, fallback editor rows, suggested lists, tooltips), and in delegate.mjs everything about weightedScore, rankCandidates, CATEGORY_WEIGHTS, taskCategory, 'comparable' thresholds and 'suggested' candidates. The remaining delegation logic is simple: nextModel(task) returns the first entry in the task's fallback list (after its primary model) whose agent is connected and not rate-limited for that model's group, or null. Delete the related tests and fixtures, and update README and .agent-orch docs. Keep the secrets.json mechanism only if something else uses it. Don't redesign the UI in this task (the next task does); just strip the scores so nothing breaks.

## Done when

`! grep -rniE "livebench|artificial ?analysis|weightedScore|rankCandidates|aa-models" --include=*.mjs --include=*.js --include=*.html public *.mjs test` finds nothing, and `npm test` passes

## Result — done (check passed) (2026-09-26 04:33)

AGENT-ORCH-STATUS: done — benchmark scoring gone; delegation uses owner fallback lists only
