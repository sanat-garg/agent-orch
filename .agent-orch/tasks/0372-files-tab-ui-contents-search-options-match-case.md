# Task #372: Files tab ui: Contents search options: match case, whole word and regular expression

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:54  
- files: files.mjs, public/files.js, public/files.css, test/files.test.mjs

## Prompt

Feature on the Files tab's Contents search (#358): files.mjs grepFiles and public/files.js. Backend: `GET /api/files/grep?cid=&q=&cs=1&w=1&re=1` (each flag optional). cs=1 matches case-sensitively (today everything is lower-cased); w=1 matches whole words only (\b on both sides, or non-word neighbours for a needle that starts/ends with a non-word char); re=1 treats q as a JavaScript regular expression (flags 'g' plus 'i' unless cs, no 'u' surprises: catch a SyntaxError and answer 400 {error: 'Invalid regular expression: …'}; cap q at 200 chars as today; guard against catastrophic patterns by rejecting nested quantifiers like `(a+)+` with a simple check, and stop after `max` hits as today). Build one matcher per request (a function line → index|-1 and match length) so the loop stays one pass per file; every hit keeps {path, line, text} and the snippet centres on the actual match length. Update the header comment and handleFiles query parsing. UI in files.js: when FX.mode is 'contents' show three small toggle chips next to the Names | Contents switch: 'Aa' (match case), 'ab' (whole word), '.*' (regex), each aria-pressed, persisted in store under cw.files.grep.{cs,w,re}, 44px targets under pointer: coarse (files.css), and pass them as query flags; an invalid regex shows the server's error in the results area. Tests in test/files.test.mjs for grepFiles: case-sensitive miss vs hit, whole word (`cat` does not match `concat`), regex `f(oo|aa)r` hits, invalid regex → 400 through handleFiles. Keep `npm test -- test/ui-static.test.mjs` green (no duplicate function names). Run only those two test files while working.

## Done when

`npm test -- test/files.test.mjs test/ui-static.test.mjs` passes and `grep -q 'whole word' files.mjs`
