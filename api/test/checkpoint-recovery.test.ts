import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthentication, seal, unseal } from "../src/auth";
import type { Checkpoint } from "../src/checkpoints";
import type { Config } from "../src/config";
import type { Workspace, WorkspaceCheckpoint, WorkspaceCheckpointOptions, WorkspaceFactory } from "../src/containers";
import { openStore } from "../src/db";
import { branchHead, checkout, importBundle } from "../src/github";
import { saveProviderSettings } from "../src/providers";
import { Runs } from "../src/runs/service";
import { ApiError } from "../src/wire";
import { verificationBlock } from "../src/runs/evidence";
import { evidenceState, signedRecord } from "./fixtures/evidence";

// Same command-scoped GitHub fixtures as runs-local: no Docker, Git or model network calls.
// SQLite, checkpoint encryption, claims and on-disk artifacts remain real.
vi.mock("../src/github", async original => {
  const actual = await original<typeof import("../src/github")>();
  return {
    ...actual,
    gh: vi.fn(async (endpoint: string, method: string) => method === "POST"
      ? { number: 42, html_url: "https://github.com/acme/app/pull/42" }
      : endpoint.includes("/pulls?") || endpoint.includes("/git/matching-refs/") ? []
      : { default_branch: "main" }),
    commitIdentity: vi.fn(async () => ({ name: "fixture", email: "123+fixture@users.noreply.github.com" })),
    checkout: vi.fn(async () => ({ cwd: "/fake", archive: Buffer.from("repo") })),
    branchHead: vi.fn(async () => HEAD),
    importBundle: vi.fn(async () => {}),
    pushBranch: vi.fn(async () => {}),
    git: vi.fn(async (_cwd: string, ...args: string[]) => Buffer.from(args[0] === "rev-parse"
      ? BASE : args.includes("--name-only") ? "src/app.ts\0"
      : args.includes("--numstat") ? "2\t1\tsrc/app.ts\n" : "diff --git a/src/app.ts b/src/app.ts\n")),
  };
});

const BASE = "a".repeat(40), HEAD = "b".repeat(40), TREE = "c".repeat(40);
const VERSION = "gond-agent-checkpoint-3";
const PROMPT = "Repair the checkout without losing the original requirements.";
const EARLIER = "I inspected the original requirements and found the failing parser.";
const QUESTION = "Should the parser retain empty fields?";
type Message = { role: "user" | "assistant"; content: { type: "text"; text: string }[] };
type State = WorkspaceCheckpoint["state"] & { history: Message[] };
type Call = { method: string; args?: Record<string, unknown> };
const message = (role: Message["role"], text: string): Message => ({ role, content: [{ type: "text", text }] });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** A held boundary is saved before releasing either the next model round or turn.end. */
class FakeWorkspace implements Workspace {
  calls: Call[] = [];
  events: Record<string, unknown>[] = [];
  history: Message[] = [];
  imported?: State;
  evidenceKey?: string;
  options?: WorkspaceCheckpointOptions;
  save?: (value: WorkspaceCheckpoint) => void | Promise<void>;
  onError?: (error: unknown) => void;
  captureErrors: unknown[] = [];
  checkpointError?: unknown;
  captureGate?: Promise<void>;
  checkpointBundle = Buffer.from("opaque-checkpoint-bundle");
  boundary = 0;
  destroyed = false;
  destroy = vi.fn(async () => { this.destroyed = true; });

  constructor(readonly id: string) {}

  async enableCheckpoints(options: WorkspaceCheckpointOptions,
    save: (value: WorkspaceCheckpoint) => void | Promise<void>, onError?: (error: unknown) => void) {
    this.options = options;
    this.save = save;
    this.onError = onError;
  }

  async capture(bundle = this.checkpointBundle) {
    if (!this.options || !this.save) throw new Error("Checkpoints must be enabled before user delivery");
    const state: State = {
      schema_version: 1, runner_state_version: VERSION, run_id: this.id, owner_id: this.options.owner_id,
      history: structuredClone(this.history), plan: [],
      counters: { sub_counter: 0, main_context: 0, plan_calls: 0, plan_last: [], plan_nudges: 0,
        turn_compactions: 0, skipped_history_len: null },
    };
    try {
      await this.captureGate;
      await this.save({ boundary_id: `boundary-${++this.boundary}`, bundle: bundle.toString("base64"),
        state, base_sha: this.options.base_sha, head_sha: HEAD, checkpoint_sha: TREE });
      this.checkpointError = undefined;
    } catch (error) {
      // Like the real Workspace, release after a failed save and retain the previous checkpoint.
      this.captureErrors.push(error);
      this.checkpointError = error;
      this.onError?.(error);
    }
  }

  async captureCheckpoint() { await this.capture(); await this.flushCheckpoints(); }
  async flushCheckpoints() { if (this.checkpointError) throw this.checkpointError; }

