import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => vi.unstubAllEnvs());
import { capacityReason, releasable, type ReleaseCandidate } from "../src/runs/capacity";
import { emptySummary } from "../src/runs/fold";
import { idleReleaseMs } from "../src/config";
import { createTranscript } from "../../web/src/features/run/transcript";

it("renders a replay-safe release explanation without changing turn completion", () => {
  const append = createTranscript();
  const events = [
    { type: "run.status", status: "ready", seq: 1, ts: 1 },
    { type: "run.released", reason: "idle_for_waiting_work", seq: 2, ts: 2 },
  ];
  const result = append(events);
  expect(result.status).toBe("ready");
  expect(result.items.at(-1)).toMatchObject({ kind: "released" });
  expect(append(events)).toEqual(result);
});

const now = 180_000;
function safe(): ReleaseCandidate {
  return { run: { status: "ready", phase: "agent", pending: [], summary: emptySummary(), pushed: true,
    head_sha: "a".repeat(40), pr_state: "open" }, live: true, busy: false, closing: false, booting: false,
    publicationPending: false, checkpointClaimed: false, idleSince: 0, delayMs: 120_000, state: { head: "a".repeat(40), clean: true } };
}

describe("idle release safety table (shared by reporting and eviction)", () => {
  it.each(["queued", "working", "ready", "failed", "stopped", "merged", "interrupted"] as const)("status %s", status => {
    const candidate = safe(); candidate.run.status = status;
    expect(releasable(candidate, now)).toBe(status === "ready");
  });
  const unsafe: [string, (c: ReleaseCandidate) => void][] = [
    ["pending message", c => { c.run.pending.push({ text: "Continue", images: [] }); }],
    ["question", c => { c.run.summary.question = { request_id: "q", question: "Which?" }; }],
    ["CI watch", c => { c.run.ci_active = true; }],
    ["CI publication", c => { c.run.ci_publication_pending = true; }],
    ["kept work", c => { c.run.work_kept = true; }],
    ["kept commit", c => { c.run.kept_commit = "b".repeat(40); }],
    ["unpublished branch", c => { c.run.pushed = false; }],
    ["unknown pushed head", c => { c.run.head_sha = null; }],
    ["different worker head", c => { c.state!.head = "b".repeat(40); }],
    ["dirty worktree", c => { c.state!.clean = false; }],
    ["unknown worker evidence", c => { c.state = undefined; }],
    ["auto resume pending", c => { c.run.auto_resume_pending = true; }],
    ["checkpoint resume pending", c => { c.run.resume_from_checkpoint = true; }],
    ["recovery finishing", c => { c.run.recovery_phase = "finishing"; }],
    ["interrupted phase", c => { c.run.phase = "interrupted"; }],
    ["finishing", c => { c.run.phase = "finishing"; }],
    ["booting phase", c => { c.run.phase = "booting"; }],
    ["merged pending phase", c => { c.run.phase = "merged_pending"; }],
    ["auto resume pending phase", c => { c.run.phase = "auto_resume_pending"; }],
    ["no live workspace", c => { c.live = false; }],
    ["busy", c => { c.busy = true; }],
    ["closing", c => { c.closing = true; }],
    ["reserved boot", c => { c.booting = true; }],
    ["pending publication", c => { c.publicationPending = true; }],
    ["live checkpoint claim", c => { c.checkpointClaimed = true; }],
    ["unknown idle start", c => { c.idleSince = undefined; }],
    ["not idle long enough", c => { c.idleSince = now - 119_999; }],
    ["disabled", c => { c.delayMs = 0; }],
  ];
  it.each(unsafe)("never releases %s", (_name, change) => {
    const candidate = safe(); change(candidate);
    expect(releasable(candidate, now)).toBe(false);
  });
  it.each(["open", "merged"] as const)("allows a safely published ready workspace with a %s PR", state => {
    const candidate = safe(); candidate.run.pr_state = state;
    expect(releasable(candidate, now)).toBe(true);
    candidate.run.phase = "merged_pending";
    expect(releasable(candidate, now)).toBe(false);
    candidate.run.summary.question = { request_id: "q", question: "Which?" };
    candidate.run.phase = "agent";
    expect(releasable(candidate, now)).toBe(false);
  });
  it("admits exactly at the idle boundary, including idle phase", () => {
    const candidate = safe(); candidate.run.phase = "idle";
    expect(releasable(candidate, 119_999)).toBe(false);
    expect(releasable(candidate, 120_000)).toBe(true);
  });
});

it("validates idle release seconds, with 0 explicitly disabling", () => {
  vi.stubEnv("GOND_AGENT_IDLE_RELEASE_SECONDS", "0");
  expect(idleReleaseMs()).toBe(0);
  vi.stubEnv("GOND_AGENT_IDLE_RELEASE_SECONDS", "10");
  expect(idleReleaseMs()).toBe(10_000);
  for (const value of ["-1", "1.5", "NaN", " 2", "1e2", "4294967296", "private-invalid-value"]) {
    vi.stubEnv("GOND_AGENT_IDLE_RELEASE_SECONDS", value);
    expect(() => idleReleaseMs()).toThrow("Invalid GOND_AGENT_IDLE_RELEASE_SECONDS");
  }
});

it("explains occupied workspaces without an ETA or another account's queue", () => {
  expect(capacityReason({ max: 5, occupied: 5, working: 2, idle_releasable: 3, queued_total_for_account: 1 }))
    .toBe("All 5 workspaces are in use: 2 working, 3 idle. Idle workspaces can be closed to free a slot.");
  expect(capacityReason({ max: 2, occupied: 1, working: 1, idle_releasable: 0, queued_total_for_account: 1 }))
    .toBe("Waiting for a workspace to start. Work starts in account queue order as capacity becomes available.");
  expect(idleReleaseMs()).toBe(120_000);
});
