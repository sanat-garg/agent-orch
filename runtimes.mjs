// One Claude runtime per chat. A replaced runtime is retired first, so when its loop ends later it can tell it
// no longer owns the slot and must not delete the new runtime or report the session as ended (AUDIT #3).
export function retireRuntime(runtimes, id) {
  const rt = runtimes.get(id);
  if (!rt) return;
  rt.retired = true;
  runtimes.delete(id);
  rt.q?.close();
}

// True when no chat work is in flight: no Claude runtime replying, no non-Claude chat turn, no chat planner turn.
export function chatIdle({ runtimes, agentTurns, planning, chatPlanning = () => false }) {
  for (const rt of runtimes.values()) if (rt.busy) return false;
  return !agentTurns.size && !planning.size && !chatPlanning();
}

// Restart-when-idle: wait for the orchestrator drain, then poll until chat is idle too (AUDIT #24).
// Resolves true when it's safe to exit, false if the restart was cancelled meanwhile.
export async function whenIdle({ drained, idle, cancelled, pollMs = 2000 }) {
  await drained;
  for (;;) {
    if (cancelled()) return false;
    if (idle()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
