// Chat search: find conversations whose title or messages contain every whitespace-separated term of a query
// (case-insensitive). Read-only over <DATA>/logs/<id>.jsonl, one line at a time, at most maxBytes per log, so a huge
// log is never loaded whole; a missing log, a corrupt line or a line cut by the byte cap is skipped, never thrown.
//   searchConvos({ logsDir, convos, q, limit = 20, perConvo = 3, maxBytes = 4 MB })
//     → [{ id, title, at, hits: [{ role, at, snippet }] }], newest hit first, at most `limit` conversations.
// Only message text is searched: log lines {t:'user'|'text', text, ts} (the chat's own events) and SDK-shaped
// {role|message.role, content} lines, where content is a string or [{type:'text', text}] parts; tool calls, tool
// results, images and base64 are skipped. A message is a hit when it holds every term the title lacks (any term once
// the title holds them all); a conversation matches on hits or a title holding every term, and a title-only match
// is dated by its updatedAt. Each conversation keeps its newest `perConvo` hits, with a ~120-char snippet around
// the first match. Logs are read newest-updated first and the scan stops once no unread chat can outrank the top
// `limit` (a chat's updatedAt bounds its newest message). A query under 2 characters returns [].
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const SNIPPET = 120;

// The searchable text and role of one log line, or null when it carries none.
function messageOf(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const at = Number(ev.ts ?? ev.timestamp ?? ev.at) || 0;
  if (ev.t === 'user' || ev.t === 'text') {
    return typeof ev.text === 'string' && ev.text ? { role: ev.t === 'user' ? 'user' : 'assistant', at, text: ev.text } : null;
  }
  const msg = ev.message && typeof ev.message === 'object' ? ev.message : ev;
  const role = msg.role || ev.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const c = msg.content ?? msg.text;
  const text = typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n')
    : '';
  return text ? { role, at, text } : null;
}

// ~SNIPPET chars of `text` around the earliest match of any term, whitespace collapsed, with the match kept whole.
function snippetOf(text, terms) {
  const flat = text.replace(/\s+/g, ' ').trim(), low = flat.toLowerCase();
  let idx = -1, len = 0;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0 && (idx < 0 || i < idx)) { idx = i; len = t.length; }
  }
  if (idx < 0 || flat.length <= SNIPPET) return flat.slice(0, SNIPPET);
  let start = Math.max(0, idx - Math.floor((SNIPPET - len) / 2));
  const end = Math.min(flat.length, Math.max(start + SNIPPET, idx + len));
  start = Math.max(0, Math.min(start, end - SNIPPET));
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

// The newest `perConvo` hits in one log (newest first); [] when the log is missing or unreadable.
async function scanLog(file, need, terms, perConvo, maxBytes) {
  const hits = [];
  let stream;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8', start: 0, end: Math.max(0, maxBytes - 1) });
    const failed = new Promise((_, reject) => stream.once('error', reject));
    failed.catch(() => {});
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const lines = rl[Symbol.asyncIterator]();
    for (;;) {
      const { value: line, done } = await Promise.race([lines.next(), failed]);
      if (done) break;
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const m = messageOf(ev);
      if (!m) continue;
      const low = m.text.toLowerCase();
      if (!(need.length ? need.every((t) => low.includes(t)) : terms.some((t) => low.includes(t)))) continue;
      hits.push({ role: m.role, at: m.at, snippet: snippetOf(m.text, terms) });
      if (hits.length > perConvo) hits.shift();
    }
  } catch {
    return [];
  } finally {
    stream?.destroy();
  }
  return hits.sort((a, b) => b.at - a.at);
}

export async function searchConvos({ logsDir, convos, q, limit = 20, perConvo = 3, maxBytes = 4 * 1024 * 1024 } = {}) {
  const terms = [...new Set(String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean))];
  if (String(q ?? '').trim().length < 2 || !terms.length || !(limit > 0)) return [];
  const list = (Array.isArray(convos) ? convos : []).filter((c) => c && c.id != null && !/[/\\]|^\.\.?$/.test(String(c.id)));
  // Newest-updated first; a chat without updatedAt can't be bounded, so it is read before any that can.
  const bound = (c) => (Number.isFinite(c.updatedAt) ? c.updatedAt : Infinity);
  list.sort((a, b) => bound(b) - bound(a));
  const out = [];
  for (const c of list) {
    if (out.length >= limit && bound(c) < out[limit - 1].at) break;
    const title = String(c.title ?? ''), lowTitle = title.toLowerCase();
    const need = terms.filter((t) => !lowTitle.includes(t));
    const hits = perConvo > 0 ? await scanLog(path.join(logsDir, `${c.id}.jsonl`), need, terms, perConvo, maxBytes) : [];
    if (!hits.length && need.length) continue;
    const at = hits.length ? hits[0].at : Number(c.updatedAt ?? c.createdAt) || 0;
    out.push({ id: c.id, title, at, hits });
    out.sort((a, b) => b.at - a.at);
  }
  return out.slice(0, limit);
}
