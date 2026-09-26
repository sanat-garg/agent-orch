# Task #157: Screenshots: uniform thumbnails; click opens the image at original size

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 04:21

## Prompt

Agent screenshots in chat and in the task drawer render as thumbnails of different sizes. Standardise them: every thumbnail is a fixed 160×100 box (a 16:10 frame; on phones 2 per row filling the width, same aspect) with object-fit: cover, object-position top, rounded corners and a 1px border, arranged in a flex-wrap grid with an 8px gap, with a caption line truncated below. Clicking or tapping one opens the lightbox showing the image at its ORIGINAL pixel dimensions (natural width/height, no upscaling). If it's bigger than the viewport, the lightbox scrolls or pans in both directions instead of shrinking it, with a toggle 'Fit to screen' / 'Actual size' (default Actual size) and a caption showing its pixel size. Keep the prev/next, Esc and 'Open original' behaviours. Check the lightbox on mobile (pinch-zoom allowed inside it). Screenshots via bin/shot.mjs with seeded images of varied sizes.

## Done when

`node --check public/app.js && npm test` passes, and app.css defines a single fixed thumbnail size used by both the chat and drawer image grids