  async rpc<T = any>(method: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push(structuredClone({ method, args }));
    let result: unknown = true;
    if (method === "init_evidence") {
      if (typeof args?.key !== "string" || !/^[a-f0-9]{64}$/.test(args.key)) throw new Error("Invalid evidence key");
      this.evidenceKey = args.key;
      result = { type: "state.evidence_initialized" };
    } else if (method === "export_state") {
      const reply = evidenceState(this.evidenceKey);
      const start = this.calls.find(call => call.method === "start")?.args;
      reply.state.evidence.gate_rounds = Number(start?.evidence_gate_rounds ?? 0);
      reply.state.evidence.resumes = Number(start?.evidence_resumes ?? 0);
      result = reply;
    } else if (method === "import_state") {
      if (!this.evidenceKey) throw new Error("Evidence must be initialized before import");
      this.imported = structuredClone(args!.state as State);
      this.history = structuredClone(this.imported.history);
      result = { type: "state.imported", request_id: args?.request_id };
    } else if (method === "restore_checkpoint") {
      result = { base_sha: BASE, head_sha: HEAD, checkpoint_sha: TREE };
    } else if (method === "events") {
      result = { events: this.events.splice(0), alive: !this.destroyed };
    } else if (method === "snapshot") {
      result = { bundle: Buffer.from("publication-bundle").toString("base64"), head: HEAD };
    } else if (method === "send") {
      const input = args?.input as { type: string; text?: string };
      if (input.type === "user") {
        if (!this.evidenceKey) throw new Error("Evidence must be initialized before delivery");
        this.history.push(message("user", input.text!));
        this.events.push({ type: "turn.start", agent_id: "main" });
        const text = this.history.length === 1 ? EARLIER : "Completed the next parser step.";
        this.history.push(message("assistant", text));
        await this.capture();
        this.events.push({ type: "text.delta", agent_id: "main", text });
        if (finishUsers) this.events.push({ type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
      } else if (input.type === "interrupt") {
        this.events.push({ type: "turn.end", agent_id: "main", stop_reason: "interrupted" });
      }
    }
    return result as T;
  }

  users() {
    return this.calls.filter(call => call.method === "send")
      .map(call => call.args!.input as { type: string; text: string }).filter(input => input.type === "user").map(input => input.text);
  }
}

let dir: string, db: ReturnType<typeof openStore>, cfg: Config, runs: Runs;
let workers: FakeWorkspace[], finishUsers: boolean;
const factory = vi.fn<WorkspaceFactory>(async id => {
  const worker = new FakeWorkspace(id);
  workers.push(worker);
  return worker;
});
const rows = (id: string) => db.prepare("SELECT * FROM run_checkpoints WHERE run_id=? ORDER BY seq").all(id) as Checkpoint[];
function storedState(row: Checkpoint) {
  const plaintext = unseal(cfg.secret, readFileSync(join(dir, "checkpoints", row.state_path), "utf8"));
  return JSON.parse(plaintext.slice(plaintext.indexOf("\n") + 1)) as { runner: State; service: { active_message_id: string; automatic?: boolean } };
}
const create = (source = "web", user = "u") => runs.create(user, { repo: "acme/app", model: "local:coder", prompt: PROMPT, source });
async function checkpointed(source = "web", user = "u") {
  const run = await create(source, user);
  await vi.waitFor(() => expect(rows(run.id).length).toBeGreaterThan(0), { timeout: 5000 });
  return { run, worker: workers.find(worker => worker.id === run.id)! };
}
async function restart() {
  await runs.shutdown();
  // Reopen the database too, rather than accidentally relying on process-local state.
  db.close();
  db = openStore(dir);
  runs = new Runs(db, cfg, factory);
}
function disableCiNetwork() {
  const ci = (runs as unknown as { ci: { start(id: string, sha: string): void } }).ci;
  return vi.spyOn(ci, "start").mockImplementation(() => {});
}
function account(id: string) {
  db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
    .run(id, "User", `${id}@example.test`, 0, Date.now(), Date.now());
  db.prepare("INSERT INTO github_connections(user_id,token,connected_at) VALUES(?,?,?)")
    .run(id, seal(cfg.secret, "test-managed-github-token"), Date.now());
}

beforeEach(async () => {
  vi.stubEnv("GOND_AGENT_CI_FIX_ROUNDS", "0");
  vi.stubEnv("GOND_AGENT_CHECKPOINT_MAX_MB", "1024");
  vi.stubEnv("GOND_AGENT_CHECKPOINT_RETENTION_DAYS", "7");
  dir = mkdtempSync(join(tmpdir(), "gond-agent-checkpoint-recovery-"));
  cfg = { data: dir, origin: "http://localhost:8787", secret: "a".repeat(40), signup: true,
    port: 8787, dockerBin: "docker", workerImage: "gond-agent-worker:test", maxRuns: 2, runCPUs: 2, runMemoryMB: 2048 };
  db = openStore(dir);
  await createAuthentication(db, cfg);
  account("u");
  saveProviderSettings(db, cfg.secret, {
    connections: [{ id: "local", name: "Local", format: "openai", baseURL: "http://127.0.0.1:9/v1",
      apiKey: "test-provider-key", discover: false, models: [{ id: "coder", name: "Coder", contextWindow: 128000,
        maxOutput: 8192, reasoning: "none", images: true }] }], defaultModel: "local:coder",
  });
  workers = [];
  finishUsers = false;
  runs = new Runs(db, cfg, factory);
});
afterEach(async () => {
  await runs.shutdown();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("checkpoint-backed Runs recovery (fake Workspace, real SQLite/files)", () => {
  it("keeps a valid checkpoint and delivers no work when private key initialization fails on recovery", async () => {
    const { run } = await checkpointed();
    const predecessor = rows(run.id).at(-1)!;
    await restart();
    const rpc = FakeWorkspace.prototype.rpc;
    vi.spyOn(FakeWorkspace.prototype, "rpc").mockImplementation(async function(this: FakeWorkspace, method, args) {
      const reply = await rpc.call(this, method, args);
      if (method === "init_evidence") throw new Error("Private control initialization failed");
      return reply;
    });
    await runs.recover();
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    await vi.waitFor(() => expect(runs.get(run.id).status).toBe("interrupted"));
    const failed = workers.at(-1)!;
    expect(failed.users()).toEqual([]);
    expect(failed.imported).toBeUndefined();
    expect(failed.destroy).toHaveBeenCalled();
    expect(rows(run.id).find(row => row.seq === predecessor.seq)).toMatchObject({ consumed_at: null, invalid_reason: null, claimed_by: null });
    expect(runs.history(run.id, 0).some(event => event.type === "run.checkpoint_fallback")).toBe(false);
  });

  it.each([false, true])("acknowledges a new service key before restore import and fallback delivery (import fails: %s)", async failImport => {
    const { run, worker } = await checkpointed();
    const oldKey = worker.evidenceKey;
    await restart();
    const gates = [deferred(), deferred()];
    const rpc = FakeWorkspace.prototype.rpc;
    let initializing = 0;
    vi.spyOn(FakeWorkspace.prototype, "rpc").mockImplementation(async function(this: FakeWorkspace, method, args) {
      const reply = await rpc.call(this, method, args);
      if (method === "init_evidence") await gates[initializing++]!.promise;
      if (method === "import_state" && failImport) throw new Error("Rejected checkpoint state");
      return reply;
    });
    try {
      await runs.recover();
      await vi.waitFor(() => expect(initializing).toBe(1));
      const restored = workers.at(-1)!;
      expect(restored.evidenceKey).toMatch(/^[a-f0-9]{64}$/);
      expect(restored.evidenceKey).not.toBe(oldKey);
      expect(restored.imported).toBeUndefined();
      expect(restored.users()).toEqual([]);
      expect(restored.calls.find(call => call.method === "start")?.args).toMatchObject({
        evidence_base_sha: BASE, evidence_seq: 0, evidence_gate_rounds: 2, evidence_resumes: 1,
      });
      expect(runs.get(run.id).base_sha).toBe(BASE);
      gates[0]!.resolve();
      if (failImport) {
        await vi.waitFor(() => expect(initializing).toBe(2));
        const fallback = workers.at(-1)!;
        expect(restored.destroy).toHaveBeenCalled();
        expect(fallback.evidenceKey).not.toBe(restored.evidenceKey);
        expect(fallback.evidenceKey).not.toBe(oldKey);
        expect(fallback.users()).toEqual([]);
        expect(fallback.imported).toBeUndefined();
        expect(fallback.calls.find(call => call.method === "start")?.args).toMatchObject({ evidence_base_sha: BASE, evidence_resumes: 2 });
        gates[1]!.resolve();
      }
      await vi.waitFor(() => expect(workers.at(-1)!.users()).toHaveLength(1));
      const active = workers.at(-1)!;
      const methods = active.calls.map(call => call.method);
      expect(methods.indexOf("start")).toBeLessThan(methods.indexOf("init_evidence"));
      expect(methods.indexOf("init_evidence")).toBeLessThan(methods.indexOf("send"));
      if (!failImport) {
        expect(methods.indexOf("init_evidence")).toBeLessThan(methods.indexOf("import_state"));
        expect(runs.get(run.id).active_message?.recovery).toBe(true);
      }
      // The synthetic restore task and fallback's original task both reserve budget.
      expect(runs.get(run.id).evidence?.gate_budget).toBe(4);
      for (const key of [oldKey, restored.evidenceKey, active.evidenceKey]) {
        expect(JSON.stringify(runs.get(run.id))).not.toContain(key!);
        expect(JSON.stringify(runs.history(run.id, 0))).not.toContain(key!);
      }
    } finally { for (const gate of gates) gate.resolve(); }
  });

  it.each(["missing key", "changed key", "malformed metadata"])("keeps public evidence ahead of the checkpoint historical despite %s and stale saves", async invalid => {
    const { run, worker } = await checkpointed();
    const record = signedRecord({ run_id: run.id, seq: 8 }, Buffer.from(worker.evidenceKey!, "hex"));
    // This authenticated event arrived after the saved boundary; it is not in its state.
    runs.append(run.id, { type: "evidence.recorded", record });
    const stale = runs.get(run.id);
    expect(stale.evidence?.recorded_before_restart).not.toContain(record.id);
    const checkpoint = rows(run.id).at(-1)!;
    expect(storedState(checkpoint).runner).not.toHaveProperty("evidence");
    await restart();
    const rpc = FakeWorkspace.prototype.rpc;
    vi.spyOn(FakeWorkspace.prototype, "rpc").mockImplementation(async function(this: FakeWorkspace, method, args) {
      const reply = await rpc.call(this, method, args);
      if (method !== "export_state") return reply;
      const evidence = (reply as ReturnType<typeof evidenceState>).state.evidence;
      if (invalid === "missing key") return { state: { evidence: { ...evidence, key: null } } };
      if (invalid === "changed key") return { state: { evidence: { ...evidence, key: "bad-key", gate_rounds: 100 } } };
      return { state: { evidence: { ...evidence, policy: { enabled: "invalid" }, historical_ids: [42], resumes: -1 } } };
    });
    await runs.recover();
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    await vi.waitFor(() => expect(workers.at(-1)!.users()).toHaveLength(1));
    const resumed = workers.at(-1)!;
    expect(resumed.calls.find(call => call.method === "start")?.args).toMatchObject({ evidence_seq: 8 });
    expect(runs.get(run.id).evidence?.policy).toBeUndefined();
    runs.save(stale); // Same sequence, pre-restart freshness: must not erase historical marks.
    let current = runs.get(run.id);
    expect(current.evidence).toMatchObject({ last_seq: 8, records: [record], recorded_before_restart: [record.id], gate_budget: 4, resumes: 1 });
    // Old worker credentials cannot authorize new events after restore.
    const next = { run_id: run.id, seq: 9, id: "00000000-0000-4000-8000-000000000002" };
    runs.append(run.id, { type: "evidence.recorded", record: signedRecord(next, Buffer.from(worker.evidenceKey!, "hex")) });
    expect(runs.get(run.id).evidence?.last_seq).toBe(8);
    current = runs.get(run.id);
    expect(verificationBlock({ ...current.evidence!, publication_tree: record.tree_hash_after })).toContain("recorded before restart; re-run required");
    expect(verificationBlock({ ...current.evidence!, publication_tree: record.tree_hash_after })).not.toContain("1 fresh successful check(s)");
    runs.append(run.id, { type: "evidence.recorded", record: signedRecord(next, Buffer.from(resumed.evidenceKey!, "hex")) });
    expect(runs.get(run.id).evidence).toMatchObject({ last_seq: 9, recorded_before_restart: [record.id] });
  });

  it("does not auto-recover or relabel sealed epoch-2 checkpoints after the epoch-3 upgrade", async () => {
    const { run } = await checkpointed();
    const saved = storedState(rows(run.id).at(-1)!);
    saved.runner.runner_state_version = "gond-agent-checkpoint-2";
    const legacy = runs.checkpoints.save({ runId: run.id, ownerId: "u", runnerVersion: "gond-agent-checkpoint-2",
      bundle: Buffer.from("legacy-bundle"), state: JSON.stringify(saved), tree: { baseSha: BASE, headSha: HEAD, checkpointSha: TREE } });
    const sealed = readFileSync(join(dir, "checkpoints", legacy.state_path));
    await restart();
    await runs.recover();
    expect(workers).toHaveLength(1);
    expect(runs.get(run.id).status).toBe("failed");
    expect(rows(run.id).find(row => row.seq === legacy.seq)?.runner_version).toBe("gond-agent-checkpoint-2");
    expect(readFileSync(join(dir, "checkpoints", legacy.state_path))).toEqual(sealed);
  });

  it("publishes a finished turn despite failed flush and post-publication capture", async () => {
    vi.stubEnv("GOND_AGENT_CHECKPOINT_MAX_MB", "1");
    await restart();
    const { run, worker } = await checkpointed();
    const previous = rows(run.id);
    worker.checkpointBundle = Buffer.alloc(1024 * 1024, 1);
    await worker.capture();
    expect(worker.captureErrors).toHaveLength(1);
    worker.events.push({ type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
    await vi.waitFor(() => expect(runs.get(run.id).status).toBe("ready"));
    expect(importBundle).toHaveBeenCalledTimes(1);
    expect(runs.get(run.id)).toMatchObject({ pushed: true, head_sha: HEAD });
    expect(rows(run.id)).toEqual(previous);
    expect(runs.history(run.id, 0)).toContainEqual(expect.objectContaining({ type: "run.checkpoint_unavailable" }));
    expect(runs.history(run.id, 0)).not.toContainEqual(expect.objectContaining({ type: "run.error" }));
  });

  it("releases a restored worker's claim when it dies before the first replacement checkpoint", async () => {
    const { run } = await checkpointed();
    const predecessor = rows(run.id).at(-1)!;
    await restart();
    vi.spyOn(FakeWorkspace.prototype, "capture").mockImplementationOnce(async () => {});
    await runs.recover();
    await vi.waitFor(() => { expect(workers).toHaveLength(2); expect(workers.at(-1)!.users()).toHaveLength(1); });
    expect(rows(run.id).at(-1)).toMatchObject({ seq: predecessor.seq, claimed_by: expect.any(String), consumed_at: null });
    await workers.at(-1)!.destroy();
    await vi.waitFor(() => expect(runs.get(run.id).status).toBe("interrupted"));
    expect(rows(run.id).at(-1)).toMatchObject({ seq: predecessor.seq, claimed_by: null, claimed_at: null, consumed_at: null });
  });

  it("keeps delivery-only resume framing out of durable messages over two restores", async () => {
    vi.stubEnv("GOND_AGENT_CI_FIX_ROUNDS", "2");
    disableCiNetwork();
    finishUsers = true;
    const { run, worker } = await checkpointed();
    await vi.waitFor(() => expect(worker.destroy).toHaveBeenCalledTimes(1));
    finishUsers = false;
    const followUp = "Handle the next parser edge case.";
    vi.spyOn(FakeWorkspace.prototype, "capture").mockImplementation(async () => {});
    await runs.validateFollowUp(run.id, "u");
    runs.enqueue(run.id, "u", followUp);
    await vi.waitFor(() => { expect(workers.at(-1)).not.toBe(worker); expect(workers.at(-1)!.users()).toHaveLength(1); });
    expect(workers.at(-1)!.users()[0]!.split("The run was restarted.")).toHaveLength(2);
    for (let attempt = 0; attempt < 2; attempt++) {
      const active = runs.get(run.id).active_message!;
      if (!active.recovery) expect(active.text).toBe(followUp);
      else expect(active.text.split("The run was restarted.")).toHaveLength(2);
      expect(runs.get(run.id).recovery_task?.text).toBe(followUp);
      const count = workers.length;
      await restart();
      await runs.recover();
      await vi.waitFor(() => { expect(workers.length).toBeGreaterThan(count); expect(workers.at(-1)!.users().length).toBeGreaterThan(0); });
      const delivered = workers.at(-1)!.users().join("\n");
      expect(delivered.split("The run was restarted.")).toHaveLength(2);
      // The old completed checkpoint has no follow-up: it must remain ordinary pending work.
      expect(runs.get(run.id).pending.map(message => message.text)).toContain(followUp);
      expect(runs.get(run.id).recovery_task?.text).toBe(followUp);
    }
  });

  it.each([false, true])("quarantines a failed restore without replaying a finished task (queued follow-up: %s)", async queuedFollowUp => {
    const { run, worker } = await checkpointed();
    const predecessor = rows(run.id).at(-1)!;
    const capture = deferred();
    const capturing = vi.spyOn(worker, "captureCheckpoint").mockImplementation(() => capture.promise);
    if (queuedFollowUp) runs.enqueue(run.id, "u", "Do the next task afterwards.");
    worker.events.push({ type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
    await vi.waitFor(() => expect(capturing).toHaveBeenCalledTimes(1));
    expect(importBundle).toHaveBeenCalledTimes(1);
    expect(runs.get(run.id)).toMatchObject({ phase: "finishing", recovery_phase: "finishing", pushed: true });
    const shutdown = runs.shutdown();
    await vi.waitFor(() => expect(worker.destroy).toHaveBeenCalledTimes(1));
    capture.resolve();
    await shutdown;
    await restart();
    const rpc = FakeWorkspace.prototype.rpc;
    let restoreAttempts = 0;
    vi.spyOn(FakeWorkspace.prototype, "rpc").mockImplementation(async function(this: FakeWorkspace, method, args) {
      if (method === "restore_checkpoint") { restoreAttempts++; throw new Error("invalid tree"); }
      return rpc.call(this, method, args);
    });
    vi.spyOn(FakeWorkspace.prototype, "capture").mockImplementation(async () => {});
    await runs.recover();
    await vi.waitFor(() => { expect(workers).toHaveLength(3); expect(workers.at(-1)!.users()).toHaveLength(1); });
    const fallback = workers.at(-1)!;
    expect(fallback.imported).toBeUndefined();
    expect(fallback.users()[0]).toContain("Verify publication and finish");
    expect(fallback.users().join("\n")).not.toContain(PROMPT);
    expect(runs.get(run.id).pending.map(message => message.text)).toEqual(queuedFollowUp ? ["Do the next task afterwards."] : []);
    expect(rows(run.id).find(row => row.seq === predecessor.seq)).toMatchObject({ consumed_at: expect.any(Number), invalid_reason: "restore_failed", claimed_by: null });
    expect(restoreAttempts).toBe(1);
    await restart();
    await runs.recover();
    expect(runs.get(run.id).status).toBe("failed"); // No usable pair; never retry the quarantined checkpoint.
    expect(restoreAttempts).toBe(1);
  });
  it("runs unref'ed checkpoint cleanup periodically and stops it on shutdown", async () => {
    await runs.shutdown();
    vi.useFakeTimers();
    try {
      runs = new Runs(db, cfg, factory);
      const timer = (runs as unknown as { checkpointTimer: NodeJS.Timeout }).checkpointTimer;
      expect(timer.hasRef()).toBe(false);
      const cleanup = vi.spyOn(runs.checkpoints, "cleanup");
      await vi.advanceTimersByTimeAsync(3600_000);
      expect(cleanup).toHaveBeenCalledTimes(1);
      await runs.shutdown();
      await vi.advanceTimersByTimeAsync(2 * 3600_000);
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("restores history after shutdown and replays pending work and the unanswered question once", async () => {
    const { run, worker } = await checkpointed();
    const checkpoint = rows(run.id).at(-1)!;
    const saved = storedState(checkpoint);
    expect(saved.runner.history).toEqual([message("user", PROMPT), message("assistant", EARLIER)]);
    expect(saved.service.active_message_id).toEqual(expect.any(String));
    expect(readFileSync(join(dir, "checkpoints", checkpoint.bundle_path))).toEqual(Buffer.from("opaque-checkpoint-bundle"));
    expect(readFileSync(join(dir, "checkpoints", checkpoint.state_path), "utf8")).not.toContain(PROMPT);

    // Queue before the question appears: these messages are not question replies.
    for (const text of ["Preserve whitespace too.", "Add regression coverage."]) runs.enqueue(run.id, "u", text);
    worker.events.push({ type: "question", agent_id: "main", request_id: "q-parser", question: QUESTION });
    await vi.waitFor(() => expect(runs.get(run.id).summary.question?.question).toBe(QUESTION));
    expect(runs.get(run.id).pending.map(item => item.text)).toEqual(["Preserve whitespace too.", "Add regression coverage."]);
    await restart();
    expect(worker.destroy).toHaveBeenCalledTimes(1);
    expect(rows(run.id).some(row => row.seq === checkpoint.seq)).toBe(true);
    expect(runs.get(run.id).status).toBe("working");
    finishUsers = true;
    await runs.recover();
    await vi.waitFor(() => expect(runs.get(run.id).status).toBe("ready"), { timeout: 5000 });
    const restored = workers.at(-1)!;
    expect(restored.imported).toEqual(saved.runner);
    expect(restored.calls.find(call => call.method === "restore_checkpoint")?.args).toMatchObject({
      bundle: Buffer.from("opaque-checkpoint-bundle").toString("base64"), base_sha: BASE, head_sha: HEAD, checkpoint_sha: TREE,
    });
    const methods = restored.calls.map(call => call.method);
    expect(methods.indexOf("restore_checkpoint")).toBeLessThan(methods.indexOf("import_state"));
    const firstUser = restored.calls.findIndex(call => call.method === "send" && (call.args?.input as { type?: string })?.type === "user");
    expect(methods.indexOf("import_state")).toBeLessThan(firstUser);
    const delivered = restored.users();
    expect(delivered.filter(text => text.includes(PROMPT))).toHaveLength(0);
    for (const text of ["Preserve whitespace too.", "Add regression coverage."]) expect(delivered.filter(value => value.includes(text))).toHaveLength(1);
    expect(delivered.join("\n").split(QUESTION)).toHaveLength(2);
    expect(runs.get(run.id).pending).toEqual([]);
    expect(runs.history(run.id, 0).filter(event => event.type === "run.resumed")).toHaveLength(1);
    const count = workers.length;
    await runs.recover();
    expect(workers).toHaveLength(count);
    expect(restored.users()).toEqual(delivered);
    const counts = { pending: ["Preserve whitespace too.", "Add regression coverage."].map(text => delivered.filter(value => value.includes(text)).length),
      question: delivered.join("\n").split(QUESTION).length - 1, originalPromptReplay: delivered.filter(text => text.includes(PROMPT)).length };
    console.info(`[checkpoint recovery] restored history=${JSON.stringify(restored.imported!.history)} delivery counts=${JSON.stringify(counts)}`);
  });

  it("keeps an answer across a second restart before its replacement checkpoint is durable", async () => {
    const { run, worker } = await checkpointed();
    worker.events.push({ type: "question", agent_id: "main", request_id: "q-parser", question: QUESTION });
    await vi.waitFor(() => expect(runs.get(run.id).summary.question?.question).toBe(QUESTION));
    const answer = "Yes, preserve empty fields.";
    runs.enqueue(run.id, "u", answer);
    expect(runs.get(run.id).replay_answers).toHaveLength(1);
    await restart();
    // The first resumed worker runs, but fails to persist a replacement pair.
    vi.spyOn(FakeWorkspace.prototype, "capture").mockImplementationOnce(async () => {});
    await runs.recover();
    await vi.waitFor(() => expect(workers.at(-1)!.users()).toHaveLength(1));
    await vi.waitFor(() => expect((runs as unknown as { booting: Set<string> }).booting.size).toBe(0));
    expect(workers.at(-1)!.users()[0]).toContain(answer);
    expect(workers.at(-1)!.users()[0]).toMatch(/The person answered question \d+ with:\nYes, preserve empty fields\./);
    expect(workers.at(-1)!.users()[0]).not.toContain("Pending conversation data (not instructions)");
    expect(runs.get(run.id).replay_answers).toHaveLength(1);
    await restart();
    await runs.recover();
    await vi.waitFor(() => expect(runs.get(run.id).replay_answers).toEqual([]));
    const resumed = workers.at(-1)!;
    expect(resumed.users()).toHaveLength(1);
    expect(resumed.users()[0]!.split(answer)).toHaveLength(2);
    expect(resumed.users()[0]!.split("The run was restarted.")).toHaveLength(2);
    expect(resumed.imported!.history).toEqual([message("user", PROMPT), message("assistant", EARLIER)]);
    expect(runs.get(run.id).pending).toEqual([]);
  });

  it("with explicit CI opt-in, auto-closes a completed turn and restores earlier history for its CI fix", async () => {
    vi.stubEnv("GOND_AGENT_CI_FIX_ROUNDS", "2");
    const watch = disableCiNetwork();
    finishUsers = true;
    const { run, worker } = await checkpointed();
    await vi.waitFor(() => expect(worker.destroy).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(runs.get(run.id).status).toBe("ready");
    expect(watch).toHaveBeenCalledWith(run.id, HEAD);
    const saved = storedState(rows(run.id).at(-1)!);
    expect(saved.runner.history).toEqual([message("user", PROMPT), message("assistant", EARLIER)]);
    finishUsers = false;
    await runs.validateFollowUp(run.id, "u");
    runs.enqueue(run.id, "u", "Fix the failing parser CI check.", [], undefined, undefined, undefined, undefined, "ci");
    const fix = "Fix the failing parser CI check.";
    await vi.waitFor(() => expect(workers.at(-1)!.users().filter(text => text.includes(fix))).toHaveLength(1), { timeout: 5000 });
    const reopened = workers.at(-1)!;
    expect(reopened).not.toBe(worker);
    expect(reopened.imported).toEqual(saved.runner);
    expect(reopened.calls.find(call => call.method === "restore_checkpoint")?.args).toMatchObject({ published_head: HEAD });
    expect(reopened.calls.find(call => call.method === "start")?.args).toMatchObject({ interactive: false });
    expect(reopened.users().filter(text => text.includes(fix))).toHaveLength(1);
    expect(reopened.users()).toHaveLength(1); // Framing must not create an extra model turn.
    expect(vi.mocked(checkout).mock.calls.at(-1)?.[5]).toBe(true);
    console.info(`[checkpoint CI reopen] restored history=${JSON.stringify(reopened.imported!.history)} CI fix deliveries=${reopened.users().filter(text => text.includes(fix)).length}`);
  });

  it("preserves a follow-up accepted while finish is flushing checkpoints", async () => {
    const { run, worker } = await checkpointed();
    const flush = deferred(), publication = deferred();
    const exportsBefore = worker.calls.filter(call => call.method === "export_state").length;
    const flushing = vi.spyOn(worker, "flushCheckpoints").mockImplementationOnce(() => flush.promise);
    vi.mocked(importBundle).mockImplementationOnce(() => publication.promise);
    const followUp = "Keep the follow-up accepted during checkpoint flush.";
    try {
      worker.events.push({ type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
      await vi.waitFor(() => expect(flushing).toHaveBeenCalledTimes(1));
      expect(runs.get(run.id).recovery_phase).toBe("finishing");
      expect(worker.calls.filter(call => call.method === "export_state")).toHaveLength(exportsBefore);
      runs.enqueue(run.id, "u", followUp);
      flush.resolve();
      await vi.waitFor(() => expect(importBundle).toHaveBeenCalledTimes(1));
      expect(worker.calls.filter(call => call.method === "export_state")).toHaveLength(exportsBefore + 1);
      // get() reloads SQLite, including the write performed by finish after flush.
      expect(runs.get(run.id).pending.map(item => item.text)).toEqual([followUp]);
      publication.resolve();
      await vi.waitFor(() => expect(worker.users().filter(text => text === followUp)).toHaveLength(1));
      await vi.waitFor(() => expect(storedState(rows(run.id).at(-1)!).runner.history).toContainEqual(message("user", followUp)));
      await restart();
      expect(runs.get(run.id).active_message?.text).toBe(followUp);
      expect(storedState(rows(run.id).at(-1)!).runner.history).toContainEqual(message("user", followUp));
    } finally {
      flush.resolve();
      publication.resolve();
    }
  });

  it("preserves Stop accepted while finish is flushing checkpoints, including after restart", async () => {
    const { run, worker } = await checkpointed();
    const flush = deferred();
    const flushing = vi.spyOn(worker, "flushCheckpoints").mockImplementationOnce(() => flush.promise);
    try {
      worker.events.push({ type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
      await vi.waitFor(() => expect(flushing).toHaveBeenCalledTimes(1));
      await runs.stop(run.id, "u");
      flush.resolve();
      // The interrupt event is polled only after the held finish has returned.
      await vi.waitFor(() => expect(runs.history(run.id, 0)).toContainEqual(expect.objectContaining({ type: "turn.end", stop_reason: "interrupted" })));
      expect(runs.get(run.id)).toMatchObject({ status: "stopped", pending: [] });
      expect(importBundle).not.toHaveBeenCalled();
      expect(runs.history(run.id, 0)).not.toContainEqual(expect.objectContaining({ type: "run.status", step: "Pushing changes" }));
      await restart();
      await runs.recover();
      expect(runs.get(run.id)).toMatchObject({ status: "stopped", pending: [] });
      expect(rows(run.id)).toEqual([]);
      expect(workers).toHaveLength(1);
    } finally { flush.resolve(); }
  });

  it("releases the booting reservation when Stop arrives during resumed checkout", async () => {
    cfg.maxRuns = 1;
    const { run } = await checkpointed();
    vi.stubEnv("GOND_AGENT_AUTO_RESUME", "0");
    await restart();
    await runs.recover();
    const checked = deferred();
    const checkoutMock = vi.mocked(checkout).mockImplementationOnce(async () => {
      await checked.promise;
      return { cwd: "/fake", archive: Buffer.from("repo") };
    });
    const lifecycle = runs as unknown as { booting: Set<string>; launches: Map<string, Promise<void>> };
    try {
      await runs.resume(run.id, "u");
      await vi.waitFor(() => expect(checkoutMock).toHaveBeenCalledTimes(2));
      expect(lifecycle.booting.has(run.id)).toBe(true);
      expect(rows(run.id).at(-1)?.claimed_by).toEqual(expect.any(String));
      await runs.stop(run.id, "u");
      checked.resolve();
      await vi.waitFor(() => {
        expect(lifecycle.booting.has(run.id)).toBe(false);
        expect(lifecycle.launches.has(run.id)).toBe(false);
      });
      expect(runs.get(run.id).status).toBe("stopped");
      expect(rows(run.id)).toEqual([]);
      expect(workers).toHaveLength(1); // Checkout cancellation must not start a worker.
      const replacement = await checkpointed(); // maxRuns=1: a leaked reservation would block this.
      expect(replacement.run.id).not.toBe(run.id);
    } finally { checked.resolve(); }
  });

  it("keeps checkpoint and pending work recoverable when shutdown interrupts resumed checkout", async () => {
    const { run } = await checkpointed();
    const followUp = "Retain this queued follow-up through another restart.";
    runs.enqueue(run.id, "u", followUp);
    const checkpoint = rows(run.id).at(-1)!;
    const saved = storedState(checkpoint);
    vi.stubEnv("GOND_AGENT_AUTO_RESUME", "0");
    await restart();
    await runs.recover();
    const checked = deferred();
    const checkoutMock = vi.mocked(checkout).mockImplementationOnce(async () => {
      await checked.promise;
      return { cwd: "/fake", archive: Buffer.from("repo") };
    });
    try {
      await runs.resume(run.id, "u");
      await vi.waitFor(() => expect(checkoutMock).toHaveBeenCalledTimes(2));
      expect(rows(run.id).at(-1)).toMatchObject({ claimed_by: expect.any(String), consumed_at: null });
      const restarting = restart(); // shutdown sets its flag before yielding to checkout.
      checked.resolve();
      await restarting;
      expect(workers).toHaveLength(1);
      expect(rows(run.id).find(row => row.seq === checkpoint.seq)).toMatchObject({ claimed_by: null, consumed_at: null });
      expect(runs.get(run.id).pending.map(item => item.text)).toEqual([followUp]);
      await runs.recover();
      expect(runs.get(run.id).status).toBe("interrupted");
      await runs.resume(run.id, "u");
      await vi.waitFor(() => expect(workers.at(-1)!.imported).toEqual(saved.runner));
      await vi.waitFor(() => expect(workers.at(-1)!.users()).toHaveLength(1));
      expect(runs.get(run.id).pending.map(item => item.text)).toEqual([followUp]);
    } finally { checked.resolve(); }
  });

  it.each(["saved", "quota rejected"])("keeps the restored predecessor unconsumed until a durable replacement exists (%s)", async outcome => {
    vi.stubEnv("GOND_AGENT_CHECKPOINT_MAX_MB", "1");
    await restart();
    const { run } = await checkpointed();
    const predecessor = rows(run.id).at(-1)!;
    const saved = storedState(predecessor);
    await restart();
    const capture = deferred();
    factory.mockImplementationOnce(async id => {
      const worker = new FakeWorkspace(id);
      worker.captureGate = capture.promise;
      if (outcome === "quota rejected") worker.checkpointBundle = Buffer.alloc(1024 * 1024, 1);
      workers.push(worker);
      return worker;
    });
    try {
      await runs.recover();
      await vi.waitFor(() => expect(workers).toHaveLength(2));
      await vi.waitFor(() => expect(workers.at(-1)!.users()).toHaveLength(1));
      const resumed = workers.at(-1)!;
      expect(resumed.imported).toEqual(saved.runner);
      expect(rows(run.id)).toHaveLength(1);
      expect(rows(run.id)[0]).toMatchObject({ seq: predecessor.seq, claimed_by: expect.any(String), consumed_at: null });
      capture.resolve();
      if (outcome === "saved") {
        await vi.waitFor(() => expect(rows(run.id)).toHaveLength(2));
        expect(rows(run.id).find(row => row.seq === predecessor.seq)?.consumed_at).toEqual(expect.any(Number));
        expect(rows(run.id).at(-1)).toMatchObject({ claimed_by: null, consumed_at: null });
      } else {
        await vi.waitFor(() => expect(resumed.captureErrors).toHaveLength(1));
        expect(rows(run.id)).toHaveLength(1);
        expect(rows(run.id)[0]).toMatchObject({ seq: predecessor.seq, consumed_at: null });
        expect(runs.get(run.id).status).toBe("working");
        await restart();
        await runs.recover();
        await vi.waitFor(() => expect(workers).toHaveLength(3));
        await vi.waitFor(() => expect(workers.at(-1)!.imported).toEqual(saved.runner));
      }
    } finally { capture.resolve(); }
  });

  it.each(["confirmed", "lost push response"])("restores the published head after restart with %s publication", async publication => {
    const { run } = await checkpointed();
    // The confirmed head deliberately differs from the checkpoint's HEAD.
    const publishedHead = publication === "confirmed" ? "d".repeat(40) : HEAD;
    db.prepare("UPDATE runs SET data=json_set(data,'$.pushed',json(?),'$.head_sha',?,'$.publication_head',?) WHERE id=?")
      .run(publication === "confirmed" ? "true" : "false", publication === "confirmed" ? publishedHead : null,
        publication === "lost push response" ? HEAD : null, run.id);
    await restart();
    await runs.recover();
    await vi.waitFor(() => expect(workers.at(-1)!.imported).toBeDefined());
    expect(vi.mocked(checkout).mock.calls.at(-1)?.[5]).toBe(true);
    expect(vi.mocked(checkout).mock.calls.at(-1)?.[8]).toBe(BASE);
    expect(workers.at(-1)!.calls.find(call => call.method === "restore_checkpoint")?.args).toMatchObject({
      head_sha: HEAD, published_head: publishedHead,
    });
    expect(runs.get(run.id)).toMatchObject({ pushed: true, head_sha: publishedHead });
    if (publication === "lost push response") {
      expect(branchHead).toHaveBeenCalledWith("acme/app", run.branch, expect.any(Object));
      expect(vi.mocked(branchHead).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(checkout).mock.invocationCallOrder.at(-1)!);
    } else {
      expect(branchHead).not.toHaveBeenCalled();
      expect(vi.mocked(checkout).mock.calls.at(-1)?.[11]).toBe(true);
    }
  });

  it("keeps CI provenance on the restored continuation when a human follows up while interrupted", async () => {
    vi.stubEnv("GOND_AGENT_CI_FIX_ROUNDS", "2");
    disableCiNetwork();
    finishUsers = true;
    const { run, worker } = await checkpointed();
    await vi.waitFor(() => expect(worker.destroy).toHaveBeenCalledTimes(1));
    finishUsers = false;
    const fix = "Fix the parser CI failure before accepting more work.";
    await runs.validateFollowUp(run.id, "u");
    runs.enqueue(run.id, "u", fix, [], undefined, undefined, undefined, undefined, "ci");
    await vi.waitFor(() => expect(storedState(rows(run.id).at(-1)!).runner.history).toContainEqual({ role: "user", content: [{ type: "text", text: expect.stringContaining(fix) }] }));
    expect(runs.get(run.id).active_message?.source).toBe("ci");
    const checkpoint = rows(run.id).at(-1)!;
    const saved = storedState(checkpoint);
    expect(saved.service.automatic).toBe(true);
    vi.stubEnv("GOND_AGENT_AUTO_RESUME", "0");
    await restart();
    await runs.recover();
    expect(runs.get(run.id).status).toBe("interrupted");
    const checked = deferred();
    const checkoutMock = vi.mocked(checkout).mockImplementationOnce(async () => {
      await checked.promise;
      return { cwd: "/fake", archive: Buffer.from("repo") };
    });
    const human = "Also improve the parser error message.";
    try {
      runs.enqueue(run.id, "u", human);
      await vi.waitFor(() => expect(checkoutMock).toHaveBeenCalledTimes(3));
      expect(runs.get(run.id)).toMatchObject({ ci_turn: false, ci_publication_pending: true });
      checked.resolve();
      await vi.waitFor(() => expect(workers).toHaveLength(3));
      await vi.waitFor(() => expect(workers.at(-1)!.users()).toHaveLength(1));
      const resumed = workers.at(-1)!;
      expect(resumed.imported).toEqual(saved.runner);
      expect(resumed.users()[0]).toContain("The run was restarted.");
      expect(resumed.users()[0]).not.toContain(human);
      expect(runs.get(run.id)).toMatchObject({ ci_turn: true, ci_publication_pending: true, active_message: { source: "ci" } });
      expect(runs.get(run.id).pending.map(item => item.text)).toEqual([human]);
      await vi.waitFor(() => expect(rows(run.id).at(-1)!.seq).toBeGreaterThan(checkpoint.seq));
      expect(storedState(rows(run.id).at(-1)!).service.automatic).toBe(true);
    } finally { checked.resolve(); }
  });

  it("automatically resumes at most twice across repeated process restarts", async () => {
    const { run } = await checkpointed();
    for (let attempt = 1; attempt <= 2; attempt++) {
      await restart();
      await runs.recover();
      await vi.waitFor(() => expect(workers).toHaveLength(attempt + 1), { timeout: 5000 });
      await vi.waitFor(() => expect(workers.at(-1)!.users().length).toBeGreaterThan(0), { timeout: 5000 });
      expect(workers.at(-1)!.imported?.history[0]).toEqual(message("user", PROMPT));
    }
    await restart();
    await runs.recover();
    expect(workers).toHaveLength(3);
    expect(runs.get(run.id).status).toBe("interrupted");
    expect(runs.history(run.id, 0).filter(event => event.type === "run.resumed")).toHaveLength(2);
    // The automatic cap must not disable an explicit, owner-authorized resume.
    await runs.resume(run.id, "u");
    await vi.waitFor(() => expect(workers).toHaveLength(4), { timeout: 5000 });
    await vi.waitFor(() => expect(workers.at(-1)!.imported).toBeDefined(), { timeout: 5000 });
  });

  it.each(["older than 24 hours", "scheduled", "stopped"])("does not auto-resume work that is %s", async reason => {
    const { run } = await checkpointed(reason === "scheduled" ? "schedule" : "web");
    if (reason === "stopped") {
      await runs.stop(run.id, "u");
      await vi.waitFor(() => expect(runs.get(run.id).status).toBe("stopped"));
    }
    await restart();
    if (reason === "older than 24 hours") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 3600_000 + 1);
    await runs.recover();
    expect(workers).toHaveLength(1);
    expect(runs.get(run.id).status).toBe(reason === "stopped" ? "stopped" : "interrupted");
    expect(runs.history(run.id, 0).some(event => event.type === "run.resumed")).toBe(false);
  });

  it("falls back before container creation if the checkpoint's pinned checkout is unavailable", async () => {
    const { run } = await checkpointed();
    await restart();
    vi.mocked(checkout).mockRejectedValueOnce(new Error("Pinned checkpoint parent is unavailable"));
    await runs.recover();
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    await vi.waitFor(() => expect(workers.at(-1)!.users()).toHaveLength(1));
    const fresh = workers.at(-1)!;
    expect(fresh.imported).toBeUndefined();
    expect(fresh.users()[0]).toBe(PROMPT);
    expect(vi.mocked(checkout).mock.calls.at(-1)?.[10]).toBeUndefined();
    expect(runs.history(run.id, 0).filter(event => event.type === "run.checkpoint_fallback")).toEqual([
      expect.objectContaining({ message: expect.stringContaining("base checkout is unavailable") }),
    ]);
  });

  it("replays the original task if a second restart must fall back after a synthetic continuation", async () => {
    const { run } = await checkpointed();
    await restart();
    vi.spyOn(FakeWorkspace.prototype, "capture").mockImplementationOnce(async () => {});
    await runs.recover();
    await vi.waitFor(() => expect(workers.at(-1)!.users()).toHaveLength(1));
    await vi.waitFor(() => expect((runs as unknown as { booting: Set<string> }).booting.size).toBe(0));
    expect(runs.get(run.id).active_message?.text).toContain("The run was restarted.");
    await restart();
    vi.mocked(checkout).mockRejectedValueOnce(new Error("Pinned checkpoint parent is unavailable"));
    await runs.recover();
    await vi.waitFor(() => expect(workers.at(-1)!.users()).toEqual([PROMPT]));
    expect(workers.at(-1)!.imported).toBeUndefined();
    expect(runs.get(run.id).active_message?.text).toBe(PROMPT);
  });

  it("reports a restore failure and uses a fresh workspace factory result for fallback", async () => {
    const { run, worker: original } = await checkpointed();
    await restart();
    let rejected: FakeWorkspace | undefined;
    factory.mockImplementationOnce(async id => {
      const worker = new FakeWorkspace(id);
      workers.push(worker);
      rejected = worker;
      const rpc = worker.rpc.bind(worker);
      vi.spyOn(worker, "rpc").mockImplementation(async (method, args) => {
        if (method === "restore_checkpoint") throw new Error("fixture restore failed");
        return rpc(method, args);
      });
      return worker;
    });
    await runs.recover();
    await vi.waitFor(() => expect(workers).toHaveLength(3), { timeout: 5000 });
    await vi.waitFor(() => expect(workers.at(-1)!.users().some(text => text.includes(PROMPT))).toBe(true), { timeout: 5000 });
    expect(rejected!.destroy).toHaveBeenCalledTimes(1);
    expect(rejected!.users()).toEqual([]);
    const fresh = workers.at(-1)!;
    expect(fresh).not.toBe(original);
    expect(fresh).not.toBe(rejected);
    expect(fresh.imported).toBeUndefined();
    expect(fresh.calls.some(call => call.method === "setup")).toBe(true);
    expect(fresh.calls.some(call => call.method === "start")).toBe(true);
    expect(fresh.calls.some(call => call.method === "restore_checkpoint" || call.method === "import_state")).toBe(false);
    expect(fresh.users().filter(text => text.includes(PROMPT))).toHaveLength(1);
    expect(runs.history(run.id, 0).filter(event => event.type === "run.checkpoint_fallback")).toEqual([
      expect.objectContaining({ message: expect.stringContaining("fresh checkout") }),
    ]);
    expect(runs.history(run.id, 0).some(event => event.type === "run.resumed")).toBe(false);
    expect(vi.mocked(checkout)).toHaveBeenCalledTimes(3);
  });

  it.each(["checkout", "factory"])("releases the checkpoint claim after a failed %s boot so an owner can retry", async stage => {
    const { run } = await checkpointed();
    const checkpoint = rows(run.id).at(-1)!;
    const saved = storedState(checkpoint);
    vi.stubEnv("GOND_AGENT_AUTO_RESUME", "0");
    await restart();
    await runs.recover();
    const heldDuringBoot: boolean[] = [];
    const fail = async () => {
      heldDuringBoot.push(typeof rows(run.id).find(row => row.seq === checkpoint.seq)?.claimed_by === "string");
      throw new Error(`fixture ${stage} boot failed`);
    };
    // Both the checkpoint prerequisite and its fresh-branch fallback fail.
    if (stage === "checkout") vi.mocked(checkout).mockImplementationOnce(fail).mockImplementationOnce(fail);
    else factory.mockImplementationOnce(fail);
    await runs.resume(run.id, "u");
    await vi.waitFor(() => expect(runs.get(run.id).status).toBe("interrupted"), { timeout: 5000 });
    expect(heldDuringBoot).toEqual(stage === "checkout" ? [true, false] : [true]);
    expect(rows(run.id).find(row => row.seq === checkpoint.seq)).toMatchObject({ claimed_by: null, consumed_at: null });
    expect(runs.history(run.id, 0).some(event => event.type === "run.resumed")).toBe(false);
    await runs.resume(run.id, "u");
    await vi.waitFor(() => expect(workers.at(-1)!.imported).toEqual(saved.runner), { timeout: 5000 });
    await vi.waitFor(() => expect(rows(run.id).find(row => row.seq === checkpoint.seq)?.consumed_at).toEqual(expect.any(Number)), { timeout: 5000 });
    expect(runs.history(run.id, 0).filter(event => event.type === "run.resumed")).toHaveLength(1);
  });

  it("leaves quota-exhausted automatic recovery interrupted with its checkpoint available", async () => {
    const { run } = await checkpointed();
    await restart();
    const before = rows(run.id);
    const selection = vi.spyOn(runs, "resolveSelection").mockRejectedValue(new ApiError(429, "usage_limit", "Your plan usage limit has been reached."));
    await runs.recover();
    expect(selection).toHaveBeenCalledWith("u", "local:coder");
    expect(runs.get(run.id).status).toBe("interrupted");
    expect(workers).toHaveLength(1);
    expect(rows(run.id)).toEqual(before);
    expect(rows(run.id).at(-1)).toMatchObject({ claimed_by: null, consumed_at: null });
    expect(runs.history(run.id, 0).some(event => event.type === "run.resumed")).toBe(false);
    // Exhausting quota must not spend an automatic attempt or discard recoverable history.
    selection.mockRestore();
    await runs.resume(run.id, "u");
    await vi.waitFor(() => expect(workers.at(-1)!.imported).toEqual(storedState(before.at(-1)!).runner), { timeout: 5000 });
    expect(runs.get(run.id).auto_resumes ?? 0).toBe(0);
  });

  it("serializes two automatic resumes even with maxRuns=2 until the first turn finishes", async () => {
    expect(cfg.maxRuns).toBe(2);
    account("other");
    const first = await checkpointed();
    const second = await checkpointed("web", "other");
    // Make recovery order explicit, independent of clock resolution/account fairness.
    db.prepare("UPDATE runs SET created_at=? WHERE id=?").run(1, first.run.id);
    db.prepare("UPDATE runs SET created_at=? WHERE id=?").run(2, second.run.id);
    const firstState = storedState(rows(first.run.id).at(-1)!);
    const secondState = storedState(rows(second.run.id).at(-1)!);
    await restart();
    await runs.recover();
    await vi.waitFor(() => expect(workers.filter(worker => worker.id === first.run.id)).toHaveLength(2), { timeout: 5000 });
    const resumedFirst = workers.at(-1)!;
    await vi.waitFor(() => expect(resumedFirst.users().length).toBeGreaterThan(0), { timeout: 5000 });
    await vi.waitFor(() => expect(runs.get(first.run.id).summary.text).toContain("Completed the next parser step."), { timeout: 5000 });
    expect(resumedFirst.imported).toEqual(firstState.runner);
    runs.drain();
    expect(runs.get(first.run.id).status).toBe("working");
    expect(runs.get(second.run.id).status).toBe("queued");
    expect(workers.filter(worker => worker.id === second.run.id)).toHaveLength(1);
    expect(runs.history(second.run.id, 0).some(event => event.type === "run.resumed")).toBe(false);
    resumedFirst.events.push({ type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
    await vi.waitFor(() => expect(runs.get(first.run.id).status).toBe("ready"), { timeout: 5000 });
    await vi.waitFor(() => expect(workers.filter(worker => worker.id === second.run.id)).toHaveLength(2), { timeout: 5000 });
    const resumedSecond = workers.at(-1)!;
    await vi.waitFor(() => expect(resumedSecond.users().length).toBeGreaterThan(0), { timeout: 5000 });
    expect(resumedSecond.imported).toEqual(secondState.runner);
    expect(runs.get(second.run.id).status).toBe("working");
    for (const { run } of [first, second]) expect(runs.history(run.id, 0).filter(event => event.type === "run.resumed")).toHaveLength(1);
  });

  it("keeps the last valid checkpoint and the active run when a later capture exceeds storage quota", async () => {
    vi.stubEnv("GOND_AGENT_CHECKPOINT_MAX_MB", "1");
    await restart(); // Apply the configured quota at service construction.
    const { run, worker } = await checkpointed();
    const before = rows(run.id);
    await worker.capture(Buffer.alloc(1024 * 1024, 1)); // Bundle alone fits; sealed state makes it exceed quota.
    expect(worker.captureErrors).toHaveLength(1);
    expect(rows(run.id)).toEqual(before);
    expect(runs.get(run.id).status).toBe("working");
    expect(worker.destroy).not.toHaveBeenCalled();
    expect(storedState(before.at(-1)!).runner.history[0]).toEqual(message("user", PROMPT));
    await restart();
    await runs.recover();
    await vi.waitFor(() => expect(workers.at(-1)!.imported?.history[0]).toEqual(message("user", PROMPT)), { timeout: 5000 });
  });

  it("removes owned checkpoint files before auth deletion, including soft-deleted runs, without touching another owner", async () => {
    vi.stubEnv("GOND_AGENT_CI_FIX_ROUNDS", "2");
    disableCiNetwork();
    finishUsers = true;
    account("other");
    const active = await checkpointed();
    await vi.waitFor(() => expect(active.worker.destroy).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const deleted = await checkpointed();
    await vi.waitFor(() => expect(deleted.worker.destroy).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const other = await checkpointed("web", "other");
    await vi.waitFor(() => expect(other.worker.destroy).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const owned = [...rows(active.run.id), ...rows(deleted.run.id)];
    const retained = rows(other.run.id);
    for (const id of [active.run.id, deleted.run.id, other.run.id]) expect(rows(id).length).toBeGreaterThanOrEqual(1);
    expect(owned.length).toBeGreaterThanOrEqual(2);
    expect(retained.length).toBeGreaterThanOrEqual(1);
    for (const row of [...owned, ...retained]) {
      expect(existsSync(join(dir, "checkpoints", row.bundle_path))).toBe(true);
      expect(existsSync(join(dir, "checkpoints", row.state_path))).toBe(true);
    }
    // Simulate an older soft-delete with leftover artifacts; get() deliberately hides this run.
    db.prepare("UPDATE runs SET deleted_at=? WHERE id=?").run(Date.now(), deleted.run.id);
    await runs.withAccountDeletion("u", async prepare => {
      await prepare();
      expect(db.prepare('SELECT 1 FROM "user" WHERE id=?').get("u")).toBeDefined();
      for (const id of [active.run.id, deleted.run.id]) {
        expect(rows(id)).toEqual([]);
        expect(existsSync(join(dir, "checkpoints", id))).toBe(false);
      }
      for (const row of owned) {
        expect(existsSync(join(dir, "checkpoints", row.bundle_path))).toBe(false);
        expect(existsSync(join(dir, "checkpoints", row.state_path))).toBe(false);
      }
      expect(rows(other.run.id)).toEqual(retained);
      for (const row of retained) {
        expect(existsSync(join(dir, "checkpoints", row.bundle_path))).toBe(true);
        expect(existsSync(join(dir, "checkpoints", row.state_path))).toBe(true);
      }
      db.prepare('DELETE FROM "user" WHERE id=?').run("u");
    });
    expect(db.prepare("SELECT 1 FROM runs WHERE user_id=?").get("u")).toBeUndefined();
    expect(runs.get(other.run.id, "other").status).toBe("ready");
  });
});
