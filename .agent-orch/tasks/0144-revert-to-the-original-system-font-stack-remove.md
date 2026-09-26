# Task #144: Revert to the original system font stack; remove bundled fonts

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 23:41  
- starts after: #140

## Prompt

The owner regrets the universal-font change and wants the ORIGINAL typography back. The self-hosted Inter/JetBrains Mono work (from the cancelled task #128) was accidentally committed inside commit 284ca64 (task #132). Undo only the font parts, not #132's other changes. Restore exactly: public/app.css body `font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", system-ui, Roboto, sans-serif;` and `--mono: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;`. In public/login.css, the body is `font: 15px/1.5 ui-sans-serif, -apple-system, "Segoe UI", system-ui, Roboto, sans-serif;` (it currently uses var(--sans); remove the --sans var if it was only added for this) and `.sub span { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; ... }`. Compare against `git show 284ca64^:public/app.css` and `git show 284ca64^:public/login.css` for every font-family/font declaration, including any font-feature-settings or letter-spacing added with the change. Remove public/fonts.css, the public/fonts/ directory, and the <link rel=stylesheet href=/fonts.css> and font preload links from index.html and login.html. Remove the woff2 route/MIME special-casing in server.mjs only if it was added by that change and nothing else uses it. Remove any fonts that change installed on the server for screenshots (check ~/.local/share/fonts and /usr/local/share/fonts for Inter/JetBrains files added today, then run fc-cache -f). Update README/.agent-orch docs that mention bundled fonts. Keep everything else (other styles and features) untouched.

## Done when

`! test -e public/fonts.css && ! test -d public/fonts && ! grep -rn "Inter\|fonts.css" public/*.html public/*.css` passes, `grep -n "font: 15px/1.55 ui-sans-serif, -apple-system" public/app.css` matches, and `npm test` passes

## Result — done (2026-09-26 02:43)

AGENT-ORCH-STATUS: done — Original fonts restored; required checks and tests pass
