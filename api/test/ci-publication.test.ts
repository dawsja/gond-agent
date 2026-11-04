import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthentication, seal } from "../src/auth";
import { command } from "../src/command";
import type { Config } from "../src/config";
import { openStore } from "../src/db";
import { checkout, gh } from "../src/github";
import { emptySummary } from "../src/runs/fold";
import { Runs, type Run } from "../src/runs/service";

// Only transport failures and external GitHub reads are faked. In particular,
// importBundle, pushBranch, the CI guard and withRetry all execute their real code.
vi.mock("../src/command", async original => {
  const actual = await original<typeof import("../src/command")>();
  return { ...actual, command: vi.fn(actual.command) };
});
vi.mock("../src/retry", async original => {
  const actual = await original<typeof import("../src/retry")>();
  const withRetry: typeof actual.withRetry = (step, fn, options) =>
    actual.withRetry(step, fn, { ...options, sleep: async () => {}, random: () => 0 });
  return { ...actual, withRetry };
});
vi.mock("../src/github", async original => ({
  ...await original<typeof import("../src/github")>(),
  gh: vi.fn(),
  commitIdentity: vi.fn(async () => ({ name: "Fixture", email: "fixture@example.test" })),
  checkout: vi.fn(async () => { throw new Error("Tests must not clone from GitHub"); }),
}));

const branch = "feat/explicit-ci-fix", ref = `refs/heads/${branch}`;
const token = "owner-only-fixture-token";
type Event = { kind: "guard" | "push" | "ls-remote"; args: string[] };
let dir: string, db: ReturnType<typeof openStore>, runs: Runs;
const service = () => runs as any;
const factory = vi.fn(async () => { throw new Error("Tests must not boot a worker"); });

beforeEach(async () => {
  vi.stubEnv("GOND_AGENT_CI_FIX_ROUNDS", "2");
  dir = await mkdtemp(join(tmpdir(), "gond-agent-ci-publication-"));
  const cfg: Config = {
    data: dir, origin: "http://localhost:8787", secret: "a".repeat(40), signup: true,
    port: 8787, dockerBin: "docker", workerImage: "gond-agent-worker:test",
    maxRuns: 1, runCPUs: 2, runMemoryMB: 2048,
  };
  db = openStore(dir);
  await createAuthentication(db, cfg);
  db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
    .run("u", "User", "user@example.test", 0, Date.now(), Date.now());
  db.prepare("INSERT INTO github_connections(user_id,token,connected_at) VALUES(?,?,?)")
    .run("u", seal(cfg.secret, token), Date.now());
  runs = new Runs(db, cfg, factory);
  vi.mocked(gh).mockImplementation(async (endpoint, method, body, env) => {
    expect(endpoint).toBe("repos/acme/app/pulls/7");
    expect(method).toBe("GET");
    expect(body).toBeUndefined();
    expect(env?.GH_TOKEN).toBe(token);
    return { state: "open", merged: false } as never;
  });
});

