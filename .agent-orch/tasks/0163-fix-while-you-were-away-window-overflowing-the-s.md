# Task #163: Fix 'While you were away' window overflowing the screen on iPhone

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-26 04:50

## Prompt

On iPhone, the 'While you were away' modal (public/index.html #awayModal ~line 258, styles in public/app.css ~lines 820-833: .modal-panel.away { width: min(560px, 100%) }, .aw-body, .aw-list) overflows out of the screen. Fix it so it always fits the viewport: the panel is a flex column with max-height: calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 24px) and max-width: calc(100vw - 24px), the header and footer stay fixed, and .aw-body is the only scrolling area (overflow-y:auto, overscroll-behavior:contain, -webkit-overflow-scrolling:touch). There's no horizontal overflow: add min-width:0 on flex children, overflow-wrap:anywhere on .aw-proj h3 and on task titles, let long titles wrap to two lines (not a single nowrap line), the h3 link and small text wrap under the title on narrow widths, and <time> stays compact. On phones (<600px) present it as a bottom sheet consistent with the other modals if they already do that, with safe-area bottom padding. Also check the other modals (Connections, Usage, Server, Queue, the fallbacks sheet, the lightbox) for the same overflow at 375x667 and 390x844, and fix any that overflow the same way. Verify with bin/shot.mjs --mobile screenshots at 375x667 and 390x844 on a test server (separate port, CW_DATA_DIR=$(mktemp -d), CW_NO_ORCHESTRATOR=1) seeded with a long away-summary (many tasks, very long titles and paths). In each screenshot, use Playwright to assert the panel's getBoundingClientRect() stays within the viewport and that document.documentElement.scrollWidth <= innerWidth.

## Done when

A Playwright check at 375x667 and 390x844 shows #awayModal's panel fully inside the viewport with no horizontal scroll (scrollWidth <= innerWidth), and `npm test` passes

## Result — done (check passed) (2026-09-26 06:10)

AGENT-ORCH-STATUS: done — Away sheet and all modals fit phone screens; tests pass
