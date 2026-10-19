# Task #2231: Zen mode: a distraction-free coding view

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-10-19 14:08  
- files: public/app.js, public/app.css, public/index.html, test/ui-zen*.test.mjs

## Prompt

Add Zen mode (public/app.js, app.css, index.html): a distraction-free view for focused coding. 1) Toggle: Ctrl/Cmd+. and a small 'Zen' button in the header; Esc (when no modal or input-specific Esc applies) or the same shortcut exits. It's remembered per device (localStorage) across reloads. 2) In Zen: hide the sidebar, the orchestrator bar, the usage/machines cards, header extras (repo link, badges, the version label), the queue and lane chips, and all toasts. Keep ONLY the current view (Chat, Files or Terminal) at full height, with content centred at a comfortable reading width for chat (~760px) and full width for Terminal/Files, plus a minimal top line with the project name, the view switcher (Chat/Files/Terminal) and a faint 'Zen · Esc to exit'. Use a calmer palette (slightly dimmed chrome, more whitespace) and smooth 200 ms transitions (none under prefers-reduced-motion). 3) Quiet: task-completion sounds are muted, and push/notifications are held, EXCEPT items that need the owner (approval requests, failed tasks, review checkpoints), which show as one subtle line at the top ('1 approval waiting'), tappable. 4) On exit, a small sheet summarises 'While you were in Zen': tasks finished, failed or awaiting the owner since entering (reuse digest.mjs if it fits), and it dismisses. 5) It works on phones (Zen hides the header extras and the orch bar; the composer stays). Tests: the shortcut toggles a .zen class on #app and persists it; in Zen the sidebar/orchBar are hidden and no toast element appears for a task-done event; an approval event shows the quiet line; exiting shows the summary with the counts. Run only the touched test files.

## Done when

`node --test test/ui-zen*.test.mjs` passes (toggle and persistence, chrome hidden, toasts and sounds suppressed, approval line shown, exit summary)

## Result — done (check passed) (2026-10-19 14:19)

AGENT-ORCH-STATUS: done — Zen mode added; ui-zen tests pass; three older UI test failures unchanged
