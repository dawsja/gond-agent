import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { RetryError } from "../src/retry";
import { createAuthentication, seal } from "../src/auth";
import { queueSettings, type Config } from "../src/config";
import type { Workspace, WorkspaceFactory } from "../src/containers";
import { migrateRunQueue, openStore, setSetting } from "../src/db";
import { checkout, commitIdentity, gh, importBundle, pushBranch } from "../src/github";
import { saveProviderSettings } from "../src/providers";
import { Runs } from "../src/runs/service";
import { RunQueue } from "../src/runs/queue";
import { createApp } from "../src/app";
import { createToken } from "../src/mcp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { evidenceState, signedRecord } from "./fixtures/evidence";

vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rm: vi.fn(fs.rm) };
});

vi.mock("../src/github", async (original) => ({
  ...await original<typeof import("../src/github")>(),
  gh: vi.fn(async () => ({ default_branch: "main" })),
  checkout: vi.fn(async () => ({ cwd: "/fake", archive: Buffer.from("repo") })),
  commitIdentity: vi.fn(async () => ({ name: "fixture", email: "123+fixture@users.noreply.github.com" })),
  importBundle: vi.fn(async () => {}),
  pushBranch: vi.fn(async () => {}),
  git: vi.fn(async (_cwd: string, ...args: string[]) => Buffer.from(args[0] === "rev-parse" ? "a".repeat(40) : "")),
}));

type Event = Record<string, unknown>;
type Batch = { events: Event[]; alive: boolean };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// Long-poll events stay pending until the test explicitly releases them. No worker,
// Git checkout, network request, real-time polling or automatic turn completion.
class ControlledWorkspace implements Workspace {
  readonly calls: { method: string; args?: Record<string, unknown> }[] = [];
  rejectEventsOnDestroy = false;
  hangEvidenceExport = false;
  flushCheckpoints?: () => Promise<void>;
  state = { head: "b".repeat(40), clean: true };
  private batches: Batch[] = [];
  private poll?: ReturnType<typeof deferred<Batch>>;
  constructor(readonly id: string, private starts: string[], private releases: string[]) {}
  emit(...events: Event[]) { this.respond({ events, alive: true }); }
  exit(...events: Event[]) { this.respond({ events, alive: false }); }
  private respond(batch: Batch) {
    if (this.poll) {
      const poll = this.poll;
      this.poll = undefined;
      poll.resolve(batch);
    } else this.batches.push(batch);
  }
  async rpc<T>(method: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, args });
    if (method === "export_state" && this.hangEvidenceExport) return new Promise<T>(() => {});
    if (method === "start") this.starts.push(this.id);
    if (method === "events") {
      if (this.batches.length) return this.batches.shift() as T;
      this.poll = deferred<Batch>();
      return this.poll.promise as Promise<T>;
    }
    if (method === "workspace_state") return { ...this.state } as T;
    if (method === "snapshot") return { bundle: Buffer.from("bundle").toString("base64"), head: "b".repeat(40) } as T;
    if (method === "send" && (args?.input as { type?: string })?.type === "interrupt")
      this.emit({ type: "turn.end", agent_id: "main", stop_reason: "interrupted" });
    return true as T;
  }
  async destroy() {
    this.releases.push(this.id);
    // A real workspace resolves an outstanding RPC on teardown. A nonempty batch
    // lets the pump see live.closed before attempting another database read.
    if (this.rejectEventsOnDestroy && this.poll) {
      this.poll.reject(new Error("Workspace was destroyed"));
      this.poll = undefined;
    } else this.emit({ type: "turn.start", agent_id: "main" });
  }
  users() {
    return this.calls.filter(call => call.method === "send")
      .map(call => call.args?.input as { type: string; text?: string })
      .filter(input => input.type === "user").map(input => input.text);
  }
}

