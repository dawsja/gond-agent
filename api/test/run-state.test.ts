import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { RUN_STATES, RUN_TRANSITIONS, assertRunTransition, isRunStatus, type RunStatus } from "../../shared/run-state";
import { RUN_UI, STATUS } from "../../web/src/lib/run-state";
import { createTranscript } from "../../web/src/features/run/transcript";
import { MCP_RUN_STATES, sessionState } from "../src/mcp";
import { emptySummary } from "../src/runs/fold";
import { Runs, type Run } from "../src/runs/service";
import { openStore, type Store } from "../src/db";
import type { Config } from "../src/config";

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
    const allowed = new Set<RunStatus>(["interrupted", "queued", "failed", "stopped", "merged"]);
    for (const to of RUN_STATES) {
      if (allowed.has(to)) expect(() => assertRunTransition("interrupted", to)).not.toThrow();
      else expect(() => assertRunTransition("interrupted", to)).toThrow("Illegal run transition");
    }
    for (const from of RUN_STATES.filter(s => s !== "working" && s !== "interrupted")) {
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

  it("inventories every service status call, including both arms of dynamic targets", () => {
    // Operation-specific source states, not a copy of RUN_TRANSITIONS. A new call site
    // or dynamic target must be reviewed here rather than silently escaping coverage.
    const permitted: Record<string, Partial<Record<RunStatus, readonly RunStatus[]>>> = {
      refreshPulls: { merged: ["ready", "failed", "stopped", "interrupted"] },
      recover: { interrupted: ["working"], failed: ["working"] },
      queueResume: { queued: ["interrupted"] },
      drain: { failed: ["queued"] },
      boot: { working: ["queued", "working"], ready: ["working"], stopped: ["working", "stopped"] },
      next: { working: ["working", "ready"] },
      poll: { stopped: ["working"] },
      finish: { working: ["working"], ready: ["working"], stopped: ["stopped"], merged: ["working"] },
      resumeAfterCiRefusal: { failed: ["working", "stopped"], queued: ["working", "stopped"], ready: ["working"], stopped: ["stopped"] },
      merge: { merged: ["ready", "failed", "stopped", "interrupted"] },
      stop: { stopped: ["queued", "working", "ready", "failed", "stopped", "interrupted"] },
      fail: { interrupted: ["working", "interrupted"], failed: ["queued", "working", "ready", "failed", "stopped", "interrupted"] },
    };
    const source = ts.createSourceFile("service.ts", readFileSync(new URL("../src/runs/service.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const seen = new Map<string, Set<RunStatus>>();
    const targets = (node: ts.Expression): RunStatus[] => {
      if (ts.isParenthesizedExpression(node)) return targets(node.expression);
      if (ts.isConditionalExpression(node)) return [...targets(node.whenTrue), ...targets(node.whenFalse)];
      if (ts.isStringLiteral(node) && isRunStatus(node.text)) return [node.text];
      throw new Error(`Review dynamic status target: ${node.getText(source)}`);
    };
    const visit = (node: ts.Node, method = "") => {
      if (ts.isMethodDeclaration(node)) method = node.name.getText(source);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.kind === ts.SyntaxKind.ThisKeyword && node.expression.name.text === "status") {
        expect(permitted, `Unreviewed this.status call in ${method}`).toHaveProperty(method);
        const argument = node.arguments[1];
        expect(argument, `Missing status target in ${method}`).toBeDefined();
        for (const target of targets(argument!)) {
          const sources = permitted[method]?.[target];
          expect(sources, `Unreviewed ${method} -> ${target}`).toBeDefined();
          expect(sources!.length).toBeGreaterThan(0);
          for (const from of sources!) expect(() => assertRunTransition(from, target), `${method}: ${from} -> ${target}`).not.toThrow();
          if (!seen.has(method)) seen.set(method, new Set());
          seen.get(method)!.add(target);
        }
      }
      ts.forEachChild(node, child => visit(child, method));
    };
    visit(source);
    expect([...seen.keys()].sort()).toEqual(Object.keys(permitted).sort());
    for (const [method, expected] of Object.entries(permitted)) {
      expect([...seen.get(method)!].sort(), method).toEqual(Object.keys(expected).sort());
    }
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

describe("service lifecycle enforcement", () => {
  let dir: string, db: Store, runs: Runs;
  const id = "run_000000000000000000000001";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gond-run-state-"));
    db = openStore(dir);
    const cfg: Config = { data: dir, origin: "http://localhost", secret: "lifecycle-test-secret".repeat(2), signup: false,
      port: 8787, dockerBin: "docker", workerImage: "unused", maxRuns: 1, runCPUs: 1, runMemoryMB: 512 };
    runs = new Runs(db, cfg, async () => { throw new Error("No worker should start in lifecycle tests"); });
    const saved = { ...run("interrupted"), id, user_id: "alice", repo: "org/repo", backend: "builtin",
      title: "Preserved task", phase: "idle", step: null, error: null, created_at: 1, updated_at: 1 };
    db.prepare("INSERT INTO runs(id,user_id,repo,status,created_at,updated_at,data) VALUES(?,?,?,'interrupted',1,1,?)")
      .run(id, "alice", "org/repo", JSON.stringify(saved));
  });
  afterEach(async () => {
    await runs.shutdown();
    vi.restoreAllMocks();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const persisted = () => db.prepare("SELECT status,updated_at,data FROM runs WHERE id=?").get(id);

  it.each(["working", "ready"] as const)("rejects direct interrupted -> %s through both save and status without writes or events", target => {
    const current = runs.get(id);
    const before = persisted();
    expect(() => runs.save({ ...current, status: target })).toThrow("Illegal run transition");
    expect(persisted()).toEqual(before);
    const snapshot = structuredClone(current);
    expect(() => runs.status(current, target, "Must not persist")).toThrow("Illegal run transition");
    expect(current).toEqual(snapshot); // status validates before mutating the caller's snapshot.
    expect(persisted()).toEqual(before);
    expect(runs.history(id, 0)).toEqual([]);
  });

  it("checks the persisted source even when a stale snapshot would allow the status edge", () => {
    const stale = { ...runs.get(id), status: "ready" as const };
    const before = persisted();
    // ready -> working is legal locally; interrupted -> working in SQLite is not.
    expect(() => runs.status(stale, "working")).toThrow("Illegal run transition");
    expect(persisted()).toEqual(before);
    expect(runs.history(id, 0)).toEqual([]);
  });

  it("permits interrupted metadata updates and persists queue re-entry before work", () => {
    const current = runs.get(id);
    current.title = "Updated while interrupted";
    expect(() => runs.save(current)).not.toThrow();
    expect(() => runs.status(current, "interrupted", "Checkpoint kept")).not.toThrow();
    expect(runs.get(id)).toMatchObject({ status: "interrupted", title: current.title, step: "Checkpoint kept" });
    runs.status(current, "queued");
    expect(runs.get(id).status).toBe("queued");
    runs.status(current, "working", "Restoring checkpoint");
    expect(runs.get(id).status).toBe("working");
    expect(runs.history(id, 0).map(event => event.status)).toEqual(["interrupted", "queued", "working"]);
  });

  it("records fail on an interrupted run instead of swallowing an illegal transition", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const current = runs.get(id);
    current.pending = [{ text: "Retry the task", images: [] }];
    runs.save(current);
    await (runs as unknown as { fail(id: string, error: unknown): Promise<void> }).fail(id, new Error("fixture restore failed"));
    expect(runs.get(id)).toMatchObject({ status: "failed", phase: "idle", pending: [], last_error: { step: "turn", attempts: 1 } });
    const history = runs.history(id, 0);
    expect(history.map(event => event.type)).toEqual(["run.error", "run.status"]);
    expect(history[1]).toMatchObject({ type: "run.status", status: "failed" });
    expect(log.mock.calls.some(args => args[0] === "Could not record run failure")).toBe(false);
  });
});
