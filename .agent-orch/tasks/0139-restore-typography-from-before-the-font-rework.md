# Task #139: Restore typography from before the font rework

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 20:49

## Prompt

The owner dislikes the recent font rework and explicitly wants the previous typography restored. Read repository instructions and .agent-orch/BRIEF.md and CONTEXT.md. Inspect git history and diffs to identify the actual font rework and the preceding typography; do not guess a replacement font. Task #128 (self-host Inter + JetBrains Mono) is cancelled: inspect for partial changes but do not resume it. Restore the previous font families, weights and any typography settings changed as part of that rework. Remove introduced font imports/assets only where no longer referenced. Revert targeted typography hunks, not entire commits containing unrelated changes. Preserve recent queue overflow fixes, model selector sizing and simplified fallback popup behavior. Check the rendered chat, task queue and composer on desktop and at 375 CSS-pixel width. Refresh BRIEF.md with the owner's preference for the restored typography and CONTEXT.md with the baseline revision and affected files. Record baseline comparison and browser evidence in .agent-orch/FONT-RESTORE-CHECK.md.

## Done when

.agent-orch/FONT-RESTORE-CHECK.md identifies the pre-rework git revision and confirms rendered chat, queue and composer typography matches that baseline on desktop and mobile without reintroducing horizontal overflow.
