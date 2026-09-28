# Task #475: Images open fully fitted in their original aspect ratio, with no scrolling

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 17:57  
- files: public/app.js, public/app.css, test/ui-lightbox-fit*.test.mjs

## Prompt

Screenshots in the task drawer (and chat) open in the lightbox at 'Actual size' by default (per #157), so large images need scrolling. Change it (public/app.js lightbox and image grid, app.css): 1) The lightbox default is FIT: the whole image is visible at once, scaled down to fit the available viewport (minus the header/caption and the safe areas) with object-fit: contain, preserving its original aspect ratio, and never upscaled beyond its natural size. There are no scrollbars in fit mode. 2) Keep the toggle to 'Actual size' (it scrolls/pans there, with pinch-zoom on phones), remember the choice only for the current lightbox session, and make a double-click or double-tap toggle between Fit and Actual size. The caption shows the pixel size. 3) Drawer and chat thumbnails show the WHOLE image: keep the uniform thumbnail box, but switch to object-fit: contain (letterboxed on a subtle background) instead of cover/top cropping. 4) Tests: a 2400×1600 image opens in fit mode with rendered width ≤ the viewport and aspect ratio preserved (within 1%), and no scroll overflow in the lightbox; a small 300×200 image isn't upscaled; the toggle switches to actual size; thumbnails use contain. Run only the touched test files.

## Done when

`node --test test/ui-lightbox-fit*.test.mjs` passes (fit default without overflow, aspect preserved, no upscaling, toggle works, thumbnails contain)
