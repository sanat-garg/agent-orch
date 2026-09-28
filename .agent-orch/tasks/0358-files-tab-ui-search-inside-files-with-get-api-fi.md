# Task #358: Files tab ui: search inside files with GET /api/files/grep and a Names | Contents switch

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:35  
- files: files.mjs, public/files.js, public/files.css, test/files.test.mjs

## Prompt

Feature, building on #331 (find files by name). The Files tab (public/files.js, server side files.mjs which has its own router `handleFiles`, so server.mjs is NOT touched) can find files by name via `GET /api/files/find?cid=&q=`. Add finding text inside files.

Server (files.mjs):
1. Refactor `findFiles`'s directory walk into a shared helper (same skip rules: `.git`, `node_modules`, `.agent-orch-worktrees`, hidden folders unless the query starts with a dot, links out of the project ignored, `FIND_VISIT_MAX` visited entries) so both find and grep use it; keep `findFiles`'s output identical (its tests must still pass).
2. `export async function grepFiles(rootDir, q, {max = 200, fileMax = 1024 * 1024} = {})` → `{q, hits: [{path, line, text}], files, truncated}`: case-insensitive substring match, one hit per matching line, `text` is the line trimmed to 200 chars around the match, `line` is 1-based. Only regular files up to `fileMax` bytes are read; a file whose first 8 KB contains a NUL byte is skipped as binary. Stop with `truncated: true` at `max` hits or at the visit cap. Yield to the event loop every ~50 files (`await new Promise((r) => setImmediate(r))`) so a big project doesn't freeze the 1-core server. `files` is the number of files searched.
3. Route `GET /api/files/grep?cid=<chat>&q=<text>` in `handleFiles` (the regex becomes `(list|raw|find|grep)`): q of 2+ characters (400 otherwise), 200 max in length, only for a known chat like the others. `handleFiles` may need to await grep: make the grep branch `await` and keep the sync branches as they are (the function can become async; check how server.mjs calls it, `if (handleFiles(...)) return` style must still work, e.g. return `true` synchronously and let the async work run inside with its own try/catch that answers the response). Document the new endpoint in the header comment.

UI (public/files.js, public/files.css):
4. Beside the existing 'Search project' button (`#fxFindBtn`) add a small segmented control `Names | Contents` (`.fx-mode`, `aria-pressed`, 44px targets in the existing `(pointer: coarse)` blocks, 16px field rule unchanged). Enter in the field and the button search in the chosen mode; remember the mode in `store` under `cw.files.mode`.
5. Contents results reuse the find results view (`fxFound`): rows grouped by file (path, then each hit as `line · text` with the match wrapped in `<mark>`), `files searched` and a truncation note in the footer like find's. Tap/Enter on a hit opens Quick Look on that file (existing `fxQuickLook`-style function; scrolling to the line is optional) and Escape/clearing exits as find does. No new global function names that already exist in another public/*.js file (test/ui-static.test.mjs rejects duplicates).

Tests in test/files.test.mjs: `grepFiles` finds a line in a nested file with the right path/line/text, is case-insensitive, skips a binary file and a file over fileMax, stops at `max` with `truncated: true`; `GET /api/files/grep` returns 400 under 2 characters, 404 for an unknown chat and hits for a known one (copy the existing `/api/files/find` test's server setup). Verify with `node --test test/files.test.mjs test/ui-static.test.mjs`; never import server.mjs directly in a test (spawn it on a free port as the neighbours do).

## Done when

`node --test test/files.test.mjs test/ui-static.test.mjs` passes and `grep -n "grepFiles" files.mjs` prints at least one line and `grep -n "api/files/grep" public/files.js` prints at least one line

## Result — done (check passed) (2026-09-28 12:40)

AGENT-ORCH-STATUS: done — Files tab can now search inside files in Contents mode
