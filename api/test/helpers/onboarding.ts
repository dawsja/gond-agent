import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { command } from "../../src/command";

// CI observed a 113s successful viewport and a ~97s failure with a 90s
// subprocess cap. These are test ceilings, not measured per-command durations:
// recreate can spend 30s stopping + 60s in Compose's wait + 30s Docker overhead;
// the full Chromium phase gets twice the old 90s cap, not per-assertion retries.
export const onboardingTimeouts = {
  command: 30_000,
  compose: 120_000,
  browser: 180_000,
  ready: 60_000,
  // Browser ps/rm must not consume Compose down's 30s stop grace + overhead.
  browserCleanup: 60_000,
  cleanup: 60_000,
  // Share a 5-minute flow budget; stage ceilings must not add up unboundedly.
  workflow: 300_000,
};
export const onboardingTestTimeout = onboardingTimeouts.workflow + onboardingTimeouts.browserCleanup + onboardingTimeouts.cleanup + 15_000;

export function remainingTimeout(deadline: number, ceiling: number) {
  return Math.max(0, Math.min(ceiling, Math.floor(deadline - performance.now())));
}

/** Labels are test-owned command/phase names. Never log argv, env or script bodies. */
export async function dockerCommand(file: string, args: string[], options: {
  label: string;
  timeout: number;
  env?: NodeJS.ProcessEnv;
}) {
  const start = performance.now();
  const { label, timeout, env } = options;
  let outcome = "failed";
  try {
    // execFile interprets zero as unlimited; an exhausted shared budget must not.
    if (timeout <= 0) throw new Error("Test workflow budget exhausted before command started");
    const output = await command(file, args, { timeout, env });
    outcome = "completed";
    return output;
  } catch (error) {
    throw new Error(`${label} failed after ${Math.round(performance.now() - start)}ms (timeout ${timeout}ms): ${String(error)}`, { cause: error });
  } finally {
    console.info(`[container test] ${label} ${outcome} after ${Math.round(performance.now() - start)}ms (timeout ${timeout}ms)`);
  }
}

/** Compose has no healthcheck: --wait means running, not HTTP/SQLite ready.
 * Poll both the live DB health and the persisted first-account state. Each fetch
 * (including its body) and every sleep consumes the same finite readiness budget.
 */
export async function waitForOnboarding(origin: string, firstAccount: boolean, options: {
  timeout: number;
  requestTimeout?: number;
  interval?: number;
}) {
  const start = performance.now(), deadline = start + options.timeout;
  let last = "no readiness probe completed";
  const json = async (path: string) => {
    const timeout = remainingTimeout(deadline, options.requestTimeout ?? 2_000);
    if (timeout <= 0) throw new Error("readiness budget exhausted");
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(timeout), redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${path}: HTTP ${response.status}`);
    }
    return response.json();
  };
  while (remainingTimeout(deadline, options.timeout) > 0) {
    try {
      if ((await json("/health")).ok !== true) throw new Error("/health: expected ok=true");
      const bootstrap = await json("/api/auth/bootstrap");
      if (bootstrap.firstAccount !== firstAccount)
        throw new Error(`/api/auth/bootstrap: expected firstAccount=${firstAccount}, got ${bootstrap.firstAccount}`);
      console.info(`[container test] HTTP/SQLite ready (firstAccount=${firstAccount}) after ${Math.round(performance.now() - start)}ms`);
      return;
    } catch (error) { last = String(error); }
    const wait = remainingTimeout(deadline, options.interval ?? 250);
    if (wait > 0) await delay(wait);
  }
  throw new Error(`HTTP/SQLite readiness failed after ${Math.round(performance.now() - start)}ms (timeout ${options.timeout}ms; firstAccount=${firstAccount}): ${last}`);
}