let dir: string, db: ReturnType<typeof openStore>, cfg: Config, runs: Runs;
let starts: string[], releases: string[], workspaces: Map<string, ControlledWorkspace>;
let gates: ReturnType<typeof deferred<void>>[];
const input = (prompt = "Implement it") => ({ repo: "acme/app", model: "local:coder", prompt });
const factory: WorkspaceFactory = async id => {
  const workspace = new ControlledWorkspace(id, starts, releases);
  workspaces.set(id, workspace);
  return workspace;
};
// Flush promise chains and asynchronous checkout cleanup without advancing the
// fake clock. Worker event RPCs remain under test control.
async function flush() { for (let i = 0; i < 100; i++) await setImmediate(); }
async function create(user = "a", prompt = "Implement it") {
  const run = await runs.create(user, input(prompt));
  await flush();
  return runs.get(run.id, user);
}
async function finish(id: string) {
  workspaces.get(id)!.emit({ type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
  await flush();
  expect(runs.get(id).status).toBe("ready");
}
function holdCheckout(fail = false) {
  const gate = deferred<void>();
  gates.push(gate);
  vi.mocked(checkout).mockImplementationOnce(async () => {
    await gate.promise;
    if (fail) throw new Error("fixture checkout failure");
    return { cwd: "/fake", archive: Buffer.from("repo") };
  });
  return () => gate.resolve();
}
function membership(id: string) {
  return db.prepare("SELECT queue_seq,queued_at FROM runs WHERE id=?").get(id) as { queue_seq: number | null; queued_at: number | null };
}
function queuedIds() {
  return (db.prepare("SELECT id FROM runs WHERE queue_seq IS NOT NULL ORDER BY queue_seq").all() as { id: string }[]).map(row => row.id);
}
function countRuns() { return (db.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n; }
function saveCheckpoint(id: string) {
  const run = runs.get(id);
  const key = { runId: id, ownerId: run.user_id, runnerVersion: "gond-agent-checkpoint-2" };
  const checkpoint = runs.checkpoints.save({ ...key, bundle: Buffer.from("opaque checkpoint"),
    state: JSON.stringify({ runner: { runner_state_version: key.runnerVersion }, service: {} }),
    tree: { baseSha: run.base_sha!, headSha: run.head_sha!, checkpointSha: "c".repeat(40) } });
  return { key, checkpoint, bundlePath: join(dir, "checkpoints", checkpoint.bundle_path), statePath: join(dir, "checkpoints", checkpoint.state_path) };
}

beforeEach(async () => {
  vi.stubEnv("GOND_AGENT_CI_FIX_ROUNDS", "0");
  vi.clearAllMocks();
  vi.mocked(checkout).mockReset().mockResolvedValue({ cwd: "/fake", archive: Buffer.from("repo") });
  dir = mkdtempSync(join(tmpdir(), "gond-run-queue-"));
  cfg = { data: dir, origin: "http://localhost:8787", secret: "q".repeat(40), signup: true, port: 8787,
    dockerBin: "docker", workerImage: "unused", maxRuns: 1, runCPUs: 2, runMemoryMB: 2048 };
  db = openStore(dir);
  await createAuthentication(db, cfg);
  setSetting(db, "github-shared-fallback", false);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
  for (const user of ["a", "b", "c"]) {
    db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .run(user, user.toUpperCase(), `${user}@example.test`, 0, Date.now(), Date.now());
    db.prepare("INSERT INTO github_connections(user_id,token,connected_at) VALUES(?,?,?)")
      .run(user, seal(cfg.secret, `fixture-github-${user}`), Date.now());
    db.prepare("INSERT INTO profiles(user_id,auto_pr) VALUES(?,0)").run(user);
  }
  saveProviderSettings(db, cfg.secret, { connections: [{ id: "local", name: "Local", format: "openai",
    baseURL: "http://127.0.0.1:9/v1", apiKey: "fixture-provider-key", discover: false,
    models: [{ id: "coder", name: "Coder", contextWindow: 128000, maxOutput: 8192, reasoning: "none", images: true }] }], defaultModel: "local:coder" });
  starts = []; releases = []; gates = []; workspaces = new Map();
  runs = new Runs(db, cfg, factory);
});
afterEach(async () => {
  for (const gate of gates) gate.resolve();
  await flush();
  await runs.shutdown();
  await flush();
  vi.clearAllTimers();
  vi.useRealTimers();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("persistent workspace queue", () => {
  it("accepts work at capacity, exposes only the owner's queue and starts it automatically on close", async () => {
    const active = await create();
    const a1 = await create("a", "A first"), b1 = await create("b"), a2 = await create("a", "A second");
    expect(starts).toEqual([active.id]);
    expect(runs.get(a1.id, "a")).toMatchObject({ status: "queued", queue_position: 1, queue_length: 2 });
    expect(runs.get(a2.id, "a")).toMatchObject({ queue_position: 2, queue_length: 2 });
    expect(runs.list("b")).toEqual([expect.objectContaining({ id: b1.id, queue_position: 1, queue_length: 1 })]);
    expect(() => runs.get(a1.id, "b")).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(runs.list("a").map(r => r.id)).not.toContain(b1.id);
    expect(runs.history(b1.id, 0).filter(e => e.type === "run.queued").at(-1)).toMatchObject({ position: 1, length: 1 });
    expect(membership(a1.id)).toEqual({ queue_seq: expect.any(Number), queued_at: Date.now() });
    runs.save(runs.get(a1.id));
    const stored = JSON.parse((db.prepare("SELECT data FROM runs WHERE id=?").get(a1.id) as { data: string }).data);
    expect(stored).not.toHaveProperty("queue_position");
    expect(stored).not.toHaveProperty("queue_length");
    await finish(active.id);
    expect(starts).toEqual([active.id]); // Successful turns retain their workspace.
    await runs.closeSession(active.id, "a");
    await flush();
    expect(releases).toEqual([active.id]);
    expect(starts).toEqual([active.id, a1.id]); // No occupied accounts: oldest head wins.
    expect(membership(a1.id)).toEqual({ queue_seq: null, queued_at: null });
    expect(runs.get(a1.id)).not.toHaveProperty("queue_position");
    expect(runs.get(a2.id)).toMatchObject({ queue_position: 1, queue_length: 1 });
    expect(vi.mocked(checkout).mock.calls.map(call => call[6]?.GH_TOKEN)).toEqual(["fixture-github-a", "fixture-github-a"]);
    expect(vi.mocked(importBundle).mock.calls[0]?.[3]?.GH_TOKEN).toBe("fixture-github-a");
    expect(vi.mocked(gh).mock.calls.map(call => call[3]?.GH_TOKEN))
      .toEqual(["fixture-github-a", "fixture-github-a", "fixture-github-b", "fixture-github-a"]);
    expect(JSON.stringify([...workspaces.values()].flatMap(w => w.calls))).not.toMatch(/fixture-github|fixture-provider-key/);
  });

  it("aggregates shared load once per queue-change pass while keeping queue totals account-local", async () => {
    await create();
    const a1 = await create("a"), a2 = await create("a"), b1 = await create("b");
    const capacity = vi.spyOn(runs as unknown as { capacity(): unknown }, "capacity");
    runs.drain(); await flush();
    expect(capacity).toHaveBeenCalledTimes(1);
    expect(runs.history(a1.id, 0).filter(e => e.type === "run.queued").at(-1).capacity.queued_total_for_account).toBe(2);
    expect(runs.history(a2.id, 0).filter(e => e.type === "run.queued").at(-1).capacity.queued_total_for_account).toBe(2);
    expect(runs.history(b1.id, 0).filter(e => e.type === "run.queued").at(-1).capacity.queued_total_for_account).toBe(1);
  });

  it("prefers the account with fewer occupied workspaces, then FIFO within each account", async () => {
    cfg.maxRuns = 2;
    const first = await create(), second = await create();
    const a1 = await create("a", "A first"), b1 = await create("b", "B first");
    const b2 = await create("b", "B second"), a2 = await create("a", "A second");
    // All admissions have the same timestamp: persistent sequence, not clock or ID,
    // must break ties. B gets capacity even though A joined earlier.
    await runs.close(first.id); await flush();
    expect(starts).toEqual([first.id, second.id, b1.id]);
    expect(vi.mocked(checkout).mock.calls.at(-1)?.[6]?.GH_TOKEN).toBe("fixture-github-b");
    await runs.close(second.id); await flush();
    expect(starts.at(-1)).toBe(a1.id);
    await runs.close(a1.id); await flush();
    expect(starts.at(-1)).toBe(a2.id); // B still occupies a workspace.
    await runs.close(b1.id); await flush();
    expect(starts.at(-1)).toBe(b2.id);
    expect(queuedIds()).toEqual([]);
  });

  it.each(["ready", "stopped", "failed"])("preserves a live %s workspace through the failed-retry grace or explicit close", async status => {
    const active = await create(), waiting = await create("b");
    if (status === "ready") await finish(active.id);
    else if (status === "stopped") { await runs.stop(active.id, "a"); await flush(); }
    else {
      workspaces.get(active.id)!.emit(
        { type: "turn.end", agent_id: "main", stop_reason: "error" },
        { type: "error", agent_id: "main", message: "Fixture model failure", retryable: false },
      );
      await flush();
    }
    expect(runs.get(active.id).status).toBe(status);
    runs.drain(); await flush();
    expect(starts).toEqual([active.id]);
    expect(releases).toEqual([]);
    expect(runs.get(waiting.id).status).toBe("queued");
    if (status === "failed") expect(runs.get(active.id).work_kept).toBe(true);
    await runs.closeSession(active.id, "a"); await flush();
    expect(starts).toEqual([active.id, waiting.id]);
  });

  it.each(["failure", "stop"])("reserves boot capacity and automatically releases it after boot %s", async outcome => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const release = holdCheckout(outcome === "failure");
    const booting = await create(), waiting = await create("b");
    expect(starts).toEqual([]);
    expect(checkout).toHaveBeenCalledTimes(1);
    if (outcome === "stop") await runs.stop(booting.id, "a");
    runs.drain(); await flush();
    expect(checkout).toHaveBeenCalledTimes(1); // Stopping doesn't release an in-flight boot early.
    release(); await flush();
    expect(runs.get(booting.id).status).toBe(outcome === "failure" ? "failed" : "stopped");
    expect(runs.get(booting.id).pending).toEqual([]);
    expect(starts).toEqual([waiting.id]);
    expect(checkout).toHaveBeenCalledTimes(2);
  });

  it("drains after a worker exits, without retrying the failed run ahead of waiting work", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const active = await create(), waiting = await create("b");
    workspaces.get(active.id)!.exit();
    await flush();
    // Worker-loss cleanup is independent of capacity reclamation. Checkpoint
    // restoration is covered by checkpoint-recovery.test.ts; this worker has none.
    expect(runs.get(active.id)).toMatchObject({ status: "failed", work_kept: false });
    expect(releases).toEqual([active.id]);
    await vi.waitFor(() => expect(starts).toEqual([active.id, waiting.id]));
  });

  it("reclaims model-failed work after the retry grace without a read or manual close", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const active = await create(), waiting = await create("b");
    workspaces.get(active.id)!.emit({ type: "error", agent_id: "main", message: "Fixture model failure" });
    await flush();
    expect(runs.get(active.id)).toMatchObject({ status: "failed", work_kept: true });
    expect(releases).toEqual([]);
    expect(starts).toEqual([active.id]);
    await vi.advanceTimersByTimeAsync(60_000); await flush();
    expect(runs.get(active.id)).toMatchObject({ status: "failed", work_kept: false });
    expect(runs.get(active.id).kept_commit).toBeUndefined();
    expect(releases).toEqual([active.id]);
    expect(starts).toEqual([active.id, waiting.id]);
  });

  it.each(["error", "end_turn", "interrupted"])("releases an exited worker with a %s event without requesting its hung evidence export", async stop_reason => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const active = await create(), waiting = await create("b");
    const workspace = workspaces.get(active.id)!;
    workspace.hangEvidenceExport = true;
    const exports = workspace.calls.filter(call => call.method === "export_state").length;
    workspace.exit({ type: "turn.end", agent_id: "main", stop_reason });
    await flush();
    expect(runs.get(active.id)).toMatchObject({ status: "failed", evidence: { unverified: ["Verification policy status unavailable."] } });
    expect(releases).toEqual([active.id]);
    expect(starts).toEqual([active.id, waiting.id]);
    expect(workspace.calls.filter(call => call.method === "export_state")).toHaveLength(exports);
    expect(workspace.calls.some(call => call.method === "snapshot")).toBe(false);
  });

  it("drains a destroyed worker's slot before checkout cleanup, but does not reopen that checkout until cleanup finishes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const active = await create(), waiting = await create("b");
    const cleanup = deferred<void>(); gates.push(cleanup);
    vi.mocked(rm).mockImplementationOnce(() => cleanup.promise);
    workspaces.get(active.id)!.exit();
    await flush();
    expect(rm).toHaveBeenCalledWith(join(dir, "checkouts", active.id), { recursive: true, force: true });
    expect(starts).toEqual([active.id, waiting.id]);
    runs.enqueue(active.id, "a", "Retry after cleanup");
    await runs.close(waiting.id); await flush();
    expect(starts).toEqual([active.id, waiting.id]);
    expect(runs.get(active.id).status).toBe("queued");
    cleanup.resolve(); await flush();
    expect(starts).toEqual([active.id, waiting.id, active.id]);
    expect(runs.get(active.id).pending.map(message => message.text)).toEqual(["Retry after cleanup"]);
  });

  it("reclaims a model-error workspace without waiting for its never-resolving evidence export", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const active = await create(), waiting = await create("b");
    const workspace = workspaces.get(active.id)!;
    workspace.hangEvidenceExport = true;
    const exports = workspace.calls.filter(call => call.method === "export_state").length;
    workspace.emit(
      { type: "turn.end", agent_id: "main", stop_reason: "error" },
      { type: "error", agent_id: "main", message: "Fixture model failure", retryable: false },
    );
    await flush();
    await vi.advanceTimersByTimeAsync(60_000); await flush(); // #34's failed-retry grace.
    expect(runs.get(active.id)).toMatchObject({ status: "failed", work_kept: false });
    expect(releases).toEqual([active.id]);
    expect(starts).toEqual([active.id, waiting.id]);
    expect(workspace.calls.filter(call => call.method === "export_state")).toHaveLength(exports);
  });

  it("reserves a reclaimed run through destruction and cleanup when other slots become free", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    cfg.maxRuns = 2;
    const active = await create(), other = await create("b"), waiting = await create("c");
    const workspace = workspaces.get(active.id)!;
    const destruction = deferred<void>(), cleanup = deferred<void>(); gates.push(destruction, cleanup);
    const destroy = workspace.destroy.bind(workspace);
    const destroying = vi.spyOn(workspace, "destroy").mockImplementation(async () => { await destruction.promise; await destroy(); });
    const remove = vi.mocked(rm).getMockImplementation()!;
    vi.mocked(rm).mockImplementationOnce(remove).mockImplementationOnce(() => cleanup.promise);
    workspace.emit({ type: "error", agent_id: "main", message: "Fixture failure", retryable: false });
    await flush();
    await vi.advanceTimersByTimeAsync(60_000); await flush();
    await runs.close(other.id); await flush();
    expect(destroying).toHaveBeenCalledTimes(1);
    expect(starts).toEqual([active.id, other.id, waiting.id]); // The other slot can be reused independently.
    destruction.resolve(); await flush();
    expect(starts).toEqual([active.id, other.id, waiting.id]);
    runs.enqueue(active.id, "a", "Retry after destruction");
    await flush();
    expect(runs.get(active.id).status).toBe("queued");
    cleanup.resolve(); await flush();
    expect(starts).toEqual([active.id, other.id, waiting.id, active.id]);
  });

  it("does not acknowledge or strand a follow-up on a disconnected failed-kept worker", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const active = await create();
    const workspace = workspaces.get(active.id)!;
    workspace.emit({ type: "error", agent_id: "main", message: "Fixture failure", retryable: false });
    await flush();
    expect(runs.get(active.id)).toMatchObject({ status: "failed", work_kept: true });
    Object.assign(workspace, { isAlive: () => false });
    const callsAtExit = workspace.calls.length;
    expect(() => runs.enqueue(active.id, "a", "Retry disconnected work", [], undefined, undefined, "disconnected-request"))
      .toThrow(expect.objectContaining({ code: "workspace_unavailable" }));
    expect(runs.get(active.id).pending).toEqual([]);
    expect(db.prepare("SELECT 1 FROM run_message_requests WHERE run_id=? AND request_id=?").get(active.id, "disconnected-request")).toBeUndefined();
    await runs.closeSession(active.id, "a"); await flush();
    expect(workspace.calls.slice(callsAtExit)).toEqual([]);
    runs.enqueue(active.id, "a", "Retry disconnected work", [], undefined, undefined, "disconnected-request");
    await flush();
    expect(starts).toEqual([active.id, active.id]);
    expect(db.prepare("SELECT 1 FROM run_message_requests WHERE run_id=? AND request_id=?").get(active.id, "disconnected-request")).toBeDefined();
    expect(runs.get(active.id).pending.map(message => message.text)).toContain("Retry disconnected work");
  });

  it.each(["flush", "export"])("bounds a hung evidence %s on a healthy worker without blocking publication or waiting work", async operation => {
    const active = await create(), waiting = await create("b");
    const workspace = workspaces.get(active.id)!;
    if (operation === "export") workspace.hangEvidenceExport = true;
    else workspace.flushCheckpoints = vi.fn(() => new Promise<void>(() => {}));
    const current = runs.get(active.id); current.pr_state = "merged"; runs.save(current);
    workspace.emit({ type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
    await flush();
    expect(starts).toEqual([active.id]);
    expect(importBundle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(importBundle).toHaveBeenCalledTimes(1);
    expect(runs.get(active.id)).toMatchObject({ status: "merged", evidence: { unverified: ["Verification policy status unavailable."] } });
    expect(releases).toEqual([active.id]);
    expect(starts).toEqual([active.id, waiting.id]);
    if (operation === "flush") expect(runs.history(active.id, 0).some(event => event.type === "run.checkpoint_unavailable")).toBe(true);
  });

  it.each(["ready", "stopped"])("persists the %s idle-release ledger and budgets before teardown without losing its checkpoint policy", async status => {
    const active = await create();
    if (status === "ready") await finish(active.id);
    else { await runs.stop(active.id, "a"); await flush(); }
    const workspace = workspaces.get(active.id)!;
    const run = runs.get(active.id);
    workspace.state.head = run.head_sha ?? run.base_sha!;
    run.evidence = { ...run.evidence!, gate_budget: 6, gate_rounds: 4 };
    runs.save(run);
    const saved = status === "ready" ? saveCheckpoint(active.id) : undefined;
    const key = workspace.calls.find(call => call.method === "init_evidence")!.args!.key as string;
    const record = signedRecord({ run_id: active.id, seq: 9 }, Buffer.from(key, "hex"));
    const reply = evidenceState(key);
    Object.assign(reply.state.evidence, { gate_rounds: 5, resumes: 3 });
    const rpc = workspace.rpc.bind(workspace);
    vi.spyOn(workspace, "rpc").mockImplementation(async (method, args) => {
      if (method === "export_state") {
        runs.append(active.id, { type: "evidence.recorded", record });
        return reply;
      }
      return rpc(method, args);
    });
    const destroy = workspace.destroy.bind(workspace);
    vi.spyOn(workspace, "destroy").mockImplementation(async () => {
      expect(runs.get(active.id).evidence).toMatchObject({ records: [record], last_seq: 9, gate_budget: 6, gate_rounds: 5, resumes: 3 });
      if (saved) expect(runs.checkpoints.load(saved.key)).not.toBeNull();
      await destroy();
    });
    const snapshots = workspace.calls.filter(call => call.method === "snapshot").length;
    const waiting = await create("b");
    vi.setSystemTime(Date.now() + 600_000);
    runs.drain(); await flush();
    expect(releases).toEqual([active.id]);
    expect(starts).toEqual([active.id, waiting.id]);
    expect(runs.get(active.id)).toMatchObject({ status, resume_from_checkpoint: !!saved,
      evidence: { records: [record], last_seq: 9, gate_budget: 6, gate_rounds: 5, resumes: 3 } });
    expect(workspace.calls.filter(call => call.method === "snapshot")).toHaveLength(snapshots + (status === "ready" ? 1 : 0));
    expect(JSON.stringify(runs.get(active.id))).not.toContain(key);
  });

  it("preserves a follow-up accepted while interrupted-turn evidence is being exported", async () => {
    const active = await create();
    const workspace = workspaces.get(active.id)!;
    const exportGate = deferred<void>(); gates.push(exportGate);
    const rpc = workspace.rpc.bind(workspace);
    vi.spyOn(workspace, "rpc").mockImplementation(async (method, args) => {
      const reply = await rpc(method, args);
      if (method === "export_state") await exportGate.promise;
      return reply;
    });
    await runs.stop(active.id, "a"); await flush();
    runs.enqueue(active.id, "a", "Follow-up during evidence");
    exportGate.resolve(); await flush();
    expect(workspace.users()).toEqual(["Implement it", "Follow-up during evidence"]);
    expect(runs.get(active.id)).toMatchObject({ status: "working", active_message: { text: "Follow-up during evidence" }, pending: [] });
  });

  it("does not probe, publish or deliver work after a worker disconnects during interrupted evidence capture", async () => {
    const active = await create(), waiting = await create("b");
    const workspace = workspaces.get(active.id)!;
    let alive = true;
    Object.assign(workspace, { isAlive: () => alive });
    const exportGate = deferred<void>(); gates.push(exportGate);
    const rpc = workspace.rpc.bind(workspace);
    vi.spyOn(workspace, "rpc").mockImplementation(async (method, args) => {
      const reply = await rpc(method, args);
      if (method === "export_state") await exportGate.promise;
      return reply;
    });
    await runs.stop(active.id, "a"); await flush();
    const callsAtExit = workspace.calls.length;
    alive = false;
    exportGate.resolve(); await flush();
    expect(workspace.calls.slice(callsAtExit)).toEqual([]);
    expect(runs.get(active.id)).toMatchObject({ status: "stopped", phase: "idle" });
    expect(releases).toEqual([active.id]);
    expect(starts).toEqual([active.id, waiting.id]);
    expect(importBundle).not.toHaveBeenCalled();
  });

  it("does not snapshot a released worker when publication identity resolution finishes after teardown", async () => {
    const active = await create(); await finish(active.id);
    const waiting = await create("b");
    const workspace = workspaces.get(active.id)!;
    const identityGate = deferred<void>(); gates.push(identityGate);
    let resolving = false;
    vi.mocked(commitIdentity).mockImplementationOnce(async () => {
      resolving = true;
      await identityGate.promise;
      return { name: "fixture", email: "123+fixture@users.noreply.github.com" };
    });
    const closing = expect(runs.closeSession(active.id, "a")).rejects.toMatchObject({ step: "snapshot", attempts: 1 });
    await flush();
    expect(resolving).toBe(true);
    await runs.close(active.id); await flush();
    const callsAtRelease = workspace.calls.length;
    identityGate.resolve();
    await closing; await flush();
    expect(workspace.calls.slice(callsAtRelease)).toEqual([]);
    expect(runs.get(active.id)).toMatchObject({ status: "ready", phase: "idle" });
    expect(starts).toEqual([active.id, waiting.id]);
  });

  it("starts waiting work when a merged turn finishes and releases its workspace", async () => {
    const active = await create(), waiting = await create("b");
    const current = runs.get(active.id); current.pr_state = "merged"; runs.save(current);
    workspaces.get(active.id)!.emit({ type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
    await flush();
    expect(runs.get(active.id).status).toBe("merged");
    expect(releases).toEqual([active.id]);
    await vi.waitFor(() => expect(starts).toEqual([active.id, waiting.id]));
  });

  it("keeps replacement messages accepted while a stopped startup is still unwinding", async () => {
    cfg.maxRuns = 2;
    const release = holdCheckout(true);
    const cancelled = await create();
    await runs.stop(cancelled.id, "a");
    runs.enqueue(cancelled.id, "a", "Replacement", [], undefined, undefined, "replacement-1");
    const later = await create("a", "Later for the same account");
    expect(runs.get(cancelled.id)).toMatchObject({ status: "queued", queue_position: 1 });
    expect(starts).toEqual([]); // Can't double-claim the old boot or jump its account head.
    release(); await flush();
    expect(workspaces.get(cancelled.id)!.users()).toEqual(["Replacement"]);
    expect(workspaces.get(later.id)!.users()).toEqual(["Later for the same account"]);
    expect(checkout).toHaveBeenCalledTimes(3);
  });

  it("waits for boot teardown before deleting its row and drains other accounts safely", async () => {
    cfg.maxRuns = 2;
    const release = holdCheckout();
    const booting = await create(), live = await create("b"), waiting = await create("c");
    const removing = runs.remove(booting.id, "a");
    await runs.close(live.id); await flush();
    expect(starts).toEqual([live.id, waiting.id]);
    release(); await removing; await flush();
    expect(() => runs.get(booting.id)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => runs.drain()).not.toThrow();
    expect(starts).not.toContain(booting.id);
  });

  it("tracks a replacement startup until shutdown completes instead of losing its launch receipt", async () => {
    const releaseOriginal = holdCheckout();
    const run = await create();
    await runs.stop(run.id, "a");
    runs.enqueue(run.id, "a", "Replacement");
    const releaseReplacement = holdCheckout();
    releaseOriginal(); await flush();
    expect(checkout).toHaveBeenCalledTimes(2);
    let closed = false;
    const shutdown = runs.shutdown().then(() => { closed = true; });
    await flush();
    expect(closed).toBe(false);
    releaseReplacement(); await shutdown;
    expect(closed).toBe(true);
    expect(starts).toEqual([]);
  });

  it("validates saved model and GitHub access before admitting a closed-run follow-up", async () => {
    const closed = await create(); await finish(closed.id); await runs.closeSession(closed.id, "a");
    await create("b");
    db.prepare("DELETE FROM github_connections WHERE user_id='a'").run();
    await expect(runs.validateFollowUp(closed.id, "a")).rejects.toMatchObject({ code: "github_required" });
    expect(() => runs.enqueue(closed.id, "a", "Continue")).toThrow(expect.objectContaining({ code: "github_required" }));
    db.prepare("INSERT INTO github_connections(user_id,token,connected_at) VALUES(?,?,?)").run("a", seal(cfg.secret, "fixture-github-a"), Date.now());
    vi.spyOn(runs, "resolveSelection").mockRejectedValueOnce(new Error("Saved model unavailable"));
    await expect(runs.validateFollowUp(closed.id, "a")).rejects.toThrow("Saved model unavailable");
    expect(runs.get(closed.id).pending).toEqual([]);
    expect(queuedIds()).toEqual([]);
  });

  it("accepts HTTP and MCP starts at capacity, shares cancellation and durably deduplicates queued messages", async () => {
    const active = await create();
    const auth = await createAuthentication(db, cfg);
    const { app, mcp, githubLogin } = createApp(db, cfg, auth, runs);
    const client = new Client({ name: "queue-fixture", version: "1" });
    try {
      const registration = await app.request(cfg.origin + "/api/auth/sign-up/email", {
        method: "POST", headers: { origin: cfg.origin, "content-type": "application/json" },
        body: JSON.stringify({ name: "Queue", email: "queue@example.test", password: "fixture-password-long-enough" }),
      });
      expect(registration.status).toBe(200);
      const user = (await registration.json()).user.id;
      const cookie = registration.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
      db.prepare("INSERT INTO github_connections(user_id,token,connected_at) VALUES(?,?,?)")
        .run(user, seal(cfg.secret, "fixture-github-queue"), Date.now());
      const response = await app.request(cfg.origin + "/api/v1/runs", {
        method: "POST", headers: { cookie, origin: cfg.origin, "content-type": "application/json" },
        body: JSON.stringify(input("HTTP start")),
      });
      expect(response.status).toBe(201);
      const http = await response.json();
      const capacity = { max: 1, occupied: 1, working: 1, idle_releasable: 0, queued_total_for_account: 1 };
      const queue_reason = "All 1 workspace is in use: 1 working, 0 idle. Idle workspaces can be closed to free a slot.";
      expect(http).toMatchObject({ status: "queued", queue_position: 1, queue_length: 1, capacity, queue_reason });
      for (const path of [`/api/v1/runs/${http.id}`, "/api/v1/runs"]) {
        const read = await app.request(cfg.origin + path, { headers: { cookie } });
        expect(read.status).toBe(200);
        const data = await read.json();
        expect(data.runs ? data.runs[0] : data).toMatchObject({ capacity, queue_reason });
      }
      const token = createToken(db, user, "Queue fixture");
      await client.connect(new StreamableHTTPClientTransport(new URL(cfg.origin + "/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${token.token}` } },
        fetch: async (url, init) => mcp.fetch(new Request(url, init)),
      }));
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        return JSON.parse((result.content as { text: string }[])[0].text);
      };
      const args = { ...input("MCP start"), request_id: "start-1" };
      const started = await call("start_session", args);
      capacity.queued_total_for_account = 2;
      expect(started).toMatchObject({ state: "queued", queue_position: 2, queue_length: 2, capacity, queue_reason });
      expect(await call("get_session", { session_id: http.id })).toMatchObject({ capacity, queue_reason });
      expect(await call("read_session_events", { session_id: http.id })).toMatchObject({ capacity, queue_reason });
      expect((await call("list_sessions")).sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: http.id, capacity, queue_reason })]));
      expect(runs.history(http.id, 0).filter(e => e.type === "run.queued").at(-1)).toMatchObject({ capacity, queue_reason });
      expect((await call("start_session", args)).id).toBe(started.id);
      expect((await call("get_session", { session_id: http.id })).queue_length).toBe(2);
      expect((await call("list_sessions")).sessions.map((r: { id: string }) => r.id).sort()).toEqual([http.id, started.id].sort());
      await call("stop_session", { session_id: http.id });
      expect(runs.get(http.id, user)).toMatchObject({ status: "stopped", pending: [] });
      const message = { session_id: http.id, request_id: "message-1", text: "Reopen when free" };
      await call("send_session_message", message);
      await call("send_session_message", message);
      expect(runs.get(http.id, user)).toMatchObject({ status: "queued", queue_position: 2, queue_length: 2 });
      expect(runs.get(http.id, user).pending.map(p => p.text)).toEqual([message.text]);
      expect(countRuns()).toBe(3);
      await runs.close(active.id); await flush();
      expect(starts).toEqual([active.id, started.id]);
      expect(await call("start_session", args)).toMatchObject({ id: started.id, state: "working" });
      await runs.close(started.id); await flush();
      expect(workspaces.get(http.id)!.users()).toEqual([message.text]);
    } finally { await client.close(); await mcp.close(); await githubLogin.close(); }
  });

  it("shows capacity then releases the oldest safe idle workspace for account-fair waiting work", async () => {
    cfg.maxRuns = 2;
    const oldest = await create(), newer = await create();
    await finish(oldest.id);
    vi.setSystemTime(Date.now() + 1000);
    await finish(newer.id);
    const a1 = await create("a", "A first"), b1 = await create("b", "B first"), a2 = await create("a", "A second");
    expect(runs.get(a1.id).capacity).toEqual({ max: 2, occupied: 2, working: 0, idle_releasable: 0, queued_total_for_account: 2 });
    vi.setSystemTime(Date.now() + 600_000);
    expect(runs.get(a1.id).capacity?.idle_releasable).toBe(2);
    const gate = deferred<void>(); gates.push(gate);
    const workspace = workspaces.get(oldest.id)!;
    const destroy = workspace.destroy.bind(workspace);
    vi.spyOn(workspace, "destroy").mockImplementationOnce(async () => { await gate.promise; await destroy(); });
    runs.drain(); await flush();
    runs.drain(); runs.drain(); await flush();
    expect(starts).toEqual([oldest.id, newer.id]);
    expect(workspaces.get(newer.id)!.calls.filter(c => c.method === "snapshot")).toHaveLength(1);
    gate.resolve(); await flush();
    expect(releases).toEqual([oldest.id, newer.id]);
    expect(starts).toEqual([oldest.id, newer.id, b1.id, a1.id]); // B has fewer occupied slots; A remains FIFO.
    expect(queuedIds()).toEqual([a2.id]);
    expect(runs.history(oldest.id, 0).filter(e => e.type === "run.released"))
      .toEqual([expect.objectContaining({ reason: "idle_for_waiting_work" })]);
    expect(runs.get(oldest.id)).toMatchObject({ status: "ready", pushed: true, phase: "idle" });
    await runs.close(b1.id); await flush();
    expect(starts.at(-1)).toBe(a2.id);
    runs.enqueue(oldest.id, "a", "Reopen released branch");
    await runs.close(a1.id); await flush();
    expect(vi.mocked(checkout).mock.calls.at(-1)?.[5]).toBe(true);
    expect(workspaces.get(oldest.id)!.users()).toEqual(["Reopen released branch"]);
  });

  it.each(["open", "merged"] as const)("automatically starts tiny queued work when every slot is idle, with the oldest PR %s", async oldestState => {
    cfg.maxRuns = 2;
    const oldest = await create(); await finish(oldest.id);
    vi.setSystemTime(Date.now() + 1000);
    const newer = await create(); await finish(newer.id);
    for (const [id, state] of [[oldest.id, oldestState], [newer.id, oldestState === "open" ? "merged" : "open"]] as const) {
      const run = runs.get(id);
      run.pr_number = id === oldest.id ? 1 : 2;
      run.pr_state = state;
      runs.save(run);
      expect(run).toMatchObject({ status: "ready", pushed: true });
    }
    const reclaim = vi.spyOn(runs, "close");
    const waiting = await create("b", "Say OK");
    expect(runs.get(waiting.id)).toMatchObject({ status: "queued", capacity: { occupied: 2, working: 0 } });

    // Only the service safety-net timer runs: no manual close, drain or polling.
    await vi.advanceTimersByTimeAsync(600_000); await flush();
    await vi.waitFor(() => expect(workspaces.get(waiting.id)?.users()).toEqual(["Say OK"]));
    expect(releases).toEqual([oldest.id]);
    expect(reclaim).toHaveBeenCalledWith(oldest.id, false, true);
    expect(starts).toEqual([oldest.id, newer.id, waiting.id]);
    expect(workspaces.get(waiting.id)!.users()).toEqual(["Say OK"]);
    expect(runs.get(waiting.id).status).toBe("working");
    expect(queuedIds()).toEqual([]);
    expect(workspaces.get(oldest.id)!.calls.filter(c => c.method === "snapshot")).toHaveLength(2);
    expect(runs.history(oldest.id, 0)).toContainEqual(expect.objectContaining({ type: "run.released", reason: "idle_for_waiting_work" }));
  });

  it.each([false, true])("releases the oldest safe stopped workspace at the three-slot cap (published: %s)", async published => {
    cfg.maxRuns = 3;
    const stopped: string[] = [];
    for (let i = 0; i < 3; i++) {
      const run = await create("a", `Stopped ${i}`);
      if (published) {
        await finish(run.id);
        runs.enqueue(run.id, "a", "Started follow-up then stopped"); await flush();
      } else workspaces.get(run.id)!.state.head = run.base_sha!;
      await runs.stop(run.id, "a");
      // The pump uses a real bounded poll delay; wait for turn-end, not just Stop acceptance.
      await vi.waitFor(() => expect((runs as unknown as { live: Map<string, { busy: boolean }> }).live.get(run.id)?.busy).toBe(false));
      await flush();
      expect(runs.get(run.id)).toMatchObject({ status: "stopped", pending: [], pushed: published });
      stopped.push(run.id);
      vi.setSystemTime(Date.now() + 1000);
    }
    const publications = vi.mocked(importBundle).mock.calls.length;
    const waiting = await create("b", "Say OK");
    expect(runs.get(waiting.id)).toMatchObject({ status: "queued", capacity: { max: 3, occupied: 3, working: 0, idle_releasable: 0 } });
    await vi.advanceTimersByTimeAsync(540_000); await flush();
    expect(releases).toEqual([]);
    // No manual close, drain or read: the normal safety-net tick starts waiting work.
    await vi.advanceTimersByTimeAsync(60_000); await flush();
    await vi.waitFor(() => expect(workspaces.get(waiting.id)?.users()).toEqual(["Say OK"]));
    expect(releases).toEqual([stopped[0]]);
    expect(starts).toEqual([...stopped, waiting.id]);
    expect(importBundle).toHaveBeenCalledTimes(publications); // Stop is never bypassed by an automatic push.
    expect(runs.get(stopped[0]!)).toMatchObject({ status: "stopped", pushed: published, phase: "idle" });
    expect(runs.history(stopped[0]!, 0)).toContainEqual(expect.objectContaining({ type: "run.released", reason: "idle_for_waiting_work" }));
  });

  it.each(["dirty", "unpublished commit", "question", "pending message", "CI watch"])("keeps unsafe stopped workspaces: %s", async unsafe => {
    const active = await create(); await finish(active.id);
    await runs.stop(active.id, "a"); await flush();
    const run = runs.get(active.id);
    if (unsafe === "dirty") workspaces.get(active.id)!.state.clean = false;
    if (unsafe === "unpublished commit") { run.pushed = false; run.head_sha = null; workspaces.get(active.id)!.state.head = "c".repeat(40); }
    if (unsafe === "question") run.summary.question = { request_id: "q", question: "Which?" };
    if (unsafe === "pending message") run.pending.push({ text: "Still pending", images: [] });
    if (unsafe === "CI watch") run.ci_active = true;
    runs.save(run);
    const waiting = await create("b");
    await vi.advanceTimersByTimeAsync(600_000); await flush();
    expect(releases).toEqual([]);
    expect(starts).toEqual([active.id]);
    expect(runs.get(waiting.id).status).toBe("queued");
    expect(importBundle).toHaveBeenCalledTimes(1);
  });

  it.each(["dirty", "different head", "question", "waiting for input", "CI watch", "pending message", "interrupted", "auto resume", "checkpoint resume", "recovery finishing", "merged pending"])("does not release unsafe %s workspaces", async unsafe => {
    const active = await create(); await finish(active.id);
    if (unsafe === "dirty") workspaces.get(active.id)!.state.clean = false;
    else if (unsafe === "different head") workspaces.get(active.id)!.state.head = "c".repeat(40);
    else {
      const r = runs.get(active.id);
      if (unsafe === "question") r.summary.question = { request_id: "q", question: "Which?" };
      if (unsafe === "waiting for input") {
        r.status = "working";
        r.summary.question = { request_id: "q", question: "Which?" };
      }
      if (unsafe === "CI watch") r.ci_active = true;
      if (unsafe === "pending message") r.pending.push({ text: "Pending", images: [] });
      if (unsafe === "interrupted") { r.status = "working"; runs.save(r); r.status = "interrupted"; }
      if (unsafe === "auto resume") { r.phase = "auto_resume_pending"; r.auto_resume_pending = true; }
      if (unsafe === "checkpoint resume") r.resume_from_checkpoint = true;
      if (unsafe === "recovery finishing") r.recovery_phase = "finishing";
      if (unsafe === "merged pending") { r.pr_state = "merged"; r.phase = "merged_pending"; }
      runs.save(r);
    }
    const waiting = await create("b");
    vi.setSystemTime(Date.now() + 600_000);
    runs.drain(); await flush();
    expect(releases).toEqual([]);
    expect(starts).toEqual([active.id]);
    expect(runs.get(waiting.id).status).toBe("queued");
    expect(runs.get(waiting.id).capacity?.idle_releasable).toBe(0);
    expect(runs.history(active.id, 0).some(e => e.type === "run.released")).toBe(false);
  });

  it.each([
    ["before selection", "release"], ["before selection", "consume"],
    ["during evidence", "release"], ["during publication", "release"],
  ] as const)("protects a checkpoint claim acquired %s until %s, then preserves the checkpoint on idle close", async (when, completion) => {
    const active = await create(); await finish(active.id);
    const saved = saveCheckpoint(active.id);
    let claim: ReturnType<typeof runs.checkpoints.claim> = null;
    const acquire = () => { claim = runs.checkpoints.claim(saved.key); expect(claim).not.toBeNull(); };
    if (when === "before selection") acquire();
    const workspace = workspaces.get(active.id)!;
    const rpc = workspace.rpc.bind(workspace);
    vi.spyOn(workspace, "rpc").mockImplementation((method, args) => {
      if (!claim && ((when === "during evidence" && method === "workspace_state") ||
          (when === "during publication" && method === "snapshot"))) acquire();
      return rpc(method, args);
    });
    const waiting = await create("b", "Say OK");
    vi.setSystemTime(Date.now() + 600_000);
    runs.drain(); await flush();
    expect(claim).not.toBeNull();
    expect(releases).toEqual([]);
    expect(starts).toEqual([active.id]);
    expect(runs.get(waiting.id)).toMatchObject({ status: "queued", capacity: { occupied: 1, idle_releasable: 0 } });
    expect(runs.history(active.id, 0).some(e => e.type === "run.released")).toBe(false);
    expect(db.prepare("SELECT claimed_by,consumed_at FROM run_checkpoints WHERE seq=?").get(saved.checkpoint.seq))
      .toMatchObject({ claimed_by: claim!.claimToken, consumed_at: null });
    expect(existsSync(saved.bundlePath) && existsSync(saved.statePath)).toBe(true);

    if (completion === "consume") runs.checkpoints.consumeClaim(saved.key, saved.checkpoint.seq, claim!.claimToken);
    else runs.checkpoints.release(saved.key, saved.checkpoint.seq, claim!.claimToken);
    await vi.advanceTimersByTimeAsync(60_000); await flush();
    expect(releases).toEqual([active.id]);
    expect(starts).toEqual([active.id, waiting.id]);
    expect(db.prepare("SELECT 1 FROM run_checkpoints WHERE run_id=?").get(active.id)).toBeDefined();
    expect(existsSync(saved.bundlePath) && existsSync(saved.statePath)).toBe(true);
    expect(runs.history(active.id, 0)).toContainEqual(expect.objectContaining({ type: "run.released", reason: "idle_for_waiting_work" }));
  });

  it("retains checkpoints on preserving close and discards them on a later ordinary close", async () => {
    const active = await create(); await finish(active.id);
    const saved = saveCheckpoint(active.id);
    await runs.close(active.id, false, true);
    expect(runs.checkpoints.load(saved.key)?.checkpoint.seq).toBe(saved.checkpoint.seq);
    expect(existsSync(saved.bundlePath) && existsSync(saved.statePath)).toBe(true);
    await runs.closeSession(active.id, "a");
    expect(runs.checkpoints.load(saved.key)).toBeNull();
    expect(existsSync(saved.bundlePath) || existsSync(saved.statePath)).toBe(false);
  });

  it("retains a workspace if publication creates new edits or a background writer", async () => {
    const active = await create(); await finish(active.id);
    const waiting = await create("b");
    const workspace = workspaces.get(active.id)!;
    const rpc = workspace.rpc.bind(workspace);
    vi.spyOn(workspace, "rpc").mockImplementation((method, args) => {
      if (method === "workspace_state" && workspace.calls.filter(c => c.method === "snapshot").length >= 2)
        return Promise.resolve({ head: "b".repeat(40), clean: false });
      return rpc(method, args);
    });
    vi.setSystemTime(Date.now() + 600_000);
    runs.drain(); await flush();
    expect(workspace.calls.filter(c => c.method === "snapshot")).toHaveLength(2);
    expect(releases).toEqual([]);
    expect(runs.get(active.id).status).toBe("ready");
    expect(runs.get(waiting.id)).toMatchObject({ status: "queued", capacity: { idle_releasable: 0 } });
    expect(runs.history(active.id, 0).some(e => e.type === "run.released")).toBe(false);
  });

  it("reprobes transient dirty evidence and starts waiting work without another turn or read", async () => {
    const active = await create();
    const workspace = workspaces.get(active.id)!;
    workspace.state.clean = false;
    await finish(active.id);
    const waiting = await create("b");
    vi.setSystemTime(Date.now() + 600_000);
    runs.drain(); await flush();
    expect(releases).toEqual([]);
    workspace.state.clean = true;
    await vi.advanceTimersByTimeAsync(60_000); await flush();
    expect(releases).toEqual([active.id]);
    expect(starts).toEqual([active.id, waiting.id]);
  });

  it("does not let a slow unsuccessful probe starve a newer safe idle workspace", async () => {
    cfg.maxRuns = 2;
    const oldest = await create(); await finish(oldest.id);
    vi.setSystemTime(Date.now() + 1000);
    const newer = await create(); await finish(newer.id);
    const waiting = await create("b");
    const workspace = workspaces.get(oldest.id)!;
    const rpc = workspace.rpc.bind(workspace);
    const probe = deferred<{ head: string; clean: boolean }>();
    vi.spyOn(workspace, "rpc").mockImplementation((method, args) => method === "workspace_state" ? probe.promise : rpc(method, args));
    vi.setSystemTime(Date.now() + 600_000);
    runs.drain(); await flush();
    vi.setSystemTime(Date.now() + 600_000); // Probe took longer than the retry cooldown.
    probe.resolve({ head: "b".repeat(40), clean: false });
    await flush();
    expect(releases).toEqual([newer.id]);
    expect(starts).toEqual([oldest.id, newer.id, waiting.id]);
    expect(runs.get(oldest.id).status).toBe("ready");
  });

  it("automatically retries failed teardown with backoff, preserving capacity and checkpoints", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const active = await create(); await finish(active.id);
    const saved = saveCheckpoint(active.id);
    const waiting = await create("b");
    const destroy = vi.spyOn(workspaces.get(active.id)!, "destroy").mockRejectedValueOnce(new Error("fixture cleanup failed"));
    vi.setSystemTime(Date.now() + 600_000);
    runs.drain(); await flush();
    expect(starts).toEqual([active.id]);
    expect(runs.get(waiting.id)).toMatchObject({ status: "queued", capacity: { occupied: 1 } });
    expect(runs.get(active.id).resume_from_checkpoint).toBe(true);
    expect(runs.checkpoints.load(saved.key)?.checkpoint.seq).toBe(saved.checkpoint.seq);
    expect(runs.history(active.id, 0).some(e => e.type === "run.released")).toBe(false);
    expect(() => runs.enqueue(active.id, "a", "Must not be lost")).toThrow(expect.objectContaining({ code: "workspace_closing" }));
    await vi.advanceTimersByTimeAsync(999); await flush();
    expect(destroy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await flush();
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(releases).toEqual([active.id]);
    expect(starts).toEqual([active.id, waiting.id]);
    expect(runs.checkpoints.load(saved.key)?.checkpoint.seq).toBe(saved.checkpoint.seq);
    expect(runs.history(active.id, 0)).toContainEqual(expect.objectContaining({ type: "run.released" }));
  });

  it("gives up teardown after five attempts, emits once, and permits an explicit retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const active = await create(); await finish(active.id);
    const waiting = await create("b");
    const workspace = workspaces.get(active.id)!;
    const original = workspace.destroy.bind(workspace);
    const destroy = vi.spyOn(workspace, "destroy").mockRejectedValue(new Error("fixture cleanup failed"));
    await expect(runs.closeSession(active.id, "a")).rejects.toThrow("fixture cleanup failed");
    for (const delay of [1000, 2000, 4000, 8000]) {
      await vi.advanceTimersByTimeAsync(delay - 1); await flush();
      const attempts = destroy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1); await flush();
      expect(destroy).toHaveBeenCalledTimes(attempts + 1);
    }
    expect(destroy).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(120_000); await flush();
    expect(destroy).toHaveBeenCalledTimes(5);
    expect(runs.history(active.id, 0).filter(e => e.type === "run.cleanup"))
      .toEqual([expect.objectContaining({ state: "gave_up", attempts: 5 })]);
    expect(runs.get(waiting.id)).toMatchObject({ status: "queued", capacity: { occupied: 1 } });
    destroy.mockImplementation(original);
    await runs.closeSession(active.id, "a"); await flush();
    expect(starts).toEqual([active.id, waiting.id]);
  });

  it("discards a checkpoint on explicit Close even while automatic teardown is pending", async () => {
    const active = await create(); await finish(active.id);
    const saved = saveCheckpoint(active.id);
    const waiting = await create("b");
    const gate = deferred<void>(); gates.push(gate);
    const workspace = workspaces.get(active.id)!;
    const original = workspace.destroy.bind(workspace);
    const destroy = vi.spyOn(workspace, "destroy").mockImplementationOnce(async () => { await gate.promise; await original(); });
    vi.setSystemTime(Date.now() + 600_000);
    runs.drain(); await flush();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(runs.checkpoints.load(saved.key)).not.toBeNull();
    await runs.closeSession(active.id, "a");
    expect(runs.checkpoints.load(saved.key)).toBeNull();
    expect(runs.get(active.id).resume_from_checkpoint).toBe(false);
    gate.resolve(); await flush();
    expect(starts).toEqual([active.id, waiting.id]);
    expect(runs.checkpoints.load(saved.key)).toBeNull();
  });

  it("does not let exhausted teardown prevent reclaiming another failed-kept slot", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    cfg.maxRuns = 2;
    const stuck = await create(); await finish(stuck.id);
    const failed = await create();
    workspaces.get(failed.id)!.emit({ type: "error", agent_id: "main", message: "Fixture model failure" });
    await flush();
    const waiting = await create("b");
    const destroy = vi.spyOn(workspaces.get(stuck.id)!, "destroy").mockRejectedValue(new Error("fixture cleanup failed"));
    await expect(runs.closeSession(stuck.id, "a")).rejects.toThrow("fixture cleanup failed");
    for (const delay of [1000, 2000, 4000, 8000]) { await vi.advanceTimersByTimeAsync(delay); await flush(); }
    expect(destroy).toHaveBeenCalledTimes(5);
    expect(starts).toEqual([stuck.id, failed.id]);
    await vi.advanceTimersByTimeAsync(45_000); await flush();
    expect(releases).toEqual([failed.id]);
    expect(starts).toEqual([stuck.id, failed.id, waiting.id]);
    expect(runs.get(failed.id)).toMatchObject({ status: "failed", work_kept: false });
    expect(destroy).toHaveBeenCalledTimes(5);
  });

  it("leaves old safe idle workspaces open without waiting work", async () => {
    const active = await create(); await finish(active.id);
    vi.setSystemTime(Date.now() + 3600_000);
    runs.drain(); await flush();
    expect(releases).toEqual([]);
    expect(runs.get(active.id).status).toBe("ready");
  });

  it("does not release when idle release is disabled", async () => {
    await runs.shutdown();
    vi.stubEnv("GOND_AGENT_IDLE_RELEASE_SECONDS", "0");
    runs = new Runs(db, cfg, factory);
    const active = await create(); await finish(active.id);
    vi.setSystemTime(Date.now() + 3600_000);
    runs.drain(); await flush();
    const waiting = await create("b");
    runs.drain(); await flush();
    expect(releases).toEqual([]);
    expect(runs.get(waiting.id).capacity?.idle_releasable).toBe(0);
    expect(starts).toEqual([active.id]);
  });

  it("runtime evidence: two slots, one working, one idle, one waiting", async () => {
    cfg.maxRuns = 2;
    const idle = await create("a", "Idle"), working = await create("a", "Working");
    await finish(idle.id);
    const waiting = await create("b", "Waiting");
    const before = runs.get(waiting.id);
    console.log(`BEFORE (legacy queue projection): queued, position ${before.queue_position} of ${before.queue_length}; reason absent`);
    console.log(`AFTER visibility: ${before.queue_reason}`);
    expect(before.capacity).toEqual({ max: 2, occupied: 2, working: 1, idle_releasable: 0, queued_total_for_account: 1 });
    vi.setSystemTime(Date.now() + 600_000);
    console.log(`AT 600s: idle_releasable=${runs.get(waiting.id).capacity?.idle_releasable}`);
    runs.drain(); await flush();
    const event = runs.history(idle.id, 0).find(e => e.type === "run.released");
    expect(event?.reason).toBe("idle_for_waiting_work");
    expect(starts).toEqual([idle.id, working.id, waiting.id]);
    expect(releases).toEqual([idle.id]);
    console.log(`RELEASE: ${event!.reason}; idle closed; working untouched; waiting=${runs.get(waiting.id).status}`);
  });

  it("bounds waiting runs globally and per account, without leaving partial runs or claiming images", async () => {
    cfg.queueMax = 3; cfg.queueMaxPerAccount = 2;
    await create();
    const own = await create(); await create();
    runs.enqueue(own.id, "a", "Another message for the same waiting run");
    expect(runs.get(own.id).pending).toHaveLength(2); // Bounds count runs, not messages.
    expect(queuedIds()).toHaveLength(2);
    db.prepare("INSERT INTO images(id,user_id,media_type,bytes,created_at) VALUES(?,?,?,?,?)")
      .run("img_bound", "a", "image/png", Buffer.from("png"), Date.now());
    const full = { status: 429, code: "queue_full", message: "Too many runs are waiting. Try again later." };
    await expect(runs.create("a", { ...input(), images: ["img_bound"] })).rejects.toMatchObject(full);
    expect(countRuns()).toBe(3);
    expect(db.prepare("SELECT run_id FROM images WHERE id='img_bound'").get()).toEqual({ run_id: null });
    await create("b");
    await expect(runs.create("c", input())).rejects.toMatchObject(full);
    expect(countRuns()).toBe(4);
    expect(queuedIds()).toHaveLength(3);
    expect(starts).toHaveLength(1);
  });

  it("uses the default ten-waiting-runs account bound when queue settings are omitted", async () => {
    await create();
    for (let i = 0; i < 10; i++) await create("a", `Waiting ${i}`);
    await expect(runs.create("a", input())).rejects.toMatchObject({ code: "queue_full" });
    const other = await create("b");
    expect(runs.get(other.id)).toMatchObject({ queue_position: 1, queue_length: 1 });
    expect(queuedIds()).toHaveLength(11);
  });

  it("still validates requests at capacity instead of persisting invalid queued work", async () => {
    await create();
    const invalid: [Partial<Parameters<Runs["create"]>[1]>, string][] = [
      [{ prompt: " " }, "invalid_request"], [{ repo: "not-a-repo" }, "invalid_request"],
      [{ backend: "codex" }, "invalid_backend"], [{ base_branch: "../bad" }, "invalid_branch"],
      [{ model: "" }, "invalid_model"], [{ images: ["missing-image"] }, "image_not_found"],
    ];
    for (const [bad, code] of invalid)
      await expect(runs.create("a", { ...input(), ...bad })).rejects.toMatchObject({ code });
    db.prepare("DELETE FROM github_connections WHERE user_id='c'").run();
    await expect(runs.create("c", input())).rejects.toMatchObject({ code: "github_required" });
    expect(countRuns()).toBe(1);
    expect(queuedIds()).toEqual([]);
    expect(checkout).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "closeSession", "close", "remove"] as const)("cancels queued work through %s without ever starting it", async action => {
    const active = await create(), cancelled = await create("b"), survivor = await create("b");
    await expect(runs.stop(cancelled.id, "a")).rejects.toMatchObject({ code: "not_found" });
    if (action === "close") await runs.close(cancelled.id);
    else await runs[action](cancelled.id, "b");
    expect(membership(cancelled.id)).toEqual({ queue_seq: null, queued_at: null });
    if (action === "remove") expect(() => runs.get(cancelled.id, "b")).toThrow(expect.objectContaining({ code: "not_found" }));
    else expect(runs.get(cancelled.id)).toMatchObject({ status: "stopped", pending: [] });
    expect(runs.get(survivor.id)).toMatchObject({ queue_position: 1, queue_length: 1 });
    await runs.close(active.id); await flush();
    expect(starts).toEqual([active.id, survivor.id]);
    expect(releases).toEqual([active.id]);
  });

  it("queues follow-ups to closed runs, preserving their history and branch", async () => {
    const original = await create(); await finish(original.id);
    const history = runs.history(original.id, 0);
    await runs.closeSession(original.id, "a");
    const active = await create("b");
    runs.enqueue(original.id, "a", "Continue on the saved branch");
    const position = membership(original.id);
    runs.enqueue(original.id, "a", "Then add a test");
    expect(membership(original.id)).toEqual(position); // One waiting run, not one slot per message.
    expect(runs.get(original.id)).toMatchObject({ status: "queued", queue_position: 1, queue_length: 1 });
    expect(runs.get(original.id).pending.map(p => p.text)).toEqual(["Continue on the saved branch", "Then add a test"]);
    await runs.close(active.id); await flush();
    expect(starts).toEqual([original.id, active.id, original.id]);
    expect(vi.mocked(checkout).mock.calls.at(-1)?.slice(4, 6)).toEqual([original.branch, true]);
    expect(runs.history(original.id, 0).slice(0, history.length)).toEqual(history);
    expect(workspaces.get(original.id)!.users()).toEqual(["Continue on the saved branch"]);
  });

  it("deduplicates attributed creates and request-ID follow-ups, including after restart", async () => {
    await create();
    const attribution = { id: "run_attributed", tokenId: "token_fixture", authorize: vi.fn() };
    const request = { ...input("Original"), source: "mcp" };
    const [a, b] = await Promise.all([runs.create("b", request, attribution), runs.create("b", request, attribution)]);
    expect(a.id).toBe(attribution.id); expect(b.id).toBe(a.id);
    expect(runs.get(a.id)).toMatchObject({ source: "mcp", mcp_token_id: attribution.tokenId });
    runs.enqueue(a.id, "b", "Follow-up", [], undefined, undefined, "message-1");
    const order = membership(a.id);
    runs.enqueue(a.id, "b", "Follow-up", [], undefined, undefined, "message-1");
    expect(countRuns()).toBe(2);
    expect(runs.get(a.id).pending.map(p => p.text)).toEqual(["Original", "Follow-up"]);
    expect(runs.history(a.id, 0).filter(e => e.type === "user")).toHaveLength(2);
    expect(attribution.authorize).toHaveBeenCalled();
    await runs.shutdown();
    runs = new Runs(db, cfg, factory);
    // Retry before recovery drains the persisted queue.
    await runs.create("b", request, attribution);
    runs.enqueue(a.id, "b", "Follow-up", [], undefined, undefined, "message-1");
    expect(membership(a.id)).toEqual(order);
    expect(runs.get(a.id).pending).toHaveLength(2);
    expect(runs.history(a.id, 0).filter(e => e.type === "user")).toHaveLength(2);
    await runs.recover(); await flush();
    expect(starts.filter(id => id === a.id)).toHaveLength(1);
    expect(workspaces.get(a.id)!.users()).toEqual(["Original"]);
    workspaces.get(a.id)!.emit({ type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
    await flush();
    expect(workspaces.get(a.id)!.users()).toEqual(["Original", "Follow-up"]);
    expect(runs.get(a.id).pending).toEqual([]);
    // Consuming the message must not discard its durable retry receipt.
    runs.enqueue(a.id, "b", "Follow-up", [], undefined, undefined, "message-1");
    expect(runs.get(a.id).pending).toEqual([]);
    expect(runs.history(a.id, 0).filter(e => e.type === "user")).toHaveLength(2);
  });

  it("persists queued publication overrides atomically with request receipts without replaying stale bodies", async () => {
    await create(); // Occupy the only slot so publication metadata waits with the queued run.
    const queued = await runs.create("b", {...input(),title:"Queued publication",pr_body:"Initial description"});
    const order = membership(queued.id);
    runs.enqueue(queued.id, "b", "Update the description", [], undefined, undefined, "body-update", "");
    expect(runs.get(queued.id)).toMatchObject({status:"queued",queue_position:1,title:"Queued publication",pr_body:""});
    expect(membership(queued.id)).toEqual(order);
    runs.enqueue(queued.id, "b", "Update the description", [], undefined, undefined, "body-update", "Stale retry body");
    expect(runs.get(queued.id).pr_body).toBe("");
    expect(runs.get(queued.id).pending).toHaveLength(2);
    expect(() => runs.enqueue(queued.id, "b", "Invalid description", [], undefined, undefined, "invalid-body", "bad\0body"))
      .toThrow(expect.objectContaining({code:"invalid_publication"}));
    expect(db.prepare("SELECT request_id FROM run_message_requests WHERE run_id=?").all(queued.id))
      .toEqual([{request_id:"body-update"}]);
    expect(runs.get(queued.id).pending).toHaveLength(2);
    await runs.shutdown();
    runs = new Runs(db, cfg, factory);
    runs.enqueue(queued.id, "b", "Update the description", [], undefined, undefined, "body-update", "Stale restart body");
    expect(runs.get(queued.id)).toMatchObject({status:"queued",queue_position:1,title:"Queued publication",pr_body:""});
    expect(runs.get(queued.id).pending).toHaveLength(2);
    expect(membership(queued.id)).toEqual(order);
    expect(runs.history(queued.id, 0).filter(e => e.type === "user")).toHaveLength(2);
  });

  it("recovers waiting membership, messages and order while failing interrupted active work", async () => {
    const interrupted = await create(), first = await create("b", "First"), second = await create("b", "Second");
    runs.enqueue(first.id, "b", "Pending follow-up");
    const before = [membership(first.id), membership(second.id)];
    const pending = runs.get(first.id).pending;
    await runs.shutdown(); await flush();
    db.close(); db = openStore(dir);
    expect([membership(first.id), membership(second.id)]).toEqual(before);
    expect(queuedIds()).toEqual([first.id, second.id]);
    runs = new Runs(db, cfg, factory);
    const release = holdCheckout();
    await runs.recover(); await flush();
    expect(runs.get(interrupted.id)).toMatchObject({ status: "failed", pending: [] });
    expect(runs.get(interrupted.id).error).toMatch(/host restarted/i);
    expect(runs.get(first.id).pending).toEqual(pending);
    expect(membership(second.id)).toEqual(before[1]);
    release(); await flush();
    expect(starts).toEqual([interrupted.id, first.id]);
    expect(workspaces.get(first.id)!.users()).toEqual(["First"]);
    await runs.close(first.id); await flush();
    expect(starts).toEqual([interrupted.id, first.id, second.id]);
  });

  it.each(["runner", "schedule"])("rejects %s at capacity, ignores queue bounds and never jumps waiting work", async source => {
    cfg.queueMax = 1; cfg.queueMaxPerAccount = 1;
    const active = await create(), waiting = await create("b");
    await expect(runs.create("c", { ...input(), source })).rejects.toMatchObject({ status: 429, code: "run_limit" });
    expect(countRuns()).toBe(2);
    cfg.maxRuns = 2;
    // Admission must drain older interactive work before checking schedule capacity.
    await expect(runs.create("c", { ...input(), source })).rejects.toMatchObject({ code: "run_limit" });
    await flush();
    expect(starts).toEqual([active.id, waiting.id]);
    expect(queuedIds()).toEqual([]);
    await runs.close(active.id); await runs.close(waiting.id); await flush();
    const scheduled = await runs.create("c", { ...input(), source }); await flush();
    expect(starts.at(-1)).toBe(scheduled.id);
    expect(workspaces.get(scheduled.id)!.calls.find(call => call.method === "start")?.args).toMatchObject({ interactive: false });
  });

  it.each(["close", "stop", "expiry"])("drains waiting work when a kept failed workspace finishes releasing after %s", async action => {
    vi.stubEnv("GOND_AGENT_FAILED_KEEP_MINUTES", "1");
    const failed = await create();
    workspaces.get(failed.id)!.emit({ type: "error", agent_id: "main", message: "The model connection failed." });
    await flush();
    expect(runs.get(failed.id).work_kept).toBe(true);
    const gate = deferred<void>();
    gates.push(gate);
    const workspace = workspaces.get(failed.id)!;
    const destroy = workspace.destroy.bind(workspace);
    vi.spyOn(workspace, "destroy").mockImplementationOnce(async () => { await gate.promise; await destroy(); });
    const close = vi.spyOn(runs, "close");
    let closing: Promise<unknown> | undefined;
    if (action === "close") closing = runs.closeSession(failed.id, "a");
    else if (action === "stop") closing = runs.stop(failed.id, "a");
    else {
      await vi.advanceTimersByTimeAsync(60_000);
      // The expiry callback does not return its asynchronous cleanup to the
      // clock. Await the real close barrier, not a fixed number of event ticks.
      closing = close.mock.results[0]?.value;
      expect(closing).toBeInstanceOf(Promise);
    }
    const waiting = await create("b");
    expect(runs.get(waiting.id).status).toBe("queued");
    expect(starts).toEqual([failed.id]);
    gate.resolve();
    await closing; await flush();
    expect(starts).toEqual([failed.id, waiting.id]);
    expect(runs.get(failed.id).work_kept).toBe(false);
  });

  it("reclaims failed publication after grace and reserves capacity until teardown completes", async () => {
    const active = await create(), first = await create("b"), second = await create("c");
    const gate = deferred<void>();
    gates.push(gate);
    const workspace = workspaces.get(active.id)!;
    const destroy = workspace.destroy.bind(workspace);
    vi.spyOn(workspace, "destroy").mockImplementationOnce(async () => { await gate.promise; await destroy(); });
    // Publication imported this commit before its push failed. Pressure reclaim
    // must preserve that commit and wait for completed destruction.
    vi.mocked(importBundle).mockRejectedValueOnce(new RetryError("push", { class: "server", retryable: true, reason: "GitHub returned 500" }, 5));
    workspace.emit({ type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
    await flush();
    expect(runs.get(active.id)).toMatchObject({ status: "failed", work_kept: true });
    expect(releases).toEqual([]);
    expect(queuedIds()).toEqual([first.id, second.id]);
    await vi.advanceTimersByTimeAsync(60_000); await flush();
    expect(runs.get(active.id)).toMatchObject({ status: "failed", work_kept: false, kept_commit: "b".repeat(40) });
    expect(starts).toEqual([active.id]); // Replacement waits for destruction.
    const third = await create("a");
    runs.drain();
    expect(queuedIds()).toEqual([first.id, second.id, third.id]);
    gate.resolve(); await flush();
    expect(starts).toEqual([active.id, first.id]);
    expect(queuedIds()).toEqual([second.id, third.id]);
  });

  it.each(["membership", "status"])("does not boot a stale queue selection after another claimant changes its %s", async changed => {
    const active = await create(), waiting = await create("b");
    const queue = new RunQueue(db);
    const claim = RunQueue.prototype.claim;
    vi.spyOn(RunQueue.prototype, "claim").mockImplementationOnce(function (this: RunQueue, id) {
      expect(id).toBe(waiting.id);
      // Simulate the durable result of a different process winning after selection.
      if (changed === "membership") db.prepare("UPDATE runs SET queue_seq=NULL WHERE id=?").run(id);
      else db.prepare("UPDATE runs SET status='working' WHERE id=?").run(id);
      return claim.call(this, id);
    });
    await runs.close(active.id); await flush();
    expect(queue.claim(waiting.id)).toBe(false);
    expect(starts).toEqual([active.id]);
    expect(vi.mocked(checkout).mock.calls.map(call => call[1])).toEqual([active.id]);
    expect(runs.history(waiting.id, 0).filter(event => event.type === "run.dequeued")).toEqual([]);
  });

  it("preserves replacement messages accepted after Stop during kept-commit publication", async () => {
    const original = await create();
    await runs.close(original.id);
    const saved = runs.get(original.id);
    saved.kept_commit = "b".repeat(40);
    saved.status = "failed";
    runs.save(saved);
    const gate = deferred<void>();
    gates.push(gate);
    vi.mocked(pushBranch).mockImplementationOnce(() => gate.promise);
    runs.enqueue(original.id, "a", "Cancelled retry");
    await flush();
    expect(pushBranch).toHaveBeenCalledTimes(1);
    await runs.stop(original.id, "a");
    runs.enqueue(original.id, "a", "Replacement", [], undefined, undefined, "replacement-id");
    gate.resolve(); await flush();
    expect(starts).toEqual([original.id, original.id]);
    expect(workspaces.get(original.id)!.users()).toEqual(["Replacement"]);
    expect(membership(original.id).queue_seq).toBeNull();
    expect(runs.get(original.id).kept_commit).toBeUndefined();
    expect(runs.get(original.id).pending).toEqual([]);
  });

  it("does not turn intentional teardown RPC errors into a kept failure", async () => {
    const active = await create();
    await finish(active.id);
    await vi.advanceTimersByTimeAsync(50); await flush();
    workspaces.get(active.id)!.rejectEventsOnDestroy = true;
    await runs.closeSession(active.id, "a"); await flush();
    expect(runs.get(active.id)).toMatchObject({ status: "ready", work_kept: false });
    expect(runs.history(active.id, 0).filter(event => event.type === "run.error")).toEqual([]);
  });

  it("claims each run only once when releases, drains and new admissions race", async () => {
    cfg.maxRuns = 2;
    const first = await create(), second = await create("b");
    const waiting1 = await create("a", "Waiting first"), waiting2 = await create("b", "Waiting second");
    const release = holdCheckout();
    await Promise.all([
      runs.close(first.id), runs.close(second.id),
      runs.create("c", input("New admission")),
      Promise.resolve().then(() => { runs.drain(); runs.drain(); }),
    ]);
    await flush();
    expect(vi.mocked(checkout).mock.calls.map(call => call[1])).toEqual([first.id, second.id, waiting1.id, waiting2.id]);
    expect(queuedIds()).toHaveLength(1);
    release(); await flush();
    expect(starts.filter(id => id === waiting1.id)).toHaveLength(1);
    expect(starts.filter(id => id === waiting2.id)).toHaveLength(1);
    runs.drain(); await flush();
    expect(starts).toHaveLength(4);
  });

  it("expires only overdue waiting work at the fake-clock boundary and permits a fresh follow-up", async () => {
    const active = await create(), expired = await create("b");
    const joined = Date.now();
    vi.setSystemTime(joined + 3600_000);
    const fresh = await create("c");
    vi.setSystemTime(joined + 24 * 3600_000 - 1);
    runs.drain();
    expect(runs.get(expired.id).status).toBe("queued");
    vi.setSystemTime(joined + 24 * 3600_000);
    runs.drain();
    expect(runs.get(expired.id)).toMatchObject({ status: "failed", pending: [], error: expect.stringMatching(/wait.*expired/i) });
    expect(membership(expired.id)).toEqual({ queue_seq: null, queued_at: null });
    expect(runs.get(fresh.id)).toMatchObject({ status: "queued", queue_position: 1, queue_length: 1 });
    expect(runs.get(active.id).status).toBe("working"); // Queue expiry is not a run lifetime budget.
    runs.enqueue(expired.id, "b", "Retry after expiry");
    expect(queuedIds()).toEqual([fresh.id, expired.id]);
    expect(membership(expired.id).queued_at).toBe(Date.now());
    await runs.close(active.id); await flush();
    expect(starts).toEqual([active.id, fresh.id]);
  });

  it("honors configured wait hours and periodically drains as a safety net", async () => {
    cfg.queueWaitHours = 1;
    await create();
    const expired = await create("b");
    vi.setSystemTime(Date.now() + 3600_000);
    // No release or explicit drain: the minute tick must clean up the expired row.
    await vi.advanceTimersByTimeAsync(60_000); await flush();
    expect(runs.get(expired.id).status).toBe("failed");
    const waiting = await create("b");
    cfg.maxRuns = 2;
    await vi.advanceTimersByTimeAsync(60_000); await flush();
    expect(starts.at(-1)).toBe(waiting.id);
  });
});

it("validates bounded queue settings and supplies defaults without echoing invalid values", () => {
  const names = ["GOND_AGENT_QUEUE_MAX", "GOND_AGENT_QUEUE_MAX_PER_ACCOUNT", "GOND_AGENT_QUEUE_WAIT_HOURS"] as const;
  for (const name of names) vi.stubEnv(name, undefined);
  expect(queueSettings()).toEqual({ queueMax: 50, queueMaxPerAccount: 10, queueWaitHours: 24 });
  for (const name of names) {
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity", " 2", "1e2", "4294967296", "private-invalid-value"]) {
      vi.stubEnv(name, value);
      expect(() => queueSettings()).toThrow(expect.objectContaining({ message: `Invalid ${name}` }));
    }
    vi.stubEnv(name, "2");
  }
  expect(queueSettings()).toEqual({ queueMax: 2, queueMaxPerAccount: 2, queueWaitHours: 2 });
});

it("migrates legacy queued rows additively and repeatedly without changing messages or established order", () => {
  const legacy = new Database(":memory:");
  try {
    legacy.exec("CREATE TABLE runs(id TEXT PRIMARY KEY,user_id TEXT,status TEXT,created_at INTEGER,deleted_at INTEGER,data TEXT NOT NULL)");
    const insert = legacy.prepare("INSERT INTO runs(id,user_id,status,created_at,deleted_at,data) VALUES(?,?,?,?,?,?)");
    const pending = [{ text: "Original", images: [] }, { text: "Follow-up", images: [], request_id: "request-1" }];
    const data = JSON.stringify({ backend: "builtin", pending, diff: "saved diff" });
    insert.run("q_b", "a", "queued", 100, null, data);
    insert.run("q_a", "b", "queued", 100, null, data);
    insert.run("working", "a", "working", 50, null, data);
    insert.run("deleted", "a", "queued", 10, 20, data);
    insert.run("retired", "a", "queued", 5, null, JSON.stringify({ retired_backend: "codex", pending }));
    migrateRunQueue(legacy);
    const snapshot = () => legacy.prepare("SELECT id,queue_seq,queued_at,data FROM runs ORDER BY id").all();
    const before = snapshot();
    expect(legacy.prepare("SELECT id,queue_seq,queued_at FROM runs WHERE queue_seq IS NOT NULL ORDER BY queue_seq").all()).toEqual([
      { id: "q_a", queue_seq: 1, queued_at: 100 }, { id: "q_b", queue_seq: 2, queued_at: 100 },
    ]);
    migrateRunQueue(legacy); migrateRunQueue(legacy);
    expect(snapshot()).toEqual(before);
    insert.run("q_new", "a", "queued", 200, null, data);
    migrateRunQueue(legacy);
    expect(legacy.prepare("SELECT queue_seq,queued_at,data FROM runs WHERE id='q_new'").get())
      .toEqual({ queue_seq: 3, queued_at: 200, data });
    expect(legacy.prepare("SELECT seq FROM run_queue_counter").get()).toEqual({ seq: 3 });
    expect(legacy.prepare("SELECT data FROM runs WHERE id='q_a'").get()).toEqual({ data });
  } finally { legacy.close(); }
});
