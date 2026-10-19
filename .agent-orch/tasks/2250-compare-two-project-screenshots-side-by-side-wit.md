# Task #2250: Compare two project screenshots side by side, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:17  
- files: public/shots.js, public/shots.css, test/ui-shot-compare.test.mjs

## Prompt

Extend public/shots.js and shots.css so the owner can select exactly two existing screenshots and open a comparison within the gallery. Borrow the comparison idea from stravu/crystal and visual review patterns from BloopAI/vibe-kanban; use patterns only. Reuse SH.list and the existing media endpoint, preserving gallery ordering, lightbox and task navigation. Label each image with its task, name and time; preserve aspect ratios, use side-by-side panels on desktop and stacked panels on phones, and provide Clear/Back controls. Reset selection when the project changes. Require two distinct images and show 'No longer available' if either image fails to load. No image processing or backend changes. Add focused tests for selection/comparison, a missing image, and project switching.

## Done when

`npm test -- test/ui-shot-compare.test.mjs` passes.
