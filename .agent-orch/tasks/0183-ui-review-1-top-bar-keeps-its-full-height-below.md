# Task #183: UI-REVIEW #1: top bar keeps its full height below the iPhone safe-area inset

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-26 10:52  
- files: public/app.css, test/ui-static.test.mjs, .agent-orch/UI-REVIEW.md, .agent-orch/shots/

## Prompt

Read finding #1 in .agent-orch/UI-REVIEW.md. In public/app.css, `.topbar` is `height: 56px` with `padding-top: env(safe-area-inset-top)` under border-box, so in the standalone iOS PWA (inset ~47-59px) its content box shrinks to nearly 0. The hamburger, title and Chat/Terminal switch then spill below the bar. Fix both the base `.topbar` rule and the mobile `@media` rule so that the bar is `height: calc(56px + env(safe-area-inset-top, 0px))` with the padding-top kept, and make sure anything positioned relative to the top bar's height (drawers, sidebars, toasts, the terminal view, any `top: 56px` or `calc(... 56px ...)`) also adds the inset. CSS only; don't touch app.js. Verify with playwright-core like the review did (see how test/ui-shots.test.mjs launches it): inject `env()` values by overriding with a test style (e.g. set a CSS custom property fallback, or add a style `.topbar{padding-top:59px}` plus the same height calc) at 390x844, and check that `#openSidebar`'s bounding box lies fully inside `.topbar`'s. Save the screenshot as .agent-orch/shots/ui-fix-1-safe-area.png. Add a static assertion to test/ui-static.test.mjs that app.css contains `calc(56px + env(safe-area-inset-top` for .topbar. Then mark #1 as done in UI-REVIEW.md (append '(fixed in task #<id>)' to its Finding cell).

## Done when

`node --test test/ui-static.test.mjs` passes and `grep -q 'calc(56px + env(safe-area-inset-top' public/app.css`
