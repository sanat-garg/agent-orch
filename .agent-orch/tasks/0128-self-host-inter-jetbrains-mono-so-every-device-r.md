# Task #128: Self-host Inter + JetBrains Mono so every device renders the same font

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 19:36

## Prompt

The UI currently uses the system font stack (public/app.css line ~83 body font: ui-sans-serif, -apple-system, 'Segoe UI', system-ui, Roboto, sans-serif; public/login.css ~line 40 the same; --mono at app.css line ~28 starts with ui-monospace, SFMono-Regular). On a Mac that renders San Francisco, while the server's headless-Chromium screenshots fall back to WenQuanYi Zen Hei, so they never match. The owner wants ONE consistent designed font everywhere. 1) Download the Inter variable font (woff2, weights 100-900 plus the italic variable) and JetBrains Mono (woff2 variable) from their official releases (rsms/inter and JetBrains/JetBrainsMono GitHub releases; both are OFL) into public/fonts/, and include their OFL license files there. 2) Add @font-face rules (font-display: swap, unicode-range for Latin plus Latin-ext) in a shared public/fonts.css linked from index.html and login.html before the other CSS, with <link rel=preload as=font type=font/woff2 crossorigin> for the regular Inter file. 3) Change the stacks so the bundled fonts come FIRST: body 'Inter', 'InterVariable', then a neutral fallback (Helvetica Neue, Arial, sans-serif). Do NOT list -apple-system/system-ui/ui-sans-serif before Inter. --mono becomes 'JetBrains Mono' first, then ui-monospace, Menlo, Consolas, monospace. Update login.css and any other hardcoded font-family (e.g. login.css line ~62) to use the vars. Enable Inter's nicer features: font-feature-settings 'cv11', 'ss01' is optional, but at least keep tabular numbers ('tnum') for the usage and metric numbers. 4) Serve .woff2 with Content-Type font/woff2 and long immutable cache headers in server.mjs, and make sure the login page can load the fonts without a session. 5) Install the same fonts on the server for screenshots (copy the TTF/OTF versions to ~/.local/share/fonts or /usr/local/share/fonts, then fc-cache -f) so bin/shot.mjs output matches. 6) Verify: take a screenshot with bin/shot.mjs of the login page and chat on a test server (separate port, CW_DATA_DIR=$(mktemp -d), CW_NO_ORCHESTRATOR=1), and check with Playwright that document.fonts.check('15px Inter') is true after load.

## Done when

public/fonts/ contains Inter and JetBrains Mono woff2 files, `grep -n "font:" public/app.css | head -1` shows 'Inter' before any system font, `npm test` passes, and a Playwright check of document.fonts.check('15px Inter') on the test server returns true
