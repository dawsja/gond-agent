import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { waitForCondition } from "./wait";

// Deliberately small source check, not a parser: a bare timing wait must not be
// the completion signal for a subsequent exact run-start assertion. An explicit
// `timing-wait-allow: <reason>` comment on the wait line is the escape hatch.
function timingWaits(source: string) {
  const violations: number[] = [];
  const waits = /await\s+(?:flush|settle)\(\s*\);([^\n]*)/g;
  for (const match of source.matchAll(waits)) {
    if (/\/\/\s*timing-wait-allow:\s*\S/.test(match[1])) continue;
    const tail = source.slice(match.index + match[0].indexOf(";") + 1).split(/\bawait\b|^\s*\}\);/m)[0];
    if (/expect\(\s*(?:starts|runStarts)\b[\s\S]*?\.(?:toEqual|toBe|toHaveLength)\(/.test(tail))
      violations.push(source.slice(0, match.index).split("\n").length);
  }
  return violations;
}

// The queue suite removed this helper entirely. Catch every reintroduced call,
// even before statuses/events, an intervening await, or the end of a test.
function legacyQueueFlushes(source: string) {
  return [...source.matchAll(/\bflush\s*\(/g)].map(match => source.slice(0, match.index).split("\n").length);
}

it("rejects legacy queue flush calls regardless of the following assertion", () => {
  expect(legacyQueueFlushes("await flush();\nexpect(run.status).toBe('failed');")).toEqual([1]);
  expect(legacyQueueFlushes("await flush();\nawait vi.advanceTimersByTimeAsync(60000);")).toEqual([1]);
  expect(legacyQueueFlushes("await flush();\nexpect(events).toEqual([]);\nawait flush();")).toEqual([1, 3]);
  expect(legacyQueueFlushes("await waitForCondition(() => expect(starts).toHaveLength(2));\nawait workspace.flushCheckpoints();")).toEqual([]);
});

it("keeps the removed flush helper out of the entire queue suite", () => {
  const source = readFileSync(new URL("./run-queue.test.ts", import.meta.url), "utf8");
  expect(legacyQueueFlushes(source)).toEqual([]);
});

it("rejects bare timing waits before exact run-start assertions", () => {
  expect(timingWaits("await flush();\nexpect(releases).toEqual([id]);\nexpect(starts).toEqual([id, next]);")).toEqual([1]);
  expect(timingWaits("await flush(); expect(starts.at(-1)).toBe(next);")).toEqual([1]);
  expect(timingWaits("await settle();\nexpect(runStarts).toHaveLength(2);")).toEqual([1]);
  expect(timingWaits("await flush();\nawait waitForCondition(() => expect(starts).toEqual([id, next]));")).toEqual([]);
  expect(timingWaits("await flush(); await waitForCondition(() => expect(starts).toEqual([id, next]));")).toEqual([]);
  expect(timingWaits("await flush();\nawait vi.waitFor(() => expect(starts).toEqual([id, next]), { timeout: 15000 });")).toEqual([]);
  expect(timingWaits("await settle(); // timing-wait-allow: checkout is held by an explicit gate\nexpect(starts).toEqual([]);")).toEqual([]);
});

it("keeps timing-based run-start waits out of API test files", () => {
  const root = new URL("./", import.meta.url);
  const violations = readdirSync(root, { recursive: true }).filter((name): name is string =>
    typeof name === "string" && name.endsWith(".test.ts") && name !== "wait.test.ts")
    .flatMap(name => timingWaits(readFileSync(new URL(name, root), "utf8")).map(line => `${name}:${line}`));
  expect(violations).toEqual([]);
});

afterEach(() => vi.useRealTimers());
it("retries the observable assertion without advancing a fake-clock deadline", async () => {
  vi.useFakeTimers();
  const now = Date.now();
  let completed = false;
  // Real I/O can complete while the service clock is held exactly at a boundary.
  const completion = delay(20).then(() => { completed = true; });
  await waitForCondition(() => expect(completed).toBe(true));
  await completion;
  expect(Date.now()).toBe(now);
});
