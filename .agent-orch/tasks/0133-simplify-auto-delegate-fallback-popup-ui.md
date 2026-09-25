# Task #133: Simplify Auto Delegate fallback popup UI

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 20:38  
- starts after: #132

## Prompt

Simplify the existing Auto Delegate fallback popup after the data fix. Read repository instructions, .agent-orch/BRIEF.md, CONTEXT.md and DELEGATE-DATA-CHECK.md; locate the existing popup component and styles. Default view should show the starting model and a compact ordered fallback list, with each row showing model name and one short explanation grounded in the actual ranking or availability. Move available Artificial Analysis scores and technical explanations behind a single optional details disclosure. Use concise, actionable loading, unconfigured and error states from the preceding fix; never show missing metrics as zero or imply scores exist when absent. Preserve existing selection/saving behavior and routing; do not revive cancelled task #130's fallback editing features or alter ranking. Verify populated and unavailable-data states on desktop and at 375 CSS pixels, including long model names, reachable controls and no horizontal overflow. Update CONTEXT.md with the UI decision and record browser evidence in .agent-orch/DELEGATE-POPUP-CHECK.md.

## Done when

.agent-orch/DELEGATE-POPUP-CHECK.md contains browser evidence at desktop and 375-pixel widths showing the compact ranked list, expandable real score details, actionable unavailable-data state and no horizontal overflow.

## Result — done (2026-09-25 20:51)

AGENT-ORCH-STATUS: done — Compact fallback popup verified at desktop and 375 pixels.
