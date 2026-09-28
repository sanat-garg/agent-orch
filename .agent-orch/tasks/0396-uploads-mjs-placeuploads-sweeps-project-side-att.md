# Task #396: uploads.mjs: placeUploads sweeps project-side attachment copies older than 30 days

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 13:14  
- files: uploads.mjs, test/attachments.test.mjs

## Prompt

uploads.mjs `placeUploads(dataDir, ids, cwd)` copies each attachment into `<cwd>/.agent-orch/uploads/<id8>-<name>` (git-ignored by the folder's own .gitignore) and nothing ever removes those copies, so every project accumulates every file the owner ever attached. Add an exported `sweepProjectUploads(cwd, {maxAgeMs = 30 days, keep = []} )` that deletes files in that folder (never the .gitignore, never directories, never anything outside it) whose mtime is older than maxAgeMs and whose name does not start with an id prefix in `keep`, returning the removed names; it must swallow a missing folder and per-file errors. Call it from placeUploads before copying, with `keep` = the ids being placed (so a re-sent old attachment survives), and export the constant. Copies are a convenience for the agent, so a swept copy is simply re-copied next time it is placed (readUpload still has the original under <DATA>/uploads until retention prunes it). Tests in test/attachments.test.mjs (extend the placeUploads test or add one): seed two copies with an old mtime via fs.utimesSync, one of them for an id being placed; assert the other is removed, the placed one and the .gitignore stay, a fresh copy stays, and a missing folder returns []. Update the module header. Run only `npm test -- test/attachments.test.mjs`.

## Done when

`npm test -- test/attachments.test.mjs` && `grep -q 'export function sweepProjectUploads' uploads.mjs`
