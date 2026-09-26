# Task #212: Pause/Resume buttons: theme orange, no emoji

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 19:44  
- files: public/app.css, public/app.js, public/index.html

## Prompt

Restyle the orchestrator dock's Pause/Resume button (#obPause in public/index.html, styled and labelled in public/app.css and public/app.js by task #204). 1) Remove the emoji and symbol glyphs from the labels (no ⏸, ▶ or similar characters anywhere in these buttons, including in title attributes and aria-labels). The labels are plain text 'Pause' and 'Resume'. A small inline SVG icon is optional only if it matches the app's other SVG icons (stroke, currentColor); prefer text only. 2) Colour: use the theme's orange accent (var(--accent), the Claude orange). Resume (orchestrator paused) is a filled button: an accent background, white/--on-accent text and a slightly darker accent on hover and active. Pause (orchestrator running) is an outlined button: a 1px var(--accent) border, var(--accent) text, a transparent background and a faint accent tint on hover. Both have the same height (36px desktop, 44px touch), radius and font weight as the app's primary buttons, a visible focus ring, and correct contrast in light and dark mode (check the text contrast is ≥ 4.5:1; adjust with the existing accent variants if needed). 3) Apply the same style to any other pause/resume controls (e.g. the task drawer's Pause/Resume for a single task, if present) for consistency. Screenshots of both states in light and dark, on desktop and at 390px, via bin/shot.mjs.

## Done when

`node --check public/app.js && npm test` passes, `! grep -nE "⏸|▶|⏯" public/app.js public/index.html` finds no emoji on the pause/resume controls, and app.css styles #obPause with var(--accent)
