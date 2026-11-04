import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthentication, seal, unseal } from "../src/auth";
import type { Checkpoint } from "../src/checkpoints";
import type { Config } from "../src/config";
import type { Workspace, WorkspaceCheckpoint, WorkspaceCheckpointOptions, WorkspaceFactory } from "../src/containers";
import { openStore } from "../src/db";
import { branchHead, checkout, gh, importBundle, pushBranch } from "../src/github";
import { saveProviderSettings } from "../src/providers";
import { Runs, parseRun } from "../src/runs/service";
import { ApiError } from "../src/wire";
import { RetryError } from "../src/retry";
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
const VERSION = "gond-agent-checkpoint-4", LEGACY_VERSION = "gond-agent-checkpoint-2";
const COUNTERS = { sub_counter: 3, main_context: 12345, plan_calls: 7,
  plan_last: [{ text: "Inspect parser", status: "done" }], plan_nudges: 2, turn_compactions: 1, skipped_history_len: 2 };
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
  stateFixture?: Partial<State>;
  evidenceKey?: string;
  options?: WorkspaceCheckpointOptions;
  save?: (value: WorkspaceCheckpoint) => void | Promise<void>;
  onError?: (error: unknown) => void;
  captureErrors: unknown[] = [];
  checkpointError?: unknown;
  captureGate?: Promise<void>;
  checkpointBundle = Buffer.from("opaque-checkpoint-bundle");
  tree?: Record<string, string>;
  finalCaptures = 0;
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
      schema_version: 1, run_id: this.id, owner_id: this.options.owner_id, plan: [],
      counters: { sub_counter: 0, main_context: 0, plan_calls: 0, plan_last: [], plan_nudges: 0,
        turn_compactions: 0, skipped_history_len: null },
      ...structuredClone(this.stateFixture),
      runner_state_version: VERSION, history: structuredClone(this.history),
    };
    if (state.evidence != null) state.evidence = this.exportEvidence().state.evidence;
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

  async captureCheckpoint() {
    this.finalCaptures++;
    await this.capture(this.tree ? Buffer.from(JSON.stringify(this.tree)) : this.checkpointBundle);
    await this.flushCheckpoints();
  }
  async flushCheckpoints() { if (this.checkpointError) throw this.checkpointError; }

  exportEvidence() {
    const reply = evidenceState(this.evidenceKey);
    const ledger = this.stateFixture?.evidence as Record<string, unknown> | undefined;
    const start = this.calls.find(call => call.method === "start")?.args;
    reply.state.evidence = { ...reply.state.evidence, ...structuredClone(ledger), key: this.evidenceKey!,
      gate_rounds: Math.max(Number(ledger?.gate_rounds ?? 0), Number(start?.evidence_gate_rounds ?? 0)),
      resumes: Math.max(Number(ledger?.resumes ?? 0), Number(start?.evidence_resumes ?? 0)) };
    return reply;
  }

  async rpc<T = any>(method: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push(structuredClone({ method, args }));
    let result: unknown = true;
    if (method === "init_evidence") {
      if (typeof args?.key !== "string" || !/^[a-f0-9]{64}$/.test(args.key)) throw new Error("Invalid evidence key");
      this.evidenceKey = args.key;
      result = { type: "state.evidence_initialized" };
    } else if (method === "export_state") {
      result = this.exportEvidence();
    } else if (method === "import_state") {
      if (!this.evidenceKey) throw new Error("Evidence must be initialized before import");
      this.imported = structuredClone(args!.state as State);
      this.history = structuredClone(this.imported.history);
      this.stateFixture = structuredClone(this.imported);
      const ledger = this.stateFixture.evidence as Record<string, unknown> | undefined;
      if (ledger) ledger.historical_ids = (ledger.records as { id: string }[]).map(record => record.id);
      result = { type: "state.imported", request_id: args?.request_id };
    } else if (method === "restore_checkpoint") {
      const bundle = Buffer.from(args!.bundle as string, "base64").toString();
      if (bundle.startsWith("{")) this.tree = JSON.parse(bundle);
      result = { base_sha: BASE, head_sha: HEAD, checkpoint_sha: TREE };
    } else if (method === "events") {
      result = { events: this.events.splice(0), alive: !this.destroyed };
    } else if (method === "workspace_state") {
      result = { head: HEAD, clean: true };
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
function account(id: string) {
  db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
    .run(id, "User", `${id}@example.test`, 0, Date.now(), Date.now());
  db.prepare("INSERT INTO github_connections(user_id,token,connected_at) VALUES(?,?,?)")
    .run(id, seal(cfg.secret, "test-managed-github-token"), Date.now());
}

beforeEach(async () => {
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
  vi.useRealTimers();
  await runs.shutdown();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("checkpoint-backed Runs recovery (fake Workspace, real SQLite/files)", () => {
  async function failLive(step: "model" | "push" | "turn" | "snapshot" | "import", fakeTimers = false) {
    const { run, worker } = await checkpointed();
    // These changes happened AFTER the last periodic pair; retaining that pair is insufficient.
    worker.tree = { "unpushed.txt": "work after the periodic checkpoint\n" };
    worker.history.push(message("assistant", "Remember the unpublished parser decision."));
    const history = structuredClone(worker.history);
    if (fakeTimers) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    if (step === "model") {
      worker.events.push({ type: "error", agent_id: "main", code: "provider_unavailable", attempts: 5 });
    } else if (step === "push" || step === "import") {
      vi.mocked(importBundle).mockRejectedValueOnce(new RetryError(step,
        { class: "network", retryable: true, reason: "Connection reset" }, 5));
      worker.events.push({ type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
    } else {
      const rpc = worker.rpc.bind(worker);
      vi.spyOn(worker, "rpc").mockImplementation(async (method, args) => {
        if (method === (step === "snapshot" ? "snapshot" : "events"))
          throw new RetryError(step, { class: "unknown", retryable: false, reason: "Operation failed" }, 1);
        return rpc(method, args);
      });
      if (step === "snapshot") worker.events.push({ type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
    }
    await vi.waitFor(() => expect(runs.get(run.id)).toMatchObject({ status: "failed", work_kept: true, last_error: { step } }));
    return { run, worker, history };
  }

  it.each(["model", "push", "turn", "snapshot", "import"] as const)("checkpoints a live %s failure before keep expiry destroys it, then restores tree AND history", async step => {
    vi.stubEnv("GOND_AGENT_FAILED_KEEP_MINUTES", "1");
    const { run, worker, history } = await failLive(step, true);
    const imports = vi.mocked(importBundle).mock.calls.length;
    const pushes = vi.mocked(pushBranch).mock.calls.length;
    const snapshots = worker.calls.filter(call => call.method === "snapshot").length;
    expect(worker.finalCaptures).toBe(0); // Kept workspace is not disturbed.
    const destroy = worker.destroy.getMockImplementation()!;
    worker.destroy.mockImplementation(async () => {
      expect(worker.finalCaptures).toBeGreaterThan(0); // Structural release guard, for every failure step.
      expect(storedState(rows(run.id).at(-1)!).runner.history).toEqual(history);
      await destroy();
    });
    // Fire the actual keep timer, not a direct teardown call.
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(worker.destroyed).toBe(true));
    vi.useRealTimers();
    expect(runs.get(run.id)).toMatchObject({ status: "failed", work_kept: false, resume_from_checkpoint: true });
    expect(runs.get(run.id).error).toContain("Your changes and the conversation are saved; send a follow-up to continue");
    expect(importBundle).toHaveBeenCalledTimes(imports);
    expect(pushBranch).toHaveBeenCalledTimes(pushes);
    expect(worker.calls.filter(call => call.method === "snapshot")).toHaveLength(snapshots);
    expect(vi.mocked(gh).mock.calls.filter(call => ["POST", "PATCH"].includes(String(call[1])))).toEqual([]);
    // Reopen SQLite and the service to prove this does not depend on worker/API memory.
    await restart();
    runs.enqueue(run.id, "u", "Continue with the saved decision.");
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    const resumed = workers.at(-1)!;
    await vi.waitFor(() => expect(resumed.imported?.history).toEqual(history));
    expect(resumed.tree).toEqual(worker.tree);
    expect(resumed.calls.map(call => call.method).indexOf("restore_checkpoint"))
      .toBeLessThan(resumed.calls.map(call => call.method).indexOf("import_state"));
    console.info(`[failed checkpoint ${step}] released=true restored_unpushed_edit=${!!resumed.tree?.["unpushed.txt"]} restored_history=${resumed.imported!.history.length}/${history.length} release_publication_calls=0`);
  });

  it("routes an initial-delivery failure through the same final-capture guard with zero keep time", async () => {
    vi.stubEnv("GOND_AGENT_FAILED_KEEP_MINUTES", "0");
    const rpc = FakeWorkspace.prototype.rpc;
    vi.spyOn(FakeWorkspace.prototype, "rpc").mockImplementation(async function(this: FakeWorkspace, method, args) {
      const result = await rpc.call(this, method, args);
      if (method === "send" && (args?.input as { type: string }).type === "user") {
        this.tree = { "initial.txt": "unpublished initial delivery" };
        this.history.push(message("assistant", "Initial delivery failed after this decision."));
        throw new Error("Delivery connection failed");
      }
      return result;
    });
    const run = await create();
    await vi.waitFor(() => expect(workers[0]?.destroyed).toBe(true));
    const worker = workers[0]!;
    expect(worker.finalCaptures).toBe(1);
    expect(runs.get(run.id)).toMatchObject({ status: "failed", work_kept: false, resume_from_checkpoint: true });
    expect(storedState(rows(run.id).at(-1)!).runner.history).toEqual(worker.history);
    expect(JSON.parse(readFileSync(join(dir, "checkpoints", rows(run.id).at(-1)!.bundle_path), "utf8"))).toEqual(worker.tree);
    expect(importBundle).not.toHaveBeenCalled();
    expect(pushBranch).not.toHaveBeenCalled();
  });

  it.each(["model", "effort", "user"])("does not consume an initial request when %s input delivery fails before acceptance", async inputType => {
    vi.stubEnv("GOND_AGENT_FAILED_KEEP_MINUTES", "0");
    const rpc = FakeWorkspace.prototype.rpc;
    let rejectDelivery = true;
    vi.spyOn(FakeWorkspace.prototype, "rpc").mockImplementation(async function(this: FakeWorkspace, method, args) {
      if (rejectDelivery && method === "send" && (args?.input as { type: string }).type === inputType) {
        rejectDelivery = false;
        this.tree = { "before-delivery.txt": "local initialization work" };
        throw new Error("Delivery failed before acceptance");
      }
      return rpc.call(this, method, args);
    });
    const run = await create();
    await vi.waitFor(() => expect(workers[0]?.destroyed).toBe(true));
    expect(workers[0]!.finalCaptures).toBe(1);
    const saved = storedState(rows(run.id).at(-1)!);
    expect(saved.runner.history).toEqual([]);
    expect(saved.service.active_message_id).toBeUndefined();
    await restart();
    finishUsers = true;
    runs.enqueue(run.id, "u", "Continue after delivery failed.");
    await vi.waitFor(() => expect(runs.get(run.id).status).toBe("ready"), { timeout: 5000 });
    const resumed = workers.at(-1)!;
    expect(resumed.imported?.history).toEqual([]);
    expect(resumed.tree).toEqual({ "before-delivery.txt": "local initialization work" });
    expect(resumed.users().filter(text => text.includes(PROMPT))).toHaveLength(1);
    expect(resumed.users().filter(text => text.includes("Continue after delivery failed."))).toHaveLength(1);
  });

  it.each(["timeout", "size cap"] as const)("bounds failed-release capture and reports %s fallback without late resurrection", async outcome => {
    if (outcome === "size cap") {
      await runs.shutdown();
      vi.stubEnv("GOND_AGENT_CHECKPOINT_MAX_MB", "1");
      runs = new Runs(db, cfg, factory);
    }
    const { run, worker } = await failLive("model");
    const gate = deferred();
    if (outcome === "timeout") worker.captureGate = gate.promise;
    else worker.tree = { oversized: "x".repeat(1024 * 1024) };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const closing = runs.close(run.id);
    try {
      await vi.advanceTimersByTimeAsync(10_001);
      await closing;
      expect(worker.destroyed).toBe(true);
      expect(runs.get(run.id)).toMatchObject({ work_kept: false, resume_from_checkpoint: false });
      expect(runs.get(run.id).error).toContain("could not be saved");
      expect(runs.get(run.id).error).toContain(outcome === "timeout" ? "within 10 seconds" : "size or storage limit");
      expect(runs.get(run.id).error).toContain("last pushed branch");
      expect(rows(run.id)).toHaveLength(0);
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(rows(run.id)).toHaveLength(0); // A late private reply cannot recreate the deleted pair.
      expect(importBundle).not.toHaveBeenCalled();
      expect(pushBranch).not.toHaveBeenCalled();
    } finally { gate.resolve(); vi.useRealTimers(); }
  });

  it("serializes follow-up admission against a failed close capture, and explicit Close deletes the saved pair", async () => {
    const { run, worker } = await failLive("model");
    const gate = deferred();
    worker.captureGate = gate.promise;
    const closing = runs.close(run.id);
    try {
      await vi.waitFor(() => expect(worker.finalCaptures).toBe(1));
      expect(() => runs.enqueue(run.id, "u", "Do not race the capture")).toThrow(/workspace is closing/i);
      expect(worker.destroy).not.toHaveBeenCalled();
    } finally { gate.resolve(); await closing; }
    expect(runs.get(run.id).pending).toEqual([]);
    expect(rows(run.id).length).toBeGreaterThan(0);
    await runs.closeSession(run.id, "u");
    expect(rows(run.id)).toHaveLength(0);
  });

  it.each([false, true])("explicit Close of a kept failure deletes the final pair even when destruction fails: %s", async destroyFails => {
    const { run, worker } = await failLive("model");
    if (destroyFails) worker.destroy.mockRejectedValueOnce(new Error("Destroy unavailable"));
    const closing = runs.closeSession(run.id, "u");
    if (destroyFails) await expect(closing).rejects.toThrow("Destroy unavailable");
    else await closing;
    expect(worker.finalCaptures).toBe(1);
    expect(rows(run.id)).toHaveLength(0);
    expect(runs.get(run.id).resume_from_checkpoint).toBe(false);
    expect(runs.get(run.id).error).not.toContain("are saved");
    expect(importBundle).not.toHaveBeenCalled();
    expect(pushBranch).not.toHaveBeenCalled();
  });

  it("keeps workerLost on the existing last-checkpoint path without asking a dead worker to capture", async () => {
    const { run, worker } = await checkpointed();
    const history = storedState(rows(run.id).at(-1)!).runner.history;
    worker.destroyed = true;
    await vi.waitFor(() => expect(runs.get(run.id).status).toBe("interrupted"));
    expect(worker.finalCaptures).toBe(0);
    expect(storedState(rows(run.id).at(-1)!).runner.history).toEqual(history);
    expect(runs.get(run.id).resume_from_checkpoint).toBe(true);
  });

  it("finishes, publishes and captures checkpoints without starting post-push automation", async () => {
    const { run, worker } = await checkpointed();
    const flushed = vi.spyOn(worker, "flushCheckpoints");
    const captured = vi.spyOn(worker, "captureCheckpoint");
    worker.events.push({ type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
    await vi.waitFor(() => expect(runs.get(run.id).status).toBe("ready"));
    expect(flushed).toHaveBeenCalled();
    expect(captured).toHaveBeenCalledWith({ head_sha: HEAD });
    expect(importBundle).toHaveBeenCalledTimes(1);
    expect(runs.get(run.id)).toMatchObject({ pushed: true, head_sha: HEAD, pr_number: 42, phase: "agent" });
    expect(runs.get(run.id).recovery_phase).toBeUndefined();
    expect(worker.destroy).not.toHaveBeenCalled();
    expect(runs).not.toHaveProperty("ci");
    const history = runs.history(run.id, 0);
    expect(history.filter(event => event.type === "run.ci" || event.type === "ci")).toEqual([]);
    expect(history.filter(event => event.type === "user")).toHaveLength(1);
    const service = storedState(rows(run.id).at(-1)!).service;
    expect(service).not.toHaveProperty("automatic");
    console.info(`[publication without CI] status=${runs.get(run.id).status} pushed=${runs.get(run.id).pushed} PR=${runs.get(run.id).pr_number} workspace_destroyed=${worker.destroyed} run.ci=0 event_types=${JSON.stringify(history.map(event => event.type))}`);
  });

  it("parseRun tolerates legacy ci_* fields in stored runs and checkpoint recovery metadata", async () => {
    const { run } = await checkpointed();
    const original = runs.get(run.id);
    const legacyFields = { ci_active: true, ci_turn: true, ci_publication_pending: true, ci_round: 2,
      ci_state: "pending", ci_sha: HEAD, ci_previous_sha: BASE, ci_failing: ["tests"], ci_reason: "old" };
    await runs.shutdown(); // Seed the previous version's state after the live writer stops.
    const stored = JSON.stringify({ ...original, ...legacyFields,
      active_message: { ...original.active_message, source: "ci", ...legacyFields },
      recovery_task: { ...original.recovery_task, source: "ci", ...legacyFields } });
    db.prepare("UPDATE runs SET data=? WHERE id=?").run(stored, run.id);
    const oldCheckpoint = rows(run.id).at(-1)!;
    const saved = storedState(oldCheckpoint);
    const legacyCheckpoint = runs.checkpoints.save({ runId: run.id, ownerId: "u", runnerVersion: VERSION,
      bundle: Buffer.from("opaque-checkpoint-bundle"), tree: { baseSha: BASE, headSha: HEAD, checkpointSha: TREE },
      state: JSON.stringify({ runner: saved.runner, service: { ...saved.service, automatic: true, ...legacyFields } }) });
    const stateBefore = readFileSync(join(dir, "checkpoints", legacyCheckpoint.state_path));
    db.close();
    db = openStore(dir);
    runs = new Runs(db, cfg, factory);
    // Neither startup nor a read migrates the historical JSON/checkpoint files.
    expect((db.prepare("SELECT data FROM runs WHERE id=?").get(run.id) as { data: string }).data).toBe(stored);
    expect(readFileSync(join(dir, "checkpoints", legacyCheckpoint.state_path))).toEqual(stateBefore);
    expect(runs.get(run.id)).toEqual(parseRun(stored));
    expect(Object.keys(runs.get(run.id)).some(key => key.startsWith("ci_"))).toBe(false);
    finishUsers = true;
    await runs.recover();
    await vi.waitFor(() => expect(runs.get(run.id).status).toBe("ready"));
    const resumed = workers.at(-1)!;
    expect(resumed.imported).toEqual(saved.runner);
    expect(resumed.calls.find(call => call.method === "start")?.args).toMatchObject({ interactive: true });
    expect(resumed.users()).toHaveLength(1);
    expect(resumed.users()[0]).toContain("The run was restarted.");
    expect(resumed.users()[0]).not.toContain(PROMPT);
    expect(runs.get(run.id)).toMatchObject({ pushed: true, pr_number: 42, auto_resume_pending: false, pending: [] });
    expect(runs.get(run.id).recovery_phase).toBeUndefined();
    expect(storedState(rows(run.id).at(-1)!).service).not.toHaveProperty("automatic");
    expect(runs.history(run.id, 0).filter(event => event.type === "run.ci")).toEqual([]);
    expect(resumed.destroy).not.toHaveBeenCalled();
    console.info(`[legacy recovery] ci_fields_ignored=true checkpoint_history_restored=true continuation_deliveries=${resumed.users().length} interactive=true status=${runs.get(run.id).status} pushed=${runs.get(run.id).pushed} PR=${runs.get(run.id).pr_number} run.ci=0`);
  });

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

  it.each(["absent", "null"])("authenticates ledgerless epoch-2 recovery (evidence %s) and consumes the original claim with an epoch-4 replacement", async evidence => {
    const { run } = await checkpointed();
    const saved = storedState(rows(run.id).at(-1)!);
    saved.runner.runner_state_version = LEGACY_VERSION;
    saved.runner.counters = COUNTERS;
    if (evidence === "null") saved.runner.evidence = null;
    const legacy = runs.checkpoints.save({ runId: run.id, ownerId: "u", runnerVersion: LEGACY_VERSION,
      bundle: Buffer.from("legacy-bundle"), state: JSON.stringify(saved), tree: { baseSha: BASE, headSha: HEAD, checkpointSha: TREE } });
    const sealed = readFileSync(join(dir, "checkpoints", legacy.state_path));
    await restart();
    const load = vi.spyOn(runs.checkpoints, "load"), consume = vi.spyOn(runs.checkpoints, "consumeClaim");
    const capture = deferred();
    factory.mockImplementationOnce(async id => {
      const worker = new FakeWorkspace(id);
      worker.captureGate = capture.promise;
      workers.push(worker);
      return worker;
    });
    try {
      await runs.recover();
      await vi.waitFor(() => expect(workers.at(-1)!.imported).toEqual(saved.runner));
      const restored = workers.at(-1)!;
      await vi.waitFor(() => expect(restored.users()).toHaveLength(1));
      expect(restored.users()[0]).not.toContain(PROMPT);
      expect(restored.calls.find(call => call.method === "restore_checkpoint")?.args).toMatchObject({
        bundle: Buffer.from("legacy-bundle").toString("base64"), base_sha: BASE, head_sha: HEAD, checkpoint_sha: TREE,
      });
      expect(load.mock.calls.every(([key, seq]) => key.runnerVersion === LEGACY_VERSION && seq === legacy.seq)).toBe(true);
      expect(rows(run.id).find(row => row.seq === legacy.seq)).toMatchObject({ runner_version: LEGACY_VERSION,
        consumed_at: null, claimed_by: expect.any(String), invalid_reason: null });
      expect(readFileSync(join(dir, "checkpoints", legacy.state_path))).toEqual(sealed);
      capture.resolve();
      await vi.waitFor(() => expect(rows(run.id).at(-1)?.runner_version).toBe(VERSION));
      expect(consume).toHaveBeenCalledWith({ runId: run.id, ownerId: "u", runnerVersion: LEGACY_VERSION }, legacy.seq, expect.any(String));
      expect(rows(run.id).find(row => row.seq === legacy.seq)).toMatchObject({ runner_version: LEGACY_VERSION, consumed_at: expect.any(Number), invalid_reason: null });
      expect(readFileSync(join(dir, "checkpoints", legacy.state_path))).toEqual(sealed);
      expect(storedState(rows(run.id).at(-1)!).runner).toMatchObject({ runner_state_version: VERSION, counters: COUNTERS });
      expect(runs.history(run.id, 0).filter(event => event.type === "run.resumed")).toHaveLength(1);
      expect(runs.history(run.id, 0).some(event => event.type === "run.checkpoint_fallback")).toBe(false);
    } finally { capture.resolve(); }
  });

  it.each([
    { name: "epoch-2 ledger", envelope: LEGACY_VERSION, payload: LEGACY_VERSION, ledger: {} },
    { name: "epoch-1", envelope: "gond-agent-checkpoint-1", payload: "gond-agent-checkpoint-1" },
    { name: "future epoch", envelope: "gond-agent-checkpoint-5", payload: "gond-agent-checkpoint-5" },
    { name: "pre-repro epoch-3", envelope: "gond-agent-checkpoint-3", payload: "gond-agent-checkpoint-3" },
    { name: "epoch-2 envelope/epoch-4 payload", envelope: LEGACY_VERSION, payload: VERSION },
    { name: "epoch-4 envelope/epoch-2 payload", envelope: VERSION, payload: LEGACY_VERSION },
    { name: "row/envelope mismatch", envelope: VERSION, payload: VERSION, relabel: true },
  ])("rejects $name without importing or searching an older checkpoint", async fixture => {
    const { run } = await checkpointed();
    const older = rows(run.id).at(-1)!;
    const saved = storedState(older);
    saved.runner.runner_state_version = fixture.payload;
    if (fixture.ledger) saved.runner.evidence = fixture.ledger;
    const rejected = runs.checkpoints.save({ runId: run.id, ownerId: "u", runnerVersion: fixture.envelope,
      bundle: Buffer.from("rejected-bundle"), state: JSON.stringify(saved), tree: { baseSha: BASE, headSha: HEAD, checkpointSha: TREE } });
    if (fixture.relabel) db.prepare("UPDATE run_checkpoints SET runner_version=? WHERE seq=?").run(LEGACY_VERSION, rejected.seq);
    await restart();
    const load = vi.spyOn(runs.checkpoints, "load");
    await runs.recover();
    expect(runs.get(run.id).status).toBe("failed");
    expect(workers).toHaveLength(1);
    await runs.validateFollowUp(run.id, "u");
    runs.enqueue(run.id, "u", "Continue from the pushed branch.");
    await vi.waitFor(() => { expect(workers.length).toBeGreaterThan(1); expect(workers.at(-1)!.users()).toHaveLength(1); });
    expect(workers.at(-1)!.imported).toBeUndefined();
    expect(workers.slice(1).some(worker => worker.calls.some(call => call.method === "restore_checkpoint" || call.method === "import_state"))).toBe(false);
    expect(load.mock.calls.some(([, seq]) => seq === older.seq)).toBe(false);
    expect(rows(run.id).find(row => row.seq === rejected.seq)).toMatchObject({ consumed_at: expect.any(Number), invalid_reason: "restore_failed", claimed_by: null });
    expect(runs.history(run.id, 0).some(event => event.type === "run.checkpoint_fallback")).toBe(true);
    expect(runs.history(run.id, 0).some(event => event.type === "run.resumed")).toBe(false);
  });

  it("preserves nonzero counters, signed ledger and snapshot metadata through sealed storage and recovery", async () => {
    const { run, worker } = await checkpointed();
    // The fake transports opaque runner state; real HMAC acceptance, encryption,
    // SQLite and claim consumption remain in use. This does not replace real-runner import/HMAC tests.
    const record = signedRecord({ run_id: run.id, seq: 11 }, Buffer.from(worker.evidenceKey!, "hex"));
    runs.append(run.id, { type: "evidence.recorded", record });
    const current = runs.get(run.id);
    current.evidence = { ...current.evidence!, gate_rounds: 5, gate_budget: 6, resumes: 2 };
    runs.save(current);
    worker.stateFixture = { counters: COUNTERS, plan: COUNTERS.plan_last, evidence: {
      ...evidenceState(worker.evidenceKey).state.evidence, run_id: run.id, records: [record], seq: 11,
      gate_rounds: 5, resumes: 2, fix_rounds: 1, reviews: 1, stale_ids: [], historical_ids: [], declared: true, turn_tree: TREE,
    } };
    await worker.capture();
    const checkpoint = rows(run.id).at(-1)!;
    const saved = storedState(checkpoint);
    expect(saved.service).toEqual({ active_message_id: current.active_message!.id });
    expect(saved.runner).toMatchObject({ counters: COUNTERS, evidence: { seq: 11, gate_rounds: 5, records: [record] } });
    const ciphertext = readFileSync(join(dir, "checkpoints", checkpoint.state_path));
    expect(ciphertext.toString()).not.toContain(worker.evidenceKey!);
    await restart();
    await runs.recover();
    await vi.waitFor(() => expect(workers.at(-1)!.imported).toEqual(saved.runner));
    await vi.waitFor(() => expect(rows(run.id).at(-1)!.seq).toBeGreaterThan(checkpoint.seq));
    const restored = workers.at(-1)!;
    expect(restored.evidenceKey).not.toBe(worker.evidenceKey);
    expect(restored.calls.find(call => call.method === "start")?.args).toMatchObject({
      evidence_seq: 11, evidence_gate_rounds: 6, evidence_resumes: 3,
    });
    const replacement = rows(run.id).at(-1)!;
    const loaded = runs.checkpoints.load({ runId: run.id, ownerId: "u", runnerVersion: VERSION }, replacement.seq)!;
    expect(loaded.tree).toEqual({ baseSha: BASE, headSha: HEAD, checkpointSha: TREE });
    expect(storedState(replacement)).toMatchObject({ runner: { counters: COUNTERS, plan: COUNTERS.plan_last,
      evidence: { seq: 11, gate_rounds: 6, resumes: 3, records: [record], historical_ids: [record.id], key: restored.evidenceKey } },
      service: { active_message_id: runs.get(run.id).active_message!.id } });
    expect(readFileSync(join(dir, "checkpoints", checkpoint.state_path))).toEqual(ciphertext);
    expect(rows(run.id).find(row => row.seq === checkpoint.seq)?.consumed_at).toEqual(expect.any(Number));
    expect(runs.get(run.id).evidence).toMatchObject({ records: [record], last_seq: 11, gate_rounds: 6, gate_budget: 6, resumes: 3,
      recorded_before_restart: [record.id] });
  });

  it.each(["export throws", "malformed metadata"])("finishes and captures after %s without resetting budgets, flushing before export", async failure => {
    const { run, worker } = await checkpointed();
    const current = runs.get(run.id);
    current.evidence = { ...current.evidence!, gate_rounds: 5, gate_budget: 6, resumes: 3 };
    runs.save(current);
    const flush = deferred();
    const flushing = vi.spyOn(worker, "flushCheckpoints").mockImplementationOnce(() => flush.promise);
    const capture = vi.spyOn(worker, "captureCheckpoint");
    const rpc = worker.rpc.bind(worker);
    const exporting = vi.spyOn(worker, "rpc").mockImplementation(async (method, args) => {
      if (method === "export_state") {
        if (failure === "export throws") throw new Error("private export unavailable");
        return { state: { evidence: { ...evidenceState(worker.evidenceKey).state.evidence,
          policy: { enabled: "invalid" }, gate_rounds: 0, resumes: 0, historical_ids: [42] } } };
      }
      return rpc(method, args);
    });
    try {
      worker.events.push({ type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
      await vi.waitFor(() => expect(flushing).toHaveBeenCalledTimes(1));
      expect(exporting.mock.calls.some(([method]) => method === "export_state")).toBe(false);
      expect(importBundle).not.toHaveBeenCalled();
      flush.resolve();
      await vi.waitFor(() => expect(runs.get(run.id).status).toBe("ready"));
      expect(exporting.mock.calls.filter(([method]) => method === "export_state")).toHaveLength(1);
      expect(importBundle).toHaveBeenCalledTimes(1); // importBundle is the first publication/push path.
      expect(pushBranch).not.toHaveBeenCalled();
      expect(capture).toHaveBeenCalledWith({ head_sha: HEAD });
      expect(rows(run.id).at(-1)!.seq).toBeGreaterThan(rows(run.id)[0]!.seq);
      expect(runs.get(run.id)).toMatchObject({ pushed: true, head_sha: HEAD,
        evidence: { gate_rounds: 5, gate_budget: 6, resumes: 3 } });
      expect(runs.get(run.id).evidence?.policy).toBeUndefined();
      expect(runs.history(run.id, 0).some(event => event.type === "run.error")).toBe(false);
    } finally { flush.resolve(); }
  });

  it.each([false, true])("restores idle-released conversation for a follow-up (first reopen fails: %s)", async reopenFails => {
    cfg.maxRuns = 1;
    finishUsers = true;
    const { run, worker } = await checkpointed();
    await vi.waitFor(() => expect(runs.get(run.id).status).toBe("ready"));
    const record = signedRecord({ run_id: run.id, seq: 7 }, Buffer.from(worker.evidenceKey!, "hex"));
    runs.append(run.id, { type: "evidence.recorded", record });
    worker.stateFixture = { ...worker.stateFixture, evidence: {
      ...worker.exportEvidence().state.evidence, records: [record], seq: 7, gate_rounds: 4, resumes: 2,
    } };
    await worker.capture();
    const checkpoint = rows(run.id).at(-1)!;
    const history = storedState(checkpoint).runner.history;
    expect(history).toContainEqual(message("assistant", EARLIER));
    finishUsers = false;
    const waiting = await create();
    expect(runs.get(waiting.id).status).toBe("queued");
    const live = (runs as unknown as { live: Map<string, { idleSince?: number }> }).live.get(run.id)!;
    live.idleSince = Date.now() - 600_000;
    runs.drain();
    await vi.waitFor(() => expect(worker.destroy).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      expect(workers.find(worker => worker.id === waiting.id)!.users()).toHaveLength(1);
      expect((runs as unknown as { booting: Set<string> }).booting.has(waiting.id)).toBe(false);
    });
    expect(rows(run.id)).toContainEqual(expect.objectContaining({ seq: checkpoint.seq, consumed_at: null }));
    expect(runs.get(run.id)).toMatchObject({ status: "ready", resume_from_checkpoint: true });
    expect(runs.get(run.id).evidence).toMatchObject({ records: [record], last_seq: 7, gate_rounds: 4, resumes: 2 });
    expect(runs.history(run.id, 0)).toContainEqual(expect.objectContaining({ type: "run.released", reason: "idle_for_waiting_work" }));

    const followUp = "Handle the next parser edge case.";
    await runs.validateFollowUp(run.id, "u");
    runs.enqueue(run.id, "u", followUp);
    expect(runs.get(run.id).status).toBe("queued");
    await runs.stop(waiting.id, "u");
    await vi.waitFor(() => {
      expect(runs.get(waiting.id).status).toBe("stopped");
      expect((runs as unknown as { live: Map<string, { busy: boolean }> }).live.get(waiting.id)?.busy).toBe(false);
    });
    if (reopenFails) {
      vi.spyOn(console, "error").mockImplementation(() => {});
      factory.mockRejectedValueOnce(new Error("temporary workspace startup failure"));
    }
    await runs.closeSession(waiting.id, "u");
    if (reopenFails) {
      await vi.waitFor(() => expect(runs.get(run.id).status).toBe("interrupted"));
      expect(runs.get(run.id).pending.map(message => message.text)).toEqual([followUp]);
      await runs.resume(run.id, "u");
    }
    await vi.waitFor(() => expect(workers).toHaveLength(3));
    const reopened = workers.at(-1)!;
    await vi.waitFor(() => expect(reopened.users()).toHaveLength(1));
    expect(reopened.imported?.history).toEqual(history);
    expect(reopened.users()[0]).toContain(followUp);
    expect(reopened.users()[0]!.split("The run was restarted.")).toHaveLength(2);
    expect(reopened.users()[0]).not.toContain(PROMPT);
    expect(reopened.calls.findIndex(call => call.method === "restore_checkpoint"))
      .toBeLessThan(reopened.calls.findIndex(call => call.method === "import_state"));
    expect(runs.history(run.id, 0)).toContainEqual(expect.objectContaining({ type: "run.resumed" }));
    expect(runs.get(run.id).evidence).toMatchObject({ records: [record], last_seq: 7, gate_rounds: 4, gate_budget: 6,
      recorded_before_restart: [record.id] });
    expect(runs.get(run.id).evidence!.resumes).toBeGreaterThanOrEqual(3);
    expect(reopened.evidenceKey).not.toBe(worker.evidenceKey);
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
    finishUsers = true;
    const { run, worker } = await checkpointed();
    await vi.waitFor(() => expect(runs.get(run.id).status).toBe("ready"));
    await runs.close(run.id, false, true);
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
    finishUsers = true;
    account("other");
    const active = await checkpointed();
    await vi.waitFor(() => expect(runs.get(active.run.id).status).toBe("ready"), { timeout: 5000 });
    await runs.close(active.run.id, false, true);
    const deleted = await checkpointed();
    await vi.waitFor(() => expect(runs.get(deleted.run.id).status).toBe("ready"), { timeout: 5000 });
    await runs.close(deleted.run.id, false, true);
    const other = await checkpointed("web", "other");
    await vi.waitFor(() => expect(runs.get(other.run.id).status).toBe("ready"), { timeout: 5000 });
    await runs.close(other.run.id, false, true);
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
