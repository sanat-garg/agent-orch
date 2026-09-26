import { setTimeout } from 'node:timers/promises';

// A generous failure deadline, but no fixed delay once the condition is true.
export async function waitFor(condition, { timeout = 30000, interval = 20, message = 'condition was not met' } = {}) {
  const deadline = Date.now() + timeout;
  while (true) {
    const result = await condition();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${message}`);
    await setTimeout(interval);
  }
}
