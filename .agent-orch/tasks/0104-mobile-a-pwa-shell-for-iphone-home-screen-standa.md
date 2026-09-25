# Task #104: Mobile A: PWA shell for iPhone home screen (standalone, safe areas, icons)

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 13:22  
- starts after: #103

## Prompt

Implement group A from .agent-orch/MOBILE.md: iPhone home-screen PWA polish. This includes: manifest (name 'agent-orch', short_name, display standalone, theme/background colours for light and dark, start_url/scope, maskable + apple-touch icons at 180px and friends generated from public/icon.svg, e.g. with Playwright rendering, into public/icons/); index.html and login.html meta (viewport-fit=cover, apple-mobile-web-app-capable, status-bar-style black-translucent, apple-mobile-web-app-title, theme-color with media queries); env(safe-area-inset-*) padding on the header, footer, composer and drawers; 100dvh instead of 100vh; no rubber-band scrolling of the whole shell (only the content scrolls); disabling text-size-adjust quirks; and the login cookie persisting in standalone mode (check cookie attributes; standalone iOS has separate storage, so make the session long-lived). Serve the new icon types with correct MIME in server.mjs. Verify with iPhone-emulated screenshots before and after in .agent-orch/shots/.

## Done when

public/manifest.webmanifest has display standalone and a 180px apple-touch icon exists and is linked from index.html with viewport-fit=cover, and `npm test` passes
