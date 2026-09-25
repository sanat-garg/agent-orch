# Task #124: Composer model selector: width fits the selected model name

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 18:21

## Prompt

In the chat composer, the agent/model selector box is fixed-width and small, so long model names (e.g. 'gemini-3.1-pro-high', 'claude-opus-4-6-thinking', 'gpt-6-astra') overflow. Make the control size to its current label: if it's a native <select>, measure the selected option's text with a hidden span using the same font and set the width in px (plus padding and chevron) on change and on load; if it's a custom button, use width:auto/inline-flex with white-space:nowrap. Clamp it with max-width (e.g. min(50vw, 320px) on desktop, 60vw on phones) and use text-overflow:ellipsis inside the clamp with the full name in title. Show friendly display names from the discovered model list where available. The composer layout must not jump or wrap the send button. Check light and dark themes, desktop and a 390px-wide mobile, with screenshots via bin/shot.mjs.

## Done when

`node --check public/app.js && npm test` passes, and a 390px mobile screenshot in .agent-orch/shots/ shows a long model name without overflow

## Result — done (check passed) (2026-09-25 19:33)

AGENT-ORCH-STATUS: done — model picker sizes to its selected name, clamped and ellipsized
