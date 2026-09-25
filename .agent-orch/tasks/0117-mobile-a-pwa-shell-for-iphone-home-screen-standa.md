# Task #117: Mobile A: PWA shell for iPhone home screen (standalone, safe areas, icons)

- kind: work  
- source: planner  
- priority: 20 (background)  
- created: 2026-09-25 14:02  
- starts after: #116

## Prompt

Implement group A from .agent-orch/MOBILE.md: iPhone home-screen PWA polish. This includes: manifest (name 'agent-orch', short_name, display standalone, theme/background colours for light and dark, start_url/scope, maskable + apple-touch icons at 180px and friends generated from public/icon.svg, e.g. with Playwright rendering, into public/icons/); index.html and login.html meta (viewport-fit=cover, apple-mobile-web-app-capable, status-bar-style black-translucent, apple-mobile-web-app-title, theme-color with media queries); env(safe-area-inset-*) padding on the header, footer, composer and drawers; 100dvh instead of 100vh; no rubber-band scrolling of the whole shell (only the content scrolls); and the login session persisting in standalone mode (standalone iOS has separate storage, so make the session long-lived). Serve the new icon types with correct MIME in server.mjs. Verify with iPhone-emulated screenshots before and after in .agent-orch/shots/. Mark the group A items in MOBILE.md Fixed or Deferred.

## Done when

public/manifest.webmanifest has display standalone and a 180px apple-touch icon exists and is linked from index.html with viewport-fit=cover, and `npm test` passes
