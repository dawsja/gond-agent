import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthentication, seal } from "../src/auth";
import type { Config } from "../src/config";
import type { Workspace, WorkspaceFactory } from "../src/containers";
import { openStore } from "../src/db";
import { checkout, gh, git, importBundle } from "../src/github";
import { emptySummary } from "../src/runs/fold";
import { saveProviderSettings } from "../src/providers";
import { Runs, type Run } from "../src/runs/service";
import type { CiDeps, CiTransport, CiWatch } from "../src/runs/ci-watch";

vi.mock("../src/github", async original => ({
  ...await original<typeof import("../src/github")>(),
  gh: vi.fn(async () => { throw new Error("Unexpected GitHub mutation/request"); }),
  checkout: vi.fn(async () => { throw new Error("Unexpected repository checkout"); }),
  commitIdentity: vi.fn(async () => ({ name: "Fixture", email: "fixture@example.test" })),
  importBundle: vi.fn(),
  git: vi.fn(),
}));

const SHA = "a".repeat(40), NEXT = "b".repeat(40), BASE = "c".repeat(40);
const pushed = vi.fn();
let dir: string, db: ReturnType<typeof openStore>, runs: Runs, cfg: Config;
const factory = vi.fn<WorkspaceFactory>(async () => { throw new Error("Tests must not boot a workspace"); });

// Access lifecycle hooks; boot/pump and watcher timers are isolated per test.
const service = () => runs as any;
const watcher = () => service().ci as CiWatch;
const ciDeps = () => service().ci.deps as CiDeps;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

function seed(patch: Partial<Run> = {}) {
  const run: Run = {
    id: "run", user_id: "u", repo: "acme/app", base_branch: "main",
    branch: "gond-agent/fix", model_id: "local:coder", backend: "builtin",
    title: "Fix the app", prompt: "Fix the app", status: "ready", step: null,
    created_at: 1, updated_at: 1, started_at: 1, finished_at: null,
    pr_number: 7, pr_url: "https://github.com/acme/app/pull/7", pr_state: "open",
    head_sha: SHA, error: null, files: 0, additions: 0, deletions: 0,
    plan_done: 0, plan_total: 0, source: "web", phase: "idle", pushed: true,
    diff: "", summary: emptySummary(), pending: [], base_sha: BASE,
    auto_pr: false, ci_round: 0, ...patch,
  };
  db.prepare("INSERT INTO runs(id,user_id,repo,status,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?)")
    .run(run.id, run.user_id, run.repo, run.status, run.created_at, run.updated_at, JSON.stringify(run));
  return run;
}

function workspace() {
  const rpc = vi.fn(async (method: string) => {
    if (method !== "snapshot") throw new Error(`Unexpected worker call: ${method}`);
    return { bundle: Buffer.from("bundle").toString("base64"), head: NEXT };
  });
  const destroy = vi.fn(async () => {});
  const live = { workspace: { rpc, destroy }, cwd: "/fake", cursor: 0, busy: true, closed: false };
  service().live.set("run", live);
  return { live, rpc, destroy };
}

beforeEach(async () => {
  vi.stubEnv("GOND_AGENT_CI_FIX_ROUNDS", "2");
  vi.stubEnv("GOND_AGENT_CI_WAIT_MINUTES", "20");
  dir = mkdtempSync(join(tmpdir(), "gond-agent-ci-service-"));
  cfg = {
    data: dir, origin: "http://localhost:8787", secret: "a".repeat(40), signup: true,
    port: 8787, dockerBin: "docker", workerImage: "gond-agent-worker:test",
    maxRuns: 1, runCPUs: 2, runMemoryMB: 2048,
  };
  db = openStore(dir);
  await createAuthentication(db, cfg);
  db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
    .run("u", "User", "user@example.test", 0, Date.now(), Date.now());
  db.prepare("INSERT INTO github_connections(user_id,token,connected_at) VALUES(?,?,?)")
    .run("u", seal(cfg.secret, "test-owner-github-token"), Date.now());
  saveProviderSettings(db, cfg.secret, { connections: [{ id: "local", name: "Local", format: "openai",
    baseURL: "http://127.0.0.1:9/v1", apiKey: "fixture-provider-key", discover: false,
    models: [{ id: "coder", name: "Coder", contextWindow: 128000, maxOutput: 8192, reasoning: "none", images: true }] }], defaultModel: "local:coder" });
  runs = new Runs(db, cfg, factory);
  vi.mocked(importBundle).mockImplementation(async (cwd, _bundle, branch, _env, _retry, options) => {
    // Match importBundle's real ordering: validation must complete before push.
    await options?.beforePush?.({ cwd, branch, head: NEXT });
    pushed();
  });
  vi.mocked(git).mockImplementation(async (_cwd, ...args) => {
    if (args[0] !== "diff") throw new Error(`Unexpected git command: ${args.join(" ")}`);
    return Buffer.from(args.includes("--name-only") ? "src/app.ts\0"
      : args.includes("--numstat") ? "2\t1\tsrc/app.ts\n"
      : "diff --git a/src/app.ts b/src/app.ts\n");
  });
});

