# Task #86: Click-to-copy for terminal commands shown in chat

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 10:08  
- starts after: #85

## Prompt

In the chat interface (public/app.js, public/app.css), make every displayed terminal command copy to the clipboard on click. This covers: (a) the tool lines for Bash tool calls (toolLine()/renderOutput, 'Ran `…`'), in both chat and the task drawer; (b) fenced code blocks in rendered markdown whose language is bash/sh/shell/zsh/console, or whose lines start with '$ ' (strip the '$ ' prompt when copying); (c) inline `code` spans in assistant messages that look like a shell command (heuristic: starts with a known command such as git, npm, npx, node, python, sudo, cd, ls, codex, agy, claude, gh, tmux or systemctl, or contains ' && '/' | '). Use one delegated click handler; no per-element listeners on every re-render. Use navigator.clipboard.writeText with a textarea+execCommand fallback (the app may be served over plain http). Show brief feedback: a 'Copied' tooltip/flash on the element for about 1.2s, a pointer cursor, and a subtle copy icon on hover for code blocks. Don't break text selection: skip the copy if the user dragged to select text (window.getSelection().toString() is not empty). Links inside code must still work.

## Done when

`node --check public/app.js && npm test` passes, and public/app.js contains a single delegated click-to-copy handler that covers tool command lines, shell code blocks and inline command code

## Result — done (check passed) (2026-09-25 10:18)

AGENT-ORCH-STATUS: done — Shell commands, code blocks and inline commands now copy on click
