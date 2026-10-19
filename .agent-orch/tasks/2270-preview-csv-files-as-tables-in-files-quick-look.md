# Task #2270: Preview CSV files as tables in Files Quick Look, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:35  
- files: public/files.js, public/files.css, test/ui-files-csv.test.mjs

## Prompt

Extend public/files.js Quick Look so .csv files offer Table and Source views using the existing bounded raw-file response. Keep changes within Quick Look helpers and scoped public/files.css rules, away from the Places favourites worker. Parse quoted commas, escaped double quotes, CRLF and multiline quoted fields; preserve cell text without evaluating it or treating it as HTML. Use numbered columns so the first record is not silently consumed as a header. Cap rendering at 200 rows and 50 columns, label limits and server truncation clearly, and retain Source for malformed or partial CSV with a readable explanation. Empty files need an empty state. Preserve Markdown/diff modes and editing. Inspiration: [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)'s integrated file exploration; the CSV view is our extension for office-work outputs. Add test/ui-files-csv.test.mjs covering quoted/multiline content, Source switching, malformed and empty input, bounded rendering and phone overflow. Use existing helpers and no new dependency.

## Done when

`npm test -- test/ui-files-csv.test.mjs` passes.
