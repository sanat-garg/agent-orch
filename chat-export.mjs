// A chat as Markdown, to take a conversation out of agent-orch (GET /api/convos/:id/export.md, the sidebar ⋯ menu's
// 'Export as Markdown'). Events are a whole chat log as server.mjs writes it (chat-log.mjs's header: one JSON event per line).
//   chatMarkdown(events, {title, cwd, agent, now}) → '# <title>\n\nFolder: `<cwd>` · Exported <YYYY-MM-DD>\n' then, in order:
//     a prompt ({t:'user'})           → '## You' + its text, attachments as their file names
//     a reply ({t:'text'})            → '## <agent>' (default 'Claude') once per turn + its text
//     a tool call ({t:'tool_use'})    → '> Tool: <name> — <short input summary>' (never its output)
//     a commit ({t:'commit'})         → 'Commit <short sha>'
//   Everything else (results, notices, tool output, images, streaming and control events, a sub-agent's work) is skipped.
//   exportFileName(title) → '<title>.md', safe for a Content-Disposition header and any file system.

const SUMMARY_MAX = 120;
const oneLine = (s, max = SUMMARY_MAX) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
// The input field that says what a call did: the command, file, pattern, address or query; else its first string.
const SUMMARY_KEYS = ['command', 'cmd', 'file_path', 'path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill'];
export function toolSummary(input) {
  if (input == null) return '';
  if (typeof input !== 'object') return oneLine(input);
  for (const k of SUMMARY_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return oneLine(v);
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return oneLine(v.join(' '));
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v.trim());
  return first ? oneLine(first) : '';
}

export function chatMarkdown(events, { title, cwd, agent = 'Claude', now = Date.now() } = {}) {
  const out = [`# ${oneLine(title, 200) || 'Untitled chat'}`, '', `${cwd ? `Folder: \`${cwd}\` · ` : ''}Exported ${new Date(now).toISOString().slice(0, 10)}`];
  let who = null; // whose section the last block went under
  const section = (name) => { if (who !== name) out.push('', `## ${name}`); who = name; };
  for (const ev of events || []) {
    if (!ev || typeof ev !== 'object' || ev.sub) continue;
    if (ev.t === 'user') {
      who = null; // every prompt gets its own heading, even two in a row
      section('You');
      if (ev.text?.trim()) out.push('', ev.text.trim());
      const names = (ev.attachments || []).map((a) => a?.name).filter(Boolean);
      if (names.length) out.push('', `Attachments: ${names.join(', ')}`);
    } else if (ev.t === 'text' && ev.text?.trim()) {
      section(agent);
      out.push('', ev.text.trim());
    } else if (ev.t === 'tool_use' && ev.name) {
      section(agent);
      const sum = toolSummary(ev.input);
      out.push('', `> Tool: ${ev.name}${sum ? ` — ${sum}` : ''}`);
    } else if (ev.t === 'commit' && typeof ev.sha === 'string' && ev.sha) {
      section(agent);
      out.push('', `Commit ${ev.sha.slice(0, 7)}`);
    }
  }
  return out.join('\n') + '\n';
}

export function exportFileName(title) {
  const base = String(title ?? '').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 100).trim();
  return `${base || 'chat'}.md`;
}
