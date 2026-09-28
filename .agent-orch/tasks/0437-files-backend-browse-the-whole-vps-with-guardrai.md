# Task #437: Files backend: browse the whole VPS, with guardrails for secrets and system folders

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 14:25  
- files: files.mjs, server.mjs, test/files-scope*.test.mjs

## Prompt

Extend the Files API (files.mjs + server.mjs, all login-protected) from project-root-only to the whole filesystem, while the UI still opens on the project folder by default. Contract (the UI task codes against it; keep it exact): every path parameter may be ABSOLUTE ('/home/ubuntu/x'); relative paths stay relative to the current project root. GET /api/files/list?dir=<abs|rel> → {dir, parent (null at '/'), entries:[{name, path, type, size, mtime, isSymlink, readable, writable, protected}], places:[{label:'Project', path}, {label:'Home', path:os.homedir()}, {label:'/', path:'/'}, {label:'/tmp', path:'/tmp'}]}. The existing read/preview/grep/find endpoints accept absolute paths too (grep/find limited to the chosen dir, with the existing caps). Guardrails: 1) Resolve with realpath and operate as the server's user (ubuntu); permission errors come back as {error: 'Permission denied'} and a listing marks unreadable entries. 2) PROTECTED (listed with protected:true, but no preview, download, copy, zip, move or delete): the agent-orch data dir's secrets (auth.json, secrets*, sessions*, *.db, push VAPID keys), ~/.ssh/*, ~/.claude/.credentials.json and ~/.claude.json, ~/.codex/auth.json, ~/.config/gh/hosts.yml, ~/.git-credentials, and any *.pem/*.key. Keep the list in one constant. 3) WRITE ops (copy, move, zip, unzip, rename/new/delete from #418 if present) are allowed only under the home dir and /tmp (and the project root); elsewhere they're read-only with {error: 'Read-only location'}. Never follow symlinks for write ops outside those roots. 4) Also skip huge dirs in listings gracefully (cap at 5000 entries, with a 'truncated' flag). Tests: listing '/' and a parent of the project works; protected files are listed but preview returns 403; a write op in /etc is refused; one under /tmp works; relative paths still resolve to the project. Run only the touched test files.

## Done when

`node --test test/files-scope*.test.mjs` passes (absolute listing incl. '/', protected preview 403, /etc write refused, /tmp write allowed, relative paths unchanged)