afterEach(async () => {
  await runs.shutdown();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("run service automatic CI hooks", () => {
  it("explicit zero disables CI: a pushed turn keeps its workspace and does not watch CI", async () => {
    vi.stubEnv("GOND_AGENT_CI_FIX_ROUNDS", "0");
    seed();
    const { live, destroy } = workspace();
    const start = vi.spyOn(watcher(), "start");
    const request = vi.fn();
    service().ci.io.request = request;
    await service().finish("run", live);
    expect(pushed).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(service().live.get("run")).toBe(live);
    expect(live.busy).toBe(false);
    expect(runs.get("run")).toMatchObject({ status: "ready", phase: "agent", head_sha: NEXT, ci_round: 0, pending: [] });
    expect(runs.get("run").ci_state).toBeUndefined();
    watcher().start("run", NEXT); // The watcher itself also honors explicit zero.
    await watcher().settled("run");
    expect(request).not.toHaveBeenCalled();
  });

  it("defaults to two CI rounds and releases the pushed workspace before watching", async () => {
    vi.stubEnv("GOND_AGENT_CI_FIX_ROUNDS", undefined);
    seed({ ci_round: 1 }); // The default still permits watching after the first round.
    const { live, destroy } = workspace();
    const request = vi.fn(async (endpoint: string): Promise<unknown> => {
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(service().live.has("run")).toBe(false);
      if (endpoint.endsWith("/pulls/7")) return { state: "open", head: { sha: NEXT } };
      if (endpoint.includes("/check-runs?")) return { total_count: 0, check_runs: [] };
      if (endpoint.includes("/status?")) return {
        sha: NEXT, total_count: 1, statuses: [{ context: "tests", state: "success" }],
      };
      throw new Error(`Unexpected watcher request: ${endpoint}`);
    });
    service().ci.io = {
      request, now: () => 0, sleep: async () => {},
      log: async () => { throw new Error("No logs expected for passing CI"); },
    };
    const start = vi.spyOn(watcher(), "start");
    await service().finish("run", live);
    await watcher().settled("run");
    expect(pushed).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledExactlyOnceWith("run", NEXT);
    expect(request).toHaveBeenCalled();
    expect(runs.get("run")).toMatchObject({
      status: "ready", phase: "idle", head_sha: NEXT, ci_round: 1, ci_state: "passing", ci_active: false,
    });
    expect(factory).not.toHaveBeenCalled();
    expect(gh).not.toHaveBeenCalled();
  });

  it("clears stale ci_active on every run at startup without resuming watches or losing CI history", async () => {
    for (const status of ["ready", "queued", "working", "stopped", "failed", "merged"] as const) {
      seed({ id: status, status, ci_active: true, ci_state: "pending", ci_round: 1, ci_sha: SHA });
    }
    const start = vi.spyOn(watcher(), "start");
    await runs.recover();
    for (const status of ["ready", "queued", "working", "stopped", "failed", "merged"] as const) {
      expect(runs.get(status)).toMatchObject({ ci_active: false, ci_state: "pending", ci_round: 1, ci_sha: SHA });
    }
    expect(runs.get("ready").status).toBe("ready");
    expect(runs.get("queued")).toMatchObject({ status: "queued", phase: "idle", pending: [] });
    expect(runs.get("working")).toMatchObject({ status: "failed", phase: "idle", pending: [] });
    await runs.recover(); // Idempotent, including persisted JSON boolean values.
    const rows = db.prepare("SELECT data FROM runs").all() as { data: string }[];
    expect(rows.every(row => JSON.parse(row.data).ci_active === false)).toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("queues one durable CI round without a worker when capacity is full, then starts it once", async () => {
    seed();
    const prBody = "Keep this user-authored PR description";
    db.prepare("UPDATE runs SET pr_body=? WHERE id=?").run(prBody, "run");
    const boot = vi.spyOn(service(), "boot").mockResolvedValue(undefined);
    service().booting.add("other-run");
    expect(await ciDeps().followUp("run", "Fix CI", SHA)).toBe(true);
    expect(runs.get("run")).toMatchObject({ status: "queued", ci_round: 1, pr_body: prBody, pending: [{ text: "Fix CI", source: "ci" }] });
    expect(service().queue.has("run")).toBe(true);
    expect(await ciDeps().followUp("run", "Duplicate fix", SHA)).toBe(false);
    expect(boot).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(runs.history("run", 0).filter(event => event.type === "ci")).toHaveLength(1);
    service().booting.delete("other-run");
    runs.drain();
    expect(boot).toHaveBeenCalledExactlyOnceWith("run");
    expect(service().queue.has("run")).toBe(false);
  });

  it("rolls back both the round and message when the persistent queue is full", async () => {
    seed();
    service().booting.add("other-run");
    cfg.queueMax = 0;
    await expect(ciDeps().followUp("run", "Fix CI", SHA)).rejects.toMatchObject({ code: "queue_full" });
    expect(runs.get("run")).toMatchObject({ status: "ready", ci_round: 0, pending: [] });
    expect(service().queue.has("run")).toBe(false);
    expect(runs.history("run", 0)).toEqual([]);
  });

  it("boots accepted automatic CI follow-ups non-interactively even when the run originated in the browser", async () => {
    cfg.maxRuns = 2;
    seed({ id: "browser", source: "web" });
    seed({ source: "web" });
    const browserRpc = vi.fn<Workspace["rpc"]>().mockResolvedValue(undefined);
    const ciRpc = vi.fn<Workspace["rpc"]>().mockResolvedValue(undefined);
    const checked = { cwd: "/fake", archive: Buffer.from("checkout") };
    vi.mocked(checkout).mockResolvedValueOnce(checked).mockResolvedValueOnce(checked);
    factory.mockResolvedValueOnce({ rpc: browserRpc as Workspace["rpc"], destroy: vi.fn(async () => {}) })
      .mockResolvedValueOnce({ rpc: ciRpc as Workspace["rpc"], destroy: vi.fn(async () => {}) });
    // Keep real enqueue, boot and message delivery, but never poll worker events.
    vi.spyOn(service(), "pump").mockResolvedValue(undefined);

    runs.enqueue("browser", "u", "Continue from the browser");
    await service().launches.get("browser");
    expect(browserRpc).toHaveBeenCalledWith("start", expect.objectContaining({ interactive: true }));

    expect(await ciDeps().followUp("run", "Fix CI", SHA)).toBe(true);
    await service().launches.get("run");
    expect(ciRpc.mock.calls.filter(([method]) => method === "start")).toEqual([
      ["start", expect.objectContaining({ interactive: false })],
    ]);
    expect(ciRpc).toHaveBeenCalledWith("send", {
      input: expect.objectContaining({ type: "user", text: "Fix CI" }),
    });
    expect(runs.get("run")).toMatchObject({
      source: "web", status: "working", phase: "agent", ci_round: 1, ci_turn: true, pending: [],
    });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(gh).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
  });

  it.each(["stop", "user follow-up"])("does not restore a stale ci_active snapshot after %s", async action => {
    seed();
    vi.spyOn(service(), "boot").mockResolvedValue(undefined);
    const request = vi.fn();
    service().ci.io = {
      request, now: () => 0,
      sleep: async (_ms: number, signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })),
    };
    watcher().start("run", SHA);
    expect(runs.get("run").ci_active).toBe(true);
    if (action === "stop") await runs.stop("run", "u");
    else runs.enqueue("run", "u", "Take a different approach");
    await watcher().settled("run");
    expect(runs.get("run").ci_active).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("destroys the workspace and releases maxRuns=1 capacity before watching and enqueuing CI, not a user message", async () => {
    seed();
    const { live, destroy } = workspace();
    const destroying = deferred(), release = deferred();
    let destroyed = false;
    destroy.mockImplementation(async () => {
      destroying.resolve();
      await release.promise;
      destroyed = true;
    });
    expect(() => service().checkCapacity()).toThrow(/busy/i);
    // Keep the real enqueue/event/transaction path, but never boot a worker.
    const boot = vi.spyOn(service(), "boot").mockResolvedValue(undefined);
    const merge = vi.spyOn(runs, "merge");
    let time = 0;
    const request = vi.fn(async (endpoint: string, env: NodeJS.ProcessEnv): Promise<unknown> => {
      expect(destroyed).toBe(true);
      expect(service().live.size).toBe(0);
      expect(() => service().checkCapacity()).not.toThrow();
      expect(env.GH_TOKEN).toBe("test-owner-github-token");
      if (endpoint.endsWith("/pulls/7")) return { state: "open", head: { sha: NEXT } };
      if (endpoint.includes("/check-runs?")) return { total_count: 0, check_runs: [] };
      if (endpoint.includes("/status?")) return {
        sha: NEXT, total_count: 1, statuses: [{ context: "tests", state: "failure", description: "Assertion failed" }],
      };
      throw new Error(`Unexpected watcher request: ${endpoint}`);
    });
    const io: CiTransport = {
      request: <T>(endpoint: string, env: NodeJS.ProcessEnv) => request(endpoint, env) as Promise<T>,
      log: async () => { throw new Error("No job logs expected for a legacy status"); },
      now: () => time,
      sleep: async ms => { time += ms; },
    };
    service().ci.io = io;
    const startImpl = watcher().start.bind(watcher());
    const start = vi.spyOn(watcher(), "start").mockImplementation((id, sha) => {
      expect(destroyed).toBe(true);
      expect(service().live.size).toBe(0);
      expect(() => service().checkCapacity()).not.toThrow();
      startImpl(id, sha);
    });
    const finishing = service().finish("run", live) as Promise<void>;
    try {
      await destroying.promise;
      expect(start).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally { release.resolve(); }
    await finishing;
    await watcher().settled("run");

    expect(start).toHaveBeenCalledExactlyOnceWith("run", NEXT);
    expect(pushed).toHaveBeenCalledTimes(1);
    expect(git).toHaveBeenCalledWith("/fake", "diff", "--no-ext-diff", BASE, "HEAD", "--");
    expect(runs.get("run")).toMatchObject({
      head_sha: NEXT, files: 1, additions: 2, deletions: 1, ci_round: 1, ci_previous_sha: NEXT,
      pending: [{ source: "ci", images: [], text: expect.stringContaining("CI failed on bbbbbbb") }],
    });
    const history = runs.history("run", 0);
    expect(history.filter(event => event.type === "ci")).toEqual([
      expect.objectContaining({ type: "ci", source: "ci", images: [], text: expect.stringContaining("Assertion failed") }),
    ]);
    expect(history.some(event => event.type === "user")).toBe(false);
    expect(boot).toHaveBeenCalledExactlyOnceWith("run");
    expect(factory).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
    expect(gh).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([endpoint]) => /\/merge|\/reviews/.test(endpoint))).toBe(false);
  });

  it("refuses automatic follow-ups and enqueue with a pending question, even when busy, without replying", async () => {
    const question = { request_id: "q1", question: "Which branch?" };
    seed({ summary: { ...emptySummary(), question } });
    // A question also blocks the watcher callback when no live workspace exists.
    expect(await ciDeps().followUp("run", "Fix CI", SHA)).toBe(false);
    const { live, rpc } = workspace();
    for (const busy of [false, true]) {
      live.busy = busy;
      expect(await ciDeps().followUp("run", "Fix CI", SHA)).toBe(false);
      expect(() => runs.enqueue("run", "u", "Fix CI", [], undefined, undefined, undefined, undefined, "ci"))
        .toThrow(/idle run with no pending question/);
      expect(runs.get("run")).toMatchObject({ ci_round: 0, pending: [], summary: { question } });
    }
    expect(rpc).not.toHaveBeenCalled(); // In particular, never sends question.reply.
    expect(runs.history("run", 0)).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
  });

  it("defers watching a new push until queued work drains, even if the final turn changes no files", async () => {
    seed({ pending: [{ text: "Also check the result", images: [] }] });
    const { live } = workspace();
    const start = vi.spyOn(watcher(), "start").mockImplementation(() => {});
    await service().finish("run", live);
    expect(start).not.toHaveBeenCalled();
    const current = runs.get("run");
    current.pending = []; runs.save(current);
    await service().finish("run", live); // snapshot still returns NEXT.
    expect(start).toHaveBeenCalledExactlyOnceWith("run", NEXT);
  });

  it("does not start watching when an explicit close races with post-push workspace release", async () => {
    seed();
    const { live, destroy } = workspace();
    const destroying = deferred(), release = deferred();
    destroy.mockImplementation(async () => { destroying.resolve(); await release.promise; });
    const request = vi.fn();
    service().ci.io.request = request;
    const finishing = service().finish("run", live);
    await destroying.promise;
    try { await runs.closeSession("run", "u"); }
    finally { release.resolve(); }
    await finishing;
    await watcher().settled("run");
    expect(request).not.toHaveBeenCalled();
    expect(runs.get("run").ci_cancelled_sha).toBe(NEXT);
    expect(runs.get("run").ci_state).toBeUndefined();
  });

  it("does not publish or restart a stopped run when a normal turn-end arrives late", async () => {
    seed({ status: "stopped" });
    const { live } = workspace();
    const start = vi.spyOn(watcher(), "start");
    await service().finish("run", live);
    expect(importBundle).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(runs.get("run").status).toBe("stopped");
    expect(live.busy).toBe(false);
  });

  it("preserves the round against stale saves, new Runs instances and repeated openStore migration", async () => {
    seed();
    seed({ id: "legacy", ci_round: undefined });
    const stale = runs.get("run");
    vi.spyOn(service(), "boot").mockResolvedValue(undefined);
    expect(await ciDeps().followUp("run", "Fix CI", SHA)).toBe(true);
    expect(runs.get("run").ci_round).toBe(1);
    runs.save(stale);
    expect(runs.get("run").ci_round).toBe(1);

    for (let reopen = 0; reopen < 2; reopen++) {
      await runs.shutdown();
      db.close();
      db = openStore(dir);
      runs = new Runs(db, cfg, factory);
      expect(runs.get("run").ci_round).toBe(1);
      expect(runs.get("legacy").ci_round).toBe(0);
    }
    // Simulate the first round having completed; isolate the persisted handoff limit.
    const completed = runs.get("run");
    completed.status = "ready"; completed.pending = []; runs.save(completed);
    service().queue.leave("run");
    const enqueue = vi.spyOn(runs, "enqueue").mockImplementation(() => {});
    expect(await ciDeps().followUp("run", "Second fix", SHA)).toBe(true);
    expect(runs.get("run").ci_round).toBe(2);
    expect(await ciDeps().followUp("run", "Third fix", SHA)).toBe(false);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith("run", "u", "Second fix", [], undefined, undefined, undefined, undefined, "ci");
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects an automatic .github diff before push, gives up needing a person and leaves the published head unchanged", async () => {
    seed({ ci_turn: true, ci_round: 1, ci_previous_sha: SHA, ci_failing: ["tests"] });
    const { live, destroy } = workspace();
    vi.mocked(git).mockResolvedValueOnce(Buffer.from("src/app.ts\0.github/workflows/test.yml\0"));
    const start = vi.spyOn(watcher(), "start");
    const merge = vi.spyOn(runs, "merge");
    await service().finish("run", live);

    expect(importBundle).toHaveBeenCalledExactlyOnceWith(
      "/fake", Buffer.from("bundle"), "gond-agent/fix", expect.objectContaining({ GH_TOKEN: "test-owner-github-token" }), undefined,
      expect.objectContaining({ beforePush: expect.any(Function) }),
    );
    expect(git).toHaveBeenCalledExactlyOnceWith(
      "/fake", "diff", "--no-ext-diff", "--name-only", "--no-renames", "-z", SHA, NEXT, "--",
    );
    expect(pushed).not.toHaveBeenCalled();
    expect(runs.get("run")).toMatchObject({
      status: "ready", head_sha: SHA, ci_round: 1, ci_state: "gave_up", ci_active: false,
      ci_reason: expect.stringContaining("needs a person"),
    });
    expect(runs.history("run", 0).filter(event => event.type === "run.ci")).toEqual([
      expect.objectContaining({ state: "gave_up", round: 1, sha: SHA, failing: ["tests"], reason: expect.stringContaining("needs a person") }),
    ]);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
    expect(gh).not.toHaveBeenCalled();
  });

  it("also rejects a CI change reverted in a later commit of the automatic round", async () => {
    seed({ ci_turn: true, ci_round: 1, ci_previous_sha: SHA });
    const { live } = workspace();
    vi.mocked(git).mockImplementation(async (_cwd, ...args) => {
      if (args[0] === "diff") return Buffer.from("src/app.ts\0");
      if (args[0] === "merge-base") return Buffer.alloc(0);
      if (args[0] === "log") return Buffer.from(".github/workflows/test.yml\0");
      throw new Error("Unexpected git command");
    });
    await service().finish("run", live);
    expect(pushed).not.toHaveBeenCalled();
    expect(runs.get("run")).toMatchObject({ ci_state: "gave_up", ci_reason: expect.stringContaining("needs a person") });
  });
});
