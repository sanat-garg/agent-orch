# Task #126: Queue window: wider, indented dependents, new waiting/limited glyphs

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 19:30

## Prompt

Polish the Queue modal (public/index.html #queueModal ~line 293, list styles .q-list/.q-card in public/app.css ~line 1059, card glyphs .tc-glyph in app.css ~lines 700-715, and the rendering in public/app.js). 1) Width: on desktop the queue modal panel is width: min(760px, 92vw) or so, wide enough that typical task titles (~80-100 characters) show in full on one or two lines. Titles wrap instead of truncating with an ellipsis (remove nowrap/ellipsis on the card title inside the queue; keep the full title in title=). On phones it stays a full-width sheet. 2) Dependency indent: render the queue as a tree. A task whose depends_on points at another task in the list is rendered directly under its prerequisite, indented by ~16px per level (cap it at 3 levels, then keep 48px). A thin vertical/elbow connector line in var(--border-strong) runs from the parent to the child card (CSS ::before on the indented card, not images). Drag-and-drop still moves a card with its whole subtree, and the drop slots respect the indentation. 3) Glyphs: replace the dashed-border circle for waiting-on-a-prerequisite (.tc-glyph.waiting::before { border-style: dashed }) with a small inline SVG hourglass icon (~12px, currentColor, muted var(--faint)). Replace the dotted warn circle for .tc-glyph.limited with a small pause icon (two bars) in var(--warn). Keep queued (solid ring), running (spinner) and done (check) as they are. Apply the same glyphs everywhere taskCard() is used, including the chat receipts, the drawer and the queue. Screenshot the queue modal on desktop and at 390px with bin/shot.mjs (test server on a separate port, CW_DATA_DIR=$(mktemp -d), CW_NO_ORCHESTRATOR=1, with seeded tasks that include a 3-level dependency chain).

## Done when

`node --check public/app.js && npm test` passes, `! grep -nE "tc-glyph\.(waiting|limited)::before \{[^}]*(dashed|dotted)" public/app.css`, and a desktop queue screenshot in .agent-orch/shots/ shows indented dependents
