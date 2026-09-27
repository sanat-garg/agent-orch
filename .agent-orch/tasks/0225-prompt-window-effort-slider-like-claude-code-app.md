# Task #225: Prompt window: effort slider like Claude Code, applied to active tasks

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-27 12:42  
- starts after: #224  
- files: public/app.js, public/app.css, public/index.html, test/ui-effort*.test.mjs

## Prompt

UI for effort in the chat composer (public/app.js, app.css, index.html), next to the agent/model selector. It's a compact 'Effort' control like Claude Code's: a small pill showing the current level (e.g. 'Effort: high'). Clicking it opens a popover (a bottom sheet on phones) with a discrete range slider across the levels the selected agent supports (from the adapter's `efforts`, e.g. low · medium · high · xhigh · max for Claude, low · medium · high for Antigravity), labelled tick marks, a one-line hint per level ('Faster, lighter reasoning' → 'Deepest reasoning, slowest, uses more of your limit'), and a 'Default' reset. Keyboard: arrow keys move the slider, Esc closes. Changing it saves via PUT /api/convos/:id/effort immediately and applies to active work: show a toast 'Effort set to high. Queued tasks use it when they start; running tasks switch at their next session.' When the agent changes to one with fewer levels, clamp to the nearest supported level and show the clamped value. It's hidden for agents that don't support effort. The task drawer shows 'Effort: high (from chat)' or 'high (this task)' with a small override control, plus the effort each past run used. It must fit the composer at 390px without overflow (it collapses to just the level word). Screenshots via bin/shot.mjs on desktop and 390px, light and dark.

## Done when

`node --check public/app.js && npm test` passes, the composer renders an effort control whose slider steps come from the selected agent's efforts, and changing it calls PUT /api/convos/:id/effort (asserted in a UI test)
