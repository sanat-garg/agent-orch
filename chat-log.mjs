// A chat's log (data/logs/<id>.jsonl, one event per line) as the browser loads it: the recent part first, older parts on
// request, long tool input and output clipped (server.mjs sends these on {t:'open'} and {t:'older'}).

import fs from 'node:fs';

// Opening a chat sends only its recent part (owner, 2026-10-12: a 20 MB log took 30 s to open on a phone): about
// HISTORY_WINDOW events back from byte `before` (default: the end), widened to begin at a prompt when one is within as
// many again, with long tool input and output clipped (clipEvent). The log is read backwards in chunks, so a long chat
// costs no more than a short one. → {events, start}: start = the first sent line's byte offset, the `before` of the next
// older window ({t:'older'}); 0 = nothing older; end = where it stops. GET …/tools/:id serves a clipped call whole.
export const HISTORY_WINDOW = 150, CLIP_CHARS = 4000, LOG_CHUNK = 256 * 1024;
export function logWindow(file, before = Infinity) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return { events: [], start: 0, end: 0 }; }
  const events = [];
  let start = 0, end = 0;
  try {
    let pos = Math.min(Math.max(0, Math.floor(before) || 0), fs.fstatSync(fd).size), carry = Buffer.alloc(0);
    start = end = pos;
    scan: while (pos > 0) {
      const n = Math.min(LOG_CHUNK, pos);
      pos -= n;
      const data = Buffer.alloc(n);
      fs.readSync(fd, data, 0, n, pos);
      const buf = carry.length ? Buffer.concat([data, carry]) : data;
      for (let j = buf.length; ;) {
        const i = j > 0 ? buf.lastIndexOf(10, j - 1) : -1;
        if (i === -1 && pos > 0) { carry = buf.subarray(0, j); continue scan; } // the line goes on in the chunk before
        let ev = null;
        if (j > i + 1) try { ev = JSON.parse(buf.toString('utf8', i + 1, j)); } catch {}
        start = pos + i + 1;
        if (ev) {
          events.push(clipEvent(ev));
          if (events.length >= 2 * HISTORY_WINDOW || (ev.t === 'user' && events.length >= HISTORY_WINDOW)) break scan;
        }
        if (i === -1) break scan;
        j = i;
      }
    }
  } finally { fs.closeSync(fd); }
  return { events: events.reverse(), start, end };
}
// The events appended after byte `from` (a chat the browser still has drawn up to there; server.mjs logMark), clipped like
// a window. → {events, end}, or null when `from` is past the end or more than a window was added (send a fresh window).
export function logSince(file, from) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    if (!(from >= 0 && from <= size) || size - from > 4 * LOG_CHUNK) return null;
    const data = Buffer.alloc(size - from);
    fs.readSync(fd, data, 0, data.length, from);
    const events = [];
    for (const line of data.toString('utf8').split('\n')) {
      if (!line) continue;
      try { events.push(clipEvent(JSON.parse(line))); } catch {}
    }
    return events.length > 2 * HISTORY_WINDOW ? null : { events, end: size };
  } finally { fs.closeSync(fd); }
}
const clipText = (s) => (typeof s === 'string' && s.length > CLIP_CHARS ? `${s.slice(0, CLIP_CHARS)}\n… ${(s.length - CLIP_CHARS).toLocaleString('en-US')} more characters` : s);
export function clipEvent(ev) {
  if (ev.t === 'tool_result' && ev.text?.length > CLIP_CHARS) return { ...ev, text: clipText(ev.text), cut: true };
  if (ev.t !== 'tool_use' || !ev.input || typeof ev.input !== 'object' || JSON.stringify(ev.input).length <= CLIP_CHARS) return ev;
  const clip = (v) => (typeof v === 'string' ? clipText(v) : Array.isArray(v) ? v.map(clip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)])) : v);
  return { ...ev, input: clip(ev.input), cut: true };
}
// One tool call's full tool_use and tool_result events (sub-agent calls too) from a chat log. → {use, result}
export function toolEvents(file, toolId) {
  const out = { use: null, result: null };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  const needle = JSON.stringify(toolId);
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    const a = text.lastIndexOf('\n', i) + 1, b = text.indexOf('\n', i);
    let ev = null;
    try { ev = JSON.parse(text.slice(a, b === -1 ? undefined : b)); } catch {}
    if (ev?.id === toolId && (ev.t === 'tool_use' || ev.t === 'tool_result')) out[ev.t === 'tool_use' ? 'use' : 'result'] = ev;
    if (b === -1) break;
    i = b;
  }
  return out;
}
