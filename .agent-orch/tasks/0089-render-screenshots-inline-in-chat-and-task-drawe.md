# Task #89: Render screenshots inline in chat and task drawer with a lightbox

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 10:18  
- starts after: #88

## Prompt

Frontend for agent screenshots (public/app.js, public/app.css, public/index.html). Render {k:'image', id, name} events (see the previous task's backend; images come from /api/media/:id) inline in: live chat streams, reloaded chat history, and the task drawer ('What happened' shows the latest screenshots of the run, up to 4 thumbnails, with the rest under Details → Commands and output). Show thumbnails at max ~320px wide, lazy-loaded (loading=lazy), with rounded corners and a caption with the file name. Group consecutive images into a small grid. Clicking one opens a lightbox modal (reuse the .modal pattern) with the full-size image, prev/next through all images in that chat or task (arrow keys), Esc to close, and an 'Open original' link. Handle a broken or missing image gracefully with a placeholder. Extend the static UI smoke test if you add new ids. Test on a separate port with CW_DATA_DIR=$(mktemp -d) and CW_NO_ORCHESTRATOR=1.

## Done when

`node --check public/app.js && npm test` passes, and app.js renders k:'image' entries as <img src="/api/media/…"> in both the chat and the task drawer code paths
