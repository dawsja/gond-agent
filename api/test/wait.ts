import { setImmediate } from "node:timers/promises";
import { vi } from "vitest";

// Retry assertions against real crypto, subprocess and filesystem completion.
// With fake timers, interval 0 still polls on real event-loop turns but does not
// move the test clock across queue-expiry, idle-release or retry boundaries.
export function waitForCondition<T>(assertion: () => T | Promise<T>) {
  return vi.waitFor(assertion, { timeout: 15_000, interval: vi.isFakeTimers() ? 0 : 10 });
}

// Only for pending promise continuations behind an explicit gate or a negative
// assertion with no asynchronous I/O. Never use this as a completion signal.
export async function settle() { await setImmediate(); }
