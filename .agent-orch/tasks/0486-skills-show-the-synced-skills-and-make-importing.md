# Task #486: Skills: show the synced skills and make importing new ones simple

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 18:10  
- files: extensions.mjs, public/ext.js, public/ext.css, server.mjs, test/skills-synced*.test.mjs, test/skills-import*.test.mjs

## Prompt

The owner imported skills, but Settings → Skills doesn't show them. The planner found them on disk: ~/.claude/skills/synced/<account-bucket-id>/<skill>/SKILL.md (12 skills: morning, docs, deep-research, computer-use, docx, skill-creator, pdf, pptx, xlsx, built-in-browser, import-memory and more), plus ~/.claude/skills/apple-design. extensions.mjs listSkills() (~line 172) scans only ONE level under ~/.claude/skills and ~/.codex/skills, so 'synced' (with no SKILL.md) hides everything nested. Fix: 1) Discovery: also scan ~/.claude/skills/synced/*/ (and any nested bucket folders one level down that contain skill folders), ignoring dot-entries ('.bucket-*', '.last-complete-round'). Show those as source 'Synced from your Claude account' (read-only in agent-orch: no edit or delete, with an explanation), while local skills stay editable. Make sure synced skills also flow to workers in the extension sync (#248) if appropriate, or are labelled as head-only. 2) Simpler import in the Skills UI (public/ext.js): one 'Add skill' button with three options: paste a GitHub URL (a repo, a folder in a repo, or a raw SKILL.md; fetch it and install into ~/.claude/skills/<name>, plus optionally ~/.codex/skills), upload a .zip or .skill file (and drag-and-drop onto the list), or 'Create from scratch' (the existing editor). Validate that SKILL.md has name and description frontmatter, and show a preview (name, description, files) before installing. Tests: the nested synced skills are listed with the synced source; dot entries are ignored; import from a zip installs and lists; a GitHub-URL import is tested with a mocked fetch; synced skills refuse edit/delete. Run only the touched test files.

## Done when

`node --test test/skills-synced*.test.mjs test/skills-import*.test.mjs` passes (nested synced skills listed, dot entries ignored, zip and URL import, synced read-only)
