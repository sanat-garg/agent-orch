# Task #227: Prompt window: Claude Code-style effort slider (Claude and Codex only)

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-27 12:43  
- starts after: #226  
- files: public/app.js, public/app.css, public/index.html, test/ui-effort*.test.mjs

## Prompt

UI for effort in the chat composer (public/app.js, app.css, index.html), next to the agent/model selector, shown ONLY when the selected agent is Claude or Codex (hidden otherwise). It's a compact pill ('Effort: high'). Clicking it opens a popover (a bottom sheet on phones) with a discrete range slider across that agent's `efforts` levels, labelled ticks, a one-line hint per level (lighter/faster → deepest/slowest, uses more of your limit), and a 'Default' reset. Arrow keys move it and Esc closes it. Changes save via PUT /api/convos/:id/effort at once, with a toast: 'Effort set to high. Queued tasks use it when they start; running tasks switch at their next session.' Switching between Claude and Codex clamps to the nearest supported level. The task drawer (for Claude/Codex tasks) shows 'Effort: high (from chat)' or '(this task)' with an override control, plus the effort each run used. It must fit at 390px (it collapses to just the level word). Screenshots via bin/shot.mjs on desktop and 390px, light and dark.

## Done when

`node --check public/app.js && npm test` passes, and a UI test shows the effort control for claude and codex, hides it for other agents, and calls PUT /api/convos/:id/effort on change
