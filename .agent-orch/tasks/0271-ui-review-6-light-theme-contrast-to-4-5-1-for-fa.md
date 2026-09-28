# Task #271: UI-REVIEW #6: light-theme contrast to 4.5:1 for faint text and filled buttons, with a static contrast test

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 05:17  
- files: public/app.css, public/login.html, test/ui-contrast.test.mjs, .agent-orch/UI-REVIEW.md

## Prompt

Fix row 6 of .agent-orch/UI-REVIEW.md. In public/app.css the light theme's `--faint: #9a968c` on `--bg: #faf9f5` is 2.8:1 and white on `--accent: #c96442` is 3.9:1. Darken the light-theme `--faint` to about #7a766c (verify ≥ 4.5:1 against both --bg and white with the WCAG formula), and add a `--accent-strong` (about #b3532f, ≥ 4.5:1 with white) used as the background of `.btn.primary` and `.send` (keep `--accent` for text, borders and the dark theme unchanged; adjust the hover token so hover still darkens). Check the dark theme's tokens with the same formula and leave them alone if they already pass. Add test/ui-contrast.test.mjs: a pure Node test (no browser) that parses the `:root` and `prefers-color-scheme: dark` token blocks out of public/app.css, computes WCAG contrast, and asserts --faint vs --bg ≥ 4.5 and --accent-text (or white) vs --accent-strong ≥ 4.5 for the light theme. Then in .agent-orch/UI-REVIEW.md mark row 6 as fixed in place, and also mark rows 11, 12 and 17 as fixed (they already are: per-scheme theme-color and apple-touch-icon in index.html, `.st-switch` toggles, swipe-to-dismiss toasts); for row 11 also add the light `theme-color` meta with a media query to public/login.html to match index.html. Take a screenshot with bin/shot.mjs (see README 'Screenshots') of the chat view before and after if Chromium is cached, and eyeball that nothing looks muddy.

## Done when

`node --test test/ui-contrast.test.mjs` and `grep -q 'accent-strong' public/app.css` and `grep -q 'prefers-color-scheme: light' public/login.html` and `grep -E '^\| 6 \|' .agent-orch/UI-REVIEW.md | grep -q fixed`
