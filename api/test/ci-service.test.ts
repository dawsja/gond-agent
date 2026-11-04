import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthentication, seal } from "../src/auth";
import type { Config } from "../src/config";
import { openStore } from "../src/db";
import { gh, git, importBundle } from "../src/github";
import { emptySummary } from "../src/runs/fold";
import { Runs, type Run } from "../src/runs/service";
import type { CiDeps, CiTransport, CiWatch } from "../src/runs/ci-watch";

vi.mock("../src/github", async original => ({
  ...await original<typeof import("../src/github")>(),
  gh: vi.fn(async () => { throw new Error("Unexpected GitHub mutation/request"); }),
  commitIdentity: vi.fn(async () => ({ name: "Fixture", email: "fixture@example.test" })),
  importBundle: vi.fn(),
  git: vi.fn(),
}));

const SHA = "a".repeat(40), NEXT = "b".repeat(40), BASE = "c".repeat(40);
const pushed = vi.fn();
let dir: string, db: ReturnType<typeof openStore>, runs: Runs, cfg: Config;
const factory = vi.fn(async () => { throw new Error("Tests must not boot a workspace"); });

// Exercise lifecycle hooks without starting boot/pump or real watcher timers.
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
  runs = new Runs(db, cfg, factory);
  vi.mocked(importBundle).mockImplementation(async (cwd, _bundle, branch, _env, _retry, options) => {
    // Match importBundle's real ordering: validation must complete before push.
    await options?.beforeAttempt?.({ cwd, branch, head: NEXT });
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
  it("defaults OFF: a pushed turn keeps its workspace and does not watch CI", async () => {
    vi.stubEnv("GOND_AGENT_CI_FIX_ROUNDS", undefined);
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
    watcher().start("run", NEXT); // The watcher itself also honors the default.
    await watcher().settled("run");
    expect(request).not.toHaveBeenCalled();
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
    for (const status of ["queued", "working"]) expect(runs.get(status)).toMatchObject({ status: "failed", phase: "idle", pending: [] });
    await runs.recover(); // Idempotent, including persisted JSON boolean values.
    const rows = db.prepare("SELECT data FROM runs").all() as { data: string }[];
    expect(rows.every(row => JSON.parse(row.data).ci_active === false)).toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("rolls back the CI round and queue on capacity failure, then enqueues exactly once after capacity frees", async () => {
    seed();
    service().booting.add("other-run");
    await expect(ciDeps().followUp("run", "Fix CI", SHA)).rejects.toMatchObject({ code: "run_limit" });
    expect(runs.get("run")).toMatchObject({ ci_round: 0, pending: [] });
    expect(runs.history("run", 0)).toEqual([]);
    service().booting.delete("other-run");
    vi.spyOn(service(), "boot").mockResolvedValue(undefined);
    expect(await ciDeps().followUp("run", "Fix CI", SHA)).toBe(true);
    expect(runs.get("run")).toMatchObject({ ci_round: 1, pending: [{ text: "Fix CI", source: "ci" }] });
    expect(runs.history("run", 0).filter(event => event.type === "ci")).toHaveLength(1);
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
      expect(() => runs.enqueue("run", "u", "Fix CI", [], undefined, undefined, "ci"))
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
    await runs.closeSession("run", "u");
    release.resolve(); await finishing;
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
    // Isolate the persisted handoff limit; enqueue behavior is covered above.
    const enqueue = vi.spyOn(runs, "enqueue").mockImplementation(() => {});
    expect(await ciDeps().followUp("run", "Second fix", SHA)).toBe(true);
    expect(runs.get("run").ci_round).toBe(2);
    expect(await ciDeps().followUp("run", "Third fix", SHA)).toBe(false);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith("run", "u", "Second fix", [], undefined, undefined, "ci");
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
      expect.objectContaining({ beforeAttempt: expect.any(Function) }),
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
