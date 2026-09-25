// One Claude runtime per chat. A replaced runtime is retired first, so when its loop ends later it can tell it
// no longer owns the slot and must not delete the new runtime or report the session as ended (AUDIT #3).
export function retireRuntime(runtimes, id) {
  const rt = runtimes.get(id);
  if (!rt) return;
  rt.retired = true;
  runtimes.delete(id);
  rt.q?.close();
}
