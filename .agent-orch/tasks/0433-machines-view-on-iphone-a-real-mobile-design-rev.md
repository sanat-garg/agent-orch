# Task #433: Machines view on iPhone: a real mobile design, reviewed against Apple's HIG

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 14:22  
- starts after: #382, #398, #414  
- files: public/app.js, public/app.css, public/index.html, .agent-orch/UI-REVIEW.md, test/ui-machines-mobile*.test.mjs

## Prompt

The owner says the machine usage view on mobile is very bad and wants it improved to the max. This builds on the landed Machines work (#382 full-screen Machines with the queue, #398 oracle-vm server details in the node panel, #414 organised machine settings), so start from main after those. First read ~/.claude/skills/apple-design/SKILL.md and its relevant references (layout, lists, sheets, charts, navigation, touch targets, typography, dark mode). Capture 'before' screenshots with bin/shot.mjs --mobile at 375x667, 390x844 and 430x932 (a test server on a separate port with CW_DATA_DIR=$(mktemp -d) and CW_NO_ORCHESTRATOR=1, seeded with 4 fake nodes (VPS + 3 Macs), some running tasks and history) and list every problem in .agent-orch/UI-REVIEW.md under 'Machines on iPhone'. Then redesign for phones (<768px) without changing desktop: 1) A native-feeling structure: a large title 'Machines' with a summary line (online count, running/free slots); the segmented 'Machines | Queue' at the top; each machine as a full-width inset-grouped card (name, OS icon, status pill, build) with two compact ring or bar gauges (CPU and memory) side by side and a single line of running tasks ('3 running · #412, #418…'). Tapping a card pushes a detail page (not a cramped modal) with a back button and swipe-back: its usage charts sized for the phone width (readable axes, 12px minimum labels, tap for a value tooltip), the running tasks list, recent history, and the Machine settings. 2) The cluster diagram: on phones, replace the radial graph with a compact vertical 'head ↔ workers' strip or hide it behind 'Show diagram'; no horizontal overflow ever. 3) 44pt touch targets, 16px body text, no hover-only info, the safe areas respected, smooth 60 fps scrolling (no layout thrash from live updates: batch DOM writes per animation frame), dark mode contrast, and prefers-reduced-motion. 4) 'After' screenshots at the same sizes; mark each UI-REVIEW item Fixed. 5) Tests: at 390px, no element overflows horizontally (scrollWidth <= innerWidth), tapping a machine card opens its detail page and back returns, and the text sizes meet the minimums (a Playwright UI test). Run only the touched test files.

## Done when

`node --test test/ui-machines-mobile*.test.mjs` passes (no horizontal overflow at 375/390/430, card → detail → back, text-size minimums), and before/after phone screenshots plus a 'Machines on iPhone' section with every item marked exist in .agent-orch/UI-REVIEW.md
