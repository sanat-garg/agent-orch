# Task #402: Machines: organise each machine's options with plain words

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 13:51  
- files: public/app.js, public/app.css, test/ui-machines-settings*.test.mjs, test/ui-static.test.mjs

## Prompt

The owner finds the options at the bottom of each machine card in the Machines view (public/app.js, app.css) cluttered and confusing; e.g. 'Power' doesn't explain itself. Redesign that area: 1) Group the controls into at most 3 short labelled sections, collapsed behind a single 'Machine settings' disclosure (with a gear icon), so the card itself shows only its status, usage and running tasks: 'Work' (Parallel tasks: Auto / N, and Run tasks on this machine on/off, which replaces Enable/Drain wording: 'Accept new tasks' vs 'Finish current tasks, then stop'), 'Staying awake' (replacing 'Power': 'Keep this Mac awake while it's connected', with a one-line hint that closing the lid still sleeps it; drop the battery and thermal options the owner no longer wants, since placement ignores battery per BRIEF goal 9), and 'Manage' (Rename, Finish sound if present, Remove from cluster, with a confirmation). 2) Every control has plain-language labels plus one-line hints (no jargon like 'drain', 'policy' or 'thermal'); dangerous actions are red and separated. 3) Consistent row heights, 44pt targets on phones, and the theme variables used. 4) Update the static UI test ids and take screenshots via bin/shot.mjs on desktop and 390px with seeded nodes. Test: the settings disclosure contains the three sections with the new labels; 'Power' no longer appears in the Machines UI. Run only the touched test files.

## Done when

`node --test test/ui-machines-settings*.test.mjs test/ui-static.test.mjs` passes, and `! grep -n ">Power<" public/app.js public/index.html`
