import { describe, expect, it } from "vitest";
import { RUN_STATES, RUN_TRANSITIONS, assertRunTransition, isRunStatus, type RunStatus } from "../../shared/run-state";
import { RUN_UI, STATUS } from "../../web/src/lib/run-state";
import { createTranscript } from "../../web/src/features/run/transcript";
import { MCP_RUN_STATES, sessionState } from "../src/mcp";
import { emptySummary } from "../src/runs/fold";
import type { Run } from "../src/runs/service";

function run(status: RunStatus): Run {
  return { status, summary: emptySummary(), pending: [] } as unknown as Run;
}

describe("shared run lifecycle", () => {
  it("covers every state with valid transitions, UI presentation and MCP output", () => {
    const expectedMcp = ["queued", "working", "done", "failed", "stopped", "merged", "interrupted"];
    for (const map of [RUN_TRANSITIONS, RUN_UI, STATUS, MCP_RUN_STATES]) {
      expect(Object.keys(map).sort()).toEqual([...RUN_STATES].sort());
    }
    for (const [index, status] of RUN_STATES.entries()) {
      expect(isRunStatus(status)).toBe(true);
      for (const next of RUN_TRANSITIONS[status]) {
        expect(isRunStatus(next)).toBe(true);
        expect(() => assertRunTransition(status, next)).not.toThrow();
      }
      const ui = RUN_UI[status];
      expect(ui.label).toBeTruthy();
      expect(ui.color).toMatch(/^var\(--status-/);
      expect(STATUS[status]).toBe(ui.color);
      expect(["pending", "ready", "merged", "none"]).toContain(ui.pr);
      expect(["good", "warning", "bad", "merged", "neutral"]).toContain(ui.variant);
      expect(sessionState(run(status))).toMatchObject({
        state: expectedMcp[index],
        done: status !== "queued" && status !== "working",
        waiting_for_input: false,
      });
    }
    expect(RUN_UI.interrupted).toMatchObject({ label: "Interrupted", pr: "none" });
    expect(isRunStatus("unknown")).toBe(false);
    expect(isRunStatus(null)).toBe(false);
  });

  it("routes interrupted recovery through the queue, never directly to work or completion", () => {
    expect(() => assertRunTransition("working", "interrupted")).not.toThrow();
    const allowed = new Set<RunStatus>(["queued", "stopped", "merged"]);
    for (const to of RUN_STATES) {
      if (allowed.has(to)) expect(() => assertRunTransition("interrupted", to)).not.toThrow();
      else expect(() => assertRunTransition("interrupted", to)).toThrow("Illegal run transition");
    }
    for (const from of RUN_STATES.filter(s => s !== "working")) {
      expect(() => assertRunTransition(from, "interrupted")).toThrow("Illegal run transition");
    }
    for (const [from, to] of [
      ["ready", "queued"], ["stopped", "working"], ["failed", "queued"],
      ["queued", "working"], ["working", "ready"], ["working", "working"],
      ["queued", "failed"], ["working", "queued"], ["ready", "merged"],
    ] as const) expect(() => assertRunTransition(from, to)).not.toThrow();
    expect(() => assertRunTransition("queued", "ready")).toThrow("Illegal run transition");
    expect(() => assertRunTransition("merged", "queued")).toThrow("Illegal run transition");
  });

  it("returns interrupted to MCP waiters even with preserved input, but keeps active question/queue behavior", () => {
    const r = run("interrupted");
    r.pending = [{ text: "Keep going", images: [] }];
    r.summary.question = { request_id: "q1", question: "Continue?" };
    expect(sessionState(r)).toMatchObject({
      state: "interrupted", done: true, waiting_for_input: false,
      asking_question: false, question: null, last_error: null,
    });
    r.status = "working";
    expect(sessionState(r)).toMatchObject({ state: "waiting_for_input", done: false, question: "Continue?" });
    r.summary.question = null;
    expect(sessionState(r)).toMatchObject({ state: "queued", done: false });
    r.pending = [];
    expect(sessionState(r)).toMatchObject({ state: "working", done: false });
  });

  it("folds interruption into a visible transcript marker without inventing a merge, then accepts resume events", () => {
    const append = createTranscript();
    const interrupted = append([{ type: "run.status", seq: 1, ts: 1, status: "interrupted" }]);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.items).toEqual([{ kind: "end", key: "e1", status: "interrupted", error: undefined, ts: 1 }]);
    expect(RUN_UI.interrupted.endText).toContain("Interrupted");
    expect(RUN_UI.interrupted.endText).not.toContain("merged");
    const resumed = append([
      { type: "run.status", seq: 2, ts: 2, status: "queued" },
      { type: "run.status", seq: 3, ts: 3, status: "working", step: "Resuming" },
    ]);
    expect(resumed).toMatchObject({ status: "working", step: "Resuming" });
    expect(resumed.items).toEqual(interrupted.items);
  });
});
