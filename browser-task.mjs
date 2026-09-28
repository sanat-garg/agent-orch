// Screen tasks use the normal agent/event pipeline in a files-only workspace, without a git lifecycle.
export const isBrowserTask = (task) => task?.execution === 'browser';
export const BROWSER_TASK_SYSTEM = `Carry out the owner's request on the live browser screen using the Playwright MCP tools.
Start by reading the current page; preserve the owner's current tabs and signed-in profile. No code or git changes are expected.
Outbound or irreversible actions must go through the approval gate. Respect Take over: wait until the owner hands back.
Finish with a concise account of what you accomplished or, if you could not finish, the blocker; it is shown to the owner.
End EVERY final message with exactly one last line, and nothing after it:
AGENT-ORCH-STATUS: done — <one-line summary>      (the request was carried out)
AGENT-ORCH-STATUS: failed — <the blocker>         (it was not; say what, if anything, was already submitted)`;

// A status line such as "AGENT-ORCH-STATUS: done — booked"; tolerates markdown emphasis and the legacy AO2 prefix.
const MARKER = /^[\s*_`>]*(?:AGENT-ORCH|AO2)-STATUS:[\s*_`]*(done|failed|continue|blocked)\b/i;
// Blockers and completions for replies without a marker. Quoted text is what a page said, not the agent's outcome.
const BLOCKER = /\b(?:I (?:could not|couldn't|cannot|can't|was unable to|am unable to|stopped)|unable to (?:complete|finish|proceed)|could(?: not|n't) (?:complete|finish|proceed)|blocked by|sign[- ]?in (?:is )?required|captcha|nothing was (?:submitted|sent|booked|posted|ordered|saved))\b/gi;
const COMPLETION = /\b(?:booked|sent|posted|submitted|ordered|saved|done)\b/gi;
const NEGATED = /(?:\bnot|n't|\bnever|\bnothing (?:was|were|got)|\bno)\s+(?:been\s+|yet\s+|actually\s+)?$/i;

export function browserTaskStatus(text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  // The marker on the last line decides; otherwise the latest marker anywhere in the reply.
  const marker = [...lines].reverse().map((l) => MARKER.exec(l)).find(Boolean);
  if (marker) return marker[1].toLowerCase() === 'done' ? 'done' : 'failed';
  // No marker: judge only the final paragraph. A blocker fails it unless a completion is reported after it.
  const para = String(text || '').trim().split(/\n\s*\n/).pop().replace(/[‘’]/g, "'").replace(/"[^"\n]*"|“[^”\n]*”/g, '""');
  const blockers = [...para.matchAll(BLOCKER)];
  if (!blockers.length) return 'done';
  const last = blockers.at(-1), after = last.index + last[0].length;
  const completed = [...para.matchAll(COMPLETION)].some((m) => m.index >= after && !NEGATED.test(para.slice(0, m.index)));
  return completed ? 'done' : 'failed';
}

// The reply without its status marker line(s), for display.
export function stripStatusMarker(text) {
  return String(text || '').split('\n').filter((l) => !MARKER.test(l)).join('\n').trimEnd();
}

export function browserSteps(entries) {
  const steps = [];
  for (const e of entries) {
    const ts = e.at ?? e.ts ?? 0;
    if (e.k === 'image') {
      const pending = steps.at(-1);
      if (pending?.kind === 'shot' && !pending.mediaId) pending.mediaId = e.id;
      else steps.push({ ts, kind: 'shot', label: e.name || 'Screenshot', mediaId: e.id });
    } else if (e.k === 'text') {
      if (e.text) steps.push({ ts, kind: 'text', label: e.text });
    } else if (e.k === 'approval') {
      steps.push({ ts, kind: 'approval', label: e.label, ...(e.mediaId && { mediaId: e.mediaId }) });
    } else if (e.k === 'tool') {
      const name = String(e.name || '').match(/(?:^|__)browser_(\w+)$/)?.[1];
      if (!name) continue;
      const input = e.input || {};
      let fields = input.fields;
      if (typeof fields === 'string') { try { fields = JSON.parse(fields); } catch { fields = null; } }
      const kind = /navigate|tabs/.test(name) ? 'nav' : /click|hover|drag|press_key|select_option/.test(name) ? 'click'
        : /type|fill/.test(name) ? 'type' : /screenshot/.test(name) ? 'shot' : 'read';
      const label = input.element || input.url || input.ref || input.filename || input.key
        || (Array.isArray(fields) ? fields : []).map((f) => f.name || f.ref).filter(Boolean).join(', ') || name.replaceAll('_', ' ');
      steps.push({ ts, kind, label: String(label) });
    }
  }
  return steps;
}
