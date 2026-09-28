// Screen tasks use the normal agent/event pipeline in a files-only workspace, without a git lifecycle.
export const isBrowserTask = (task) => task?.execution === 'browser';
export const BROWSER_TASK_SYSTEM = `Carry out the owner's request on the live browser screen using the Playwright MCP tools.
Start by reading the current page; preserve the owner's current tabs and signed-in profile. No code or git changes are expected.
Outbound or irreversible actions must go through the approval gate. Respect Take over: wait until the owner hands back.
Finish with a concise account of what you accomplished. If you cannot finish, explain the blocker and end with
AGENT-ORCH-STATUS: continue — followed by the reason. Otherwise your final message is the result shown to the owner.`;

export function browserTaskStatus(text) {
  const s = String(text || '').trim();
  if (/^\s*(?:AGENT-ORCH|AO2)-STATUS:\s*continue\b/im.test(s)) return 'failed';
  // Plain-language failures also count when the agent omits the requested status marker.
  return /\b(?:I (?:could not|couldn't|cannot|can't|was unable to)|unable to (?:complete|finish)|could not (?:complete|finish))\b/i.test(s) ? 'failed' : 'done';
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