afterEach(async () => {
  await runs.shutdown();
  db.close();
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(options: {
  failPushes?: number; loseResponse?: boolean; configOnRetry?: boolean; removeBaselineOnFailure?: boolean;
} = {}) {
  const actual = await vi.importActual<typeof import("../src/command")>("../src/command");
  const remote = join(dir, "remote.git"), cwd = join(dir, "checkouts", "run"), worker = join(dir, "worker");
  await Promise.all([remote, cwd, worker].map(path => mkdir(path, { recursive: true })));
  const git = async (folder: string, ...args: string[]) =>
    (await actual.command("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: folder })).toString().trim();
  await git(remote, "init", "--bare", "-b", "main");
  await git(worker, "init", "-b", "main");
  await git(worker, "config", "user.name", "Fixture");
  await git(worker, "config", "user.email", "fixture@example.test");
  await writeFile(join(worker, "work.txt"), "base\n");
  await git(worker, "add", "."); await git(worker, "commit", "-m", "base");
  const base = await git(worker, "rev-parse", "HEAD");
  await git(worker, "remote", "add", "origin", remote);
  await git(worker, "push", "origin", "main");
  await git(cwd, "clone", "--no-tags", remote, ".");
  await git(worker, "checkout", "-b", branch);
  await writeFile(join(worker, "work.txt"), "fixed\n");
  await git(worker, "commit", "-am", "automatic fix");
  const head = await git(worker, "rev-parse", "HEAD");
  const bundlePath = join(worker, ".git", "fixture.bundle");
  await git(worker, "bundle", "create", bundlePath, "HEAD");
  const bundle = await readFile(bundlePath);
  const run: Run = {
    id: "run", user_id: "u", repo: "acme/app", base_branch: "main", branch,
    branch_explicit: true, model_id: "local:coder", backend: "builtin",
    title: "Fix CI", prompt: "Fix CI", status: "ready", step: null,
    created_at: 1, updated_at: 1, started_at: 1, finished_at: null,
    pr_number: 7, pr_url: "https://github.com/acme/app/pull/7", pr_state: "open",
    head_sha: base, base_sha: base, error: null, files: 0, additions: 0, deletions: 0,
    plan_done: 0, plan_total: 0, source: "web", phase: "idle", pushed: false,
    diff: "", summary: emptySummary(), pending: [], auto_pr: false,
    ci_turn: true, ci_round: 1, ci_previous_sha: base, ci_failing: ["tests"],
  };
  db.prepare("INSERT INTO runs(id,user_id,repo,status,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?)")
    .run(run.id, run.user_id, run.repo, run.status, run.created_at, run.updated_at, JSON.stringify(run));
  const rpc = vi.fn(async (method: string) => {
    if (method !== "snapshot") throw new Error(`Unexpected worker call: ${method}`);
    return { bundle: bundle.toString("base64"), head };
  });
  const destroy = vi.fn(async () => {});
  const live = { workspace: { rpc, destroy }, cwd, cursor: 0, busy: true, closed: false };
  service().live.set("run", live);
  const start = vi.spyOn(service().ci, "start").mockImplementation(() => {});
  const events: Event[] = [];
  let pushes = 0, guards = 0;
  vi.mocked(command).mockImplementation(async (file, args, commandOptions) => {
    if (file === "git") {
      if (args.includes("diff") && args.includes("--name-only") && args.includes("--no-renames")) {
        events.push({ kind: "guard", args: [...args] });
        if (++guards > 1 && options.configOnRetry) return Buffer.from(".github/workflows/test.yml\0");
      }
      if (args.includes("ls-remote")) {
        events.push({ kind: "ls-remote", args: [...args] });
        expect(commandOptions?.env?.GH_TOKEN).toBe(token);
      }
      if (args.includes("push")) {
        events.push({ kind: "push", args: [...args] });
        expect(commandOptions?.env?.GH_TOKEN).toBe(token);
        pushes++;
        if (pushes <= (options.failPushes ?? 0)) {
          if (options.removeBaselineOnFailure) {
            const current = runs.get("run");
            delete current.ci_previous_sha;
            runs.save(current);
          }
          throw new Error("connection reset by peer");
        }
        // Git can report an already-equal ref as up to date without checking
        // the lease. Inject the server's stale-info response to exercise the
        // stricter reconciliation path after the real first push succeeded.
        if (pushes === 2 && options.loseResponse) throw new Error("! [rejected] HEAD -> explicit-ci-fix (stale info)");
        const result = await actual.command(file, args, commandOptions);
        if (pushes === 1 && options.loseResponse) throw new Error("connection reset by peer");
        return result;
      }
    }
    return actual.command(file, args, commandOptions);
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const remoteHead = () => git(remote, "for-each-ref", "--format=%(objectname)", ref);
  const expectLeasedPushes = () => {
    const writes = events.filter(event => event.kind === "push");
    expect(writes.length).toBeGreaterThan(0);
    for (const { args } of writes) {
      expect(args).toContain(`--force-with-lease=${ref}:`);
      expect(args.at(-1)).toBe(`${head}:${ref}`);
    }
    for (const { args } of events.filter(event => event.kind === "guard")) {
      expect(args.slice(-3)).toEqual([base, head, "--"]);
    }
  };
  const expectGaveUp = () => {
    expect(runs.get("run")).toMatchObject({
      pushed: false, ci_round: 1, ci_state: "gave_up", ci_active: false,
      ci_reason: expect.stringContaining("needs a person"),
    });
    expect(runs.history("run", 0).filter(event => event.type === "run.ci")).toEqual([
      expect.objectContaining({ state: "gave_up", round: 1, failing: ["tests"], reason: expect.stringContaining("needs a person") }),
    ]);
    expect(start).not.toHaveBeenCalled();
    expect(checkout).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  };
  return { cwd, base, head, bundlePath, git, live, rpc, destroy, start, events, remoteHead, expectLeasedPushes, expectGaveUp };
}

describe("automatic CI publication with explicit-branch leases", () => {
  it("rechecks the pinned diff after a transient first import push failure and refuses CI changes before a second push", async () => {
    const f = await fixture({ failPushes: 1, configOnRetry: true });
    await service().finish("run", f.live);
    expect(f.events.map(event => event.kind)).toEqual(["guard", "push", "guard"]);
    f.expectLeasedPushes();
    f.expectGaveUp();
    expect(runs.get("run").head_sha).toBe(f.base);
    expect(await f.remoteHead()).toBe("");
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(f.destroy).toHaveBeenCalledTimes(1);
    await expect(readFile(join(f.cwd, ".git", "gond-agent.bundle"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("rechecks CI on every attempt and reconciles a lost successful create-only push response against the actual remote SHA", async () => {
    const f = await fixture({ loseResponse: true });
    await service().finish("run", f.live);
    expect(f.events.map(event => event.kind)).toEqual(["guard", "push", "guard", "push", "ls-remote"]);
    f.expectLeasedPushes();
    expect(await f.remoteHead()).toBe(f.head);
    expect(runs.get("run")).toMatchObject({ pushed: true, head_sha: f.head, ci_round: 1 });
    expect(runs.get("run").ci_state).not.toBe("gave_up");
    expect(gh).toHaveBeenCalledTimes(2);
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledExactlyOnceWith("run", f.head);
  }, 20_000);

  it("retains a genuinely imported failed publication and rechecks the current PR before its direct push retry", async () => {
    const f = await fixture({ failPushes: 5 });
    await expect(service().publish("run", f.live)).rejects.toMatchObject({ step: "push", attempts: 5 });
    expect(service().live.get("run").publishPending).toMatchObject({ imported: true, snapshot: { head: f.head } });
    expect(await f.git(f.cwd, "rev-parse", "HEAD")).toBe(f.head);
    expect(runs.get("run").head_sha).toBe(f.base);
    expect(await f.remoteHead()).toBe("");
    const previous = f.events.length;
    // The same kept commit is no longer safe to publish, even though its diff is safe.
    vi.mocked(gh).mockResolvedValueOnce({ state: "closed", merged: false });
    await service().publish("run", f.live);
    expect(f.events.slice(previous).map(event => event.kind)).toEqual(["guard"]);
    f.expectLeasedPushes();
    f.expectGaveUp();
    expect(runs.get("run").head_sha).toBe(f.base);
    expect(await f.remoteHead()).toBe("");
    expect(f.rpc).toHaveBeenCalledTimes(1); // No new snapshot/import from the retained worker.
  }, 20_000);

  it("watches the kept commit after a retained publication succeeds without another snapshot or import", async () => {
    const f = await fixture({ failPushes: 5 });
    await expect(service().publish("run", f.live)).rejects.toMatchObject({ step: "push", attempts: 5 });
    const previous = f.events.length;
    await service().finish("run", f.live);
    expect(f.events.slice(previous).map(event => event.kind)).toEqual(["guard", "push"]);
    f.expectLeasedPushes();
    expect(await f.remoteHead()).toBe(f.head);
    expect(runs.get("run")).toMatchObject({ pushed: true, head_sha: f.head, ci_pending_sha: f.head });
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledExactlyOnceWith("run", f.head);
  }, 20_000);

  it("rechecks current CI policy on a capacity-reclaimed kept_commit retry and gives up without cloning or a second push", async () => {
    const f = await fixture({ failPushes: 1, removeBaselineOnFailure: true });
    // Capacity reclamation keeps the imported Git checkout, not a live worker.
    await f.git(f.cwd, "fetch", "--no-tags", f.bundlePath, "HEAD");
    await f.git(f.cwd, "reset", "--hard", "FETCH_HEAD");
    service().live.delete("run");
    const current = runs.get("run");
    Object.assign(current, { work_kept: true, kept_commit: f.head });
    runs.save(current);
    await service().boot("run");
    expect(f.events.map(event => event.kind)).toEqual(["guard", "push"]);
    f.expectLeasedPushes();
    f.expectGaveUp();
    expect(runs.get("run").head_sha).toBe(f.base);
    expect(await f.remoteHead()).toBe("");
    expect(f.rpc).not.toHaveBeenCalled();
    expect(service().booting.has("run")).toBe(false);
  }, 20_000);
});
