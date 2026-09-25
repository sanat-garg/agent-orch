# Task #131: Fix mobile queue list overflowing the viewport

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 20:20

## Prompt

Fix the owner's reported mobile queue overflow. Read repository instructions, .agent-orch/BRIEF.md and .agent-orch/CONTEXT.md, then locate the queue layout and inspect recent changes, especially the wider queue window and indented dependents from completed task #126. Reproduce at 320, 375 and 390 CSS-pixel viewport widths with long task titles, dependency labels and nested dependents. Change only the relevant queue component/styles so the container and rows fit the viewport, text wraps or truncates appropriately, controls remain reachable, and tall lists scroll within the available screen height. Address intrinsic widths and indentation rather than hiding page overflow. Preserve desktop layout and dependency/reordering behavior. Do not duplicate the queued mobile redesign tasks #116–120 or font task #128. Verify the fix in a browser and record viewport measurements and the check used in .agent-orch/MOBILE-QUEUE-CHECK.md. Refresh BRIEF.md with this immediate goal and definition of done, and CONTEXT.md with the actual affected files and layout decision, preserving existing content.

## Done when

.agent-orch/MOBILE-QUEUE-CHECK.md records passing browser checks at 320, 375 and 390 CSS-pixel widths: no horizontal document overflow, queue container and row bounds inside the viewport, and the last row and its controls reachable by scrolling.

## Result — done (2026-09-25 20:27)

AGENT-ORCH-STATUS: done — Mobile queue fits and scrolls at all three widths
