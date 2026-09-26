# Task #147: Antigravity: show all four limits (Gemini 5h/weekly, third-party 5h/weekly) with clear names

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 23:56

## Prompt

Antigravity has four independent rate limits: 5-hour and weekly for Gemini models, and 5-hour and weekly for its third-party models (claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium). agents.mjs (~line 450) buckets them as 'gemini-5h', 'gemini-weekly', '3p-5h' and '3p-weekly', and the UI shows raw names like '3p'. 1) Verify the data source: find where agy exposes per-group usage/reset info (its status/usage command, the stream-json result, or ~/.gemini/antigravity-cli/ state or logs; read-only), record all four windows with pct and resetsAt into usage.mjs, and document what's available in .agent-orch/AGENTS.md. 2) Model-to-group mapping: derive the group from the model id (gemini-* → Gemini, everything else → third-party), and block per group. A Gemini limit must not block third-party models and vice versa (per-agent blocks become per agent+group for antigravity; delegation/forecast availability must respect it). 3) Labels everywhere (the sidebar usage card, the Usage window chips and chart legends, the limit notices and forecast text): 'Gemini · 5-hour', 'Gemini · Weekly', 'Third-party · 5-hour', 'Third-party · Weekly', with a tooltip listing which models count as third-party. Update winLabel() in public/app.js (~line 2668) and never render '3p'. 4) The sidebar card shows all four as compact rows under Antigravity, and the Usage window shows four series. Tests: group mapping, independent group blocks, and label rendering for the four ids.

## Done when

`npm test` passes with antigravity group-mapping and independent-block tests, and `! grep -n "'3p" public/app.js` finds no user-visible 3p labels
