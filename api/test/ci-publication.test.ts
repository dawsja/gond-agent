import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthentication, seal } from "../src/auth";
import { command } from "../src/command";
import type { Config } from "../src/config";
import type { Workspace, WorkspaceFactory } from "../src/containers";
import { openStore } from "../src/db";
import { checkout, gh } from "../src/github";
import { saveProviderSettings } from "../src/providers";
import { emptySummary } from "../src/runs/fold";
import { Runs, type Run } from "../src/runs/service";
import { acceptEvidence, emptyEvidence } from "../src/runs/evidence";
import { descriptionFor } from "../src/runs/publication";
import { evidenceSigningKey, evidenceState, signedRecord } from "./fixtures/evidence";

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
const availabilityEndpoint = `repos/acme/app/git/matching-refs/heads/${branch}`;
const prEndpoint = "repos/acme/app/pulls/7";
const githubRequests = () => vi.mocked(gh).mock.calls.map(([endpoint]) => endpoint);
// Evidence classification also inspects paths. Only the CI guard may consume
// guard counters, retry failure injection or the queued-message race hook.
const isCiGuard = (args: string[]) => args.includes("diff") && args.includes("--no-ext-diff") && args.includes("--name-only");
type Event = { kind: "guard" | "push" | "ls-remote"; args: string[] };
let dir: string, db: ReturnType<typeof openStore>, runs: Runs;
const service = () => runs as any;
const factory = vi.fn<WorkspaceFactory>(async () => { throw new Error("Tests must not boot a worker"); });

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
  saveProviderSettings(db, cfg.secret, { connections: [{ id: "local", name: "Local", format: "openai",
    baseURL: "http://127.0.0.1:9/v1", apiKey: "fixture-provider-key", discover: false,
    models: [{ id: "coder", name: "Coder", contextWindow: 128000, maxOutput: 8192, reasoning: "none", images: true }] }], defaultModel: "local:coder" });
  runs = new Runs(db, cfg, factory);
  vi.mocked(gh).mockImplementation(async (endpoint, method, body, env) => {
    expect(method).toBe("GET");
    expect(body).toBeUndefined();
    expect(env?.GH_TOKEN).toBe(token);
    if (endpoint === availabilityEndpoint) return [] as never;
    expect(endpoint).toBe(prEndpoint);
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
  failPushes?: number; loseResponse?: boolean; configOnRetry?: boolean; removeBaselineOnFailure?: boolean; configChange?: boolean;
  docsOnly?: boolean; testWeakening?: boolean;
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
  if (options.docsOnly) await writeFile(join(worker, "README.md"), "Documentation only\n");
  else await writeFile(join(worker, "work.txt"), "fixed\n");
  if (options.testWeakening) await writeFile(join(worker, "work.test.ts"), 'it.skip("important behavior", () => {});\n');
  if (options.configChange) {
    await mkdir(join(worker, ".github", "workflows"), { recursive: true });
    await writeFile(join(worker, ".github", "workflows", "test.yml"), "name: changed CI\n");
  }
  await git(worker, "add", ".");
  await git(worker, "commit", "-m", "automatic fix");
  const head = await git(worker, "rev-parse", "HEAD");
  const bundlePath = join(worker, ".git", "fixture.bundle");
  await git(worker, "bundle", "create", bundlePath, "HEAD");
  const bundle = await readFile(bundlePath);
  const run: Run = {
    id: "run", user_id: "u", repo: "acme/app", base_branch: "main", branch,
    explicit_branch: true, model_id: "local:coder", backend: "builtin",
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
    if (method === "send") return undefined as never;
    if (method === "export_state") return { state: {} } as never; // Legacy worker: no evidence key.
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
      if (isCiGuard(args)) {
        events.push({ kind: "guard", args: [...args] });
        expect(runs.get("run").pushed).toBe(false);
        if (++guards > 1 && options.configOnRetry) return Buffer.from(".github/workflows/test.yml\0");
      }
      if (args.includes("ls-remote")) {
        events.push({ kind: "ls-remote", args: [...args] });
        expect(commandOptions?.env?.GH_TOKEN).toBe(token);
        expect(runs.get("run").pushed).toBe(false);
      }
      if (args.includes("push")) {
        events.push({ kind: "push", args: [...args] });
        expect(commandOptions?.env?.GH_TOKEN).toBe(token);
        expect(runs.get("run").pushed).toBe(false);
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
  it.each(["no records", "gate off", "docs only"])("inspects the pinned publication tree without execution records: %s", async mode => {
    const f = await fixture({ docsOnly: mode === "docs only", testWeakening: mode !== "docs only" });
    const current = runs.get("run");
    if (mode !== "no records") current.evidence = { ...emptyEvidence(), policy: { ...evidenceState().state.evidence.policy, enabled: mode !== "gate off" } };
    runs.save(current);
    const tree = await f.git(join(dir, "worker"), "rev-parse", `${f.head}^{tree}`);
    expect(await service().publish("run", f.live)).toBe(true);
    expect(runs.get("run").evidence).toMatchObject({ records: [], publication_tree: tree });
    expect(vi.mocked(command).mock.calls.filter(([file, args]) => file === "git" && isCiGuard(args))).toHaveLength(1);
    const body = descriptionFor(runs.get("run"));
    expect(body).toContain("Not verified.");
    expect(body).toContain("### Evidence weakened");
    if (mode === "docs only") expect(runs.get("run").evidence?.weakened).toEqual([]);
    else expect(body).toContain("Skipped or narrowed tests added: work.test.ts");
    if (mode === "gate off") expect(body).toContain("Verification gate: off.");
    expect(f.events.map(event => event.kind)).toEqual(["guard", "push"]);
    f.expectLeasedPushes();
  });
  it.each([true, false])("uses the real pinned imported commit tree for evidence freshness (matching=%s), preserving the CI guard", async matching => {
    const f = await fixture();
    const tree = await f.git(join(dir, "worker"), "rev-parse", `${f.head}^{tree}`);
    const current = runs.get("run");
    const claimed = matching ? tree : "f".repeat(40);
    current.evidence = acceptEvidence(undefined, signedRecord({ tree_hash_before: claimed, tree_hash_after: claimed }), evidenceSigningKey, "run");
    runs.save(current);
    expect(await service().publish("run", f.live)).toBe(true);
    expect(runs.get("run").evidence?.publication_tree).toBe(tree);
    expect(descriptionFor(runs.get("run"))).toContain(matching ? "1 fresh successful check(s)" : "Not verified.");
    expect(f.events.map(event => event.kind)).toEqual(["guard", "push"]);
    f.expectLeasedPushes();
    expect(await f.remoteHead()).toBe(f.head);
  });
  it.each(["first import", "already imported retry"])("refuses a real .github change on %s before any remote push", async path => {
    const f = await fixture({ configChange: true });
    if (path === "already imported retry") {
      await f.git(f.cwd, "fetch", "--no-tags", f.bundlePath, "HEAD");
      await f.git(f.cwd, "reset", "--hard", "FETCH_HEAD");
      Object.assign(f.live, { publishPending: { imported: true, snapshot: { head: f.head, bundle: "" } } });
    }
    expect(await service().publish("run", f.live)).toBe(false);
    expect(f.events.map(event => event.kind)).toEqual(["guard"]);
    f.expectGaveUp();
    expect(runs.get("run")).toMatchObject({ pushed: false, head_sha: f.base });
    expect(await f.remoteHead()).toBe("");
    expect(f.rpc).toHaveBeenCalledTimes(path === "first import" ? 1 : 0);
    // Fresh snapshots preflight the branch; neither refusal reaches the PR policy read.
    expect(githubRequests()).toEqual(path === "first import" ? [availabilityEndpoint] : []);
  });

  it("rechecks the pinned diff after a transient first import push failure and refuses CI changes before a second push", async () => {
    const f = await fixture({ failPushes: 1, configOnRetry: true });
    await service().finish("run", f.live);
    expect(f.events.map(event => event.kind)).toEqual(["guard", "push", "guard"]);
    f.expectLeasedPushes();
    f.expectGaveUp();
    expect(runs.get("run").head_sha).toBe(f.base);
    expect(await f.remoteHead()).toBe("");
    expect(f.rpc.mock.calls.filter(([method]) => method === "snapshot")).toHaveLength(1);
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(githubRequests()).toEqual([availabilityEndpoint, prEndpoint]);
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
    // Retry/reconciliation must not repeat availability checks after the ref was created.
    expect(githubRequests()).toEqual([availabilityEndpoint, prEndpoint, prEndpoint]);
    expect(f.rpc.mock.calls.filter(([method]) => method === "snapshot")).toHaveLength(1);
    expect(f.start).toHaveBeenCalledExactlyOnceWith("run", f.head);
  }, 20_000);

  it("retains a genuinely imported failed publication and rechecks the current PR before its direct push retry", async () => {
    const f = await fixture({ failPushes: 5 });
    await expect(service().publish("run", f.live)).rejects.toMatchObject({ step: "push", attempts: 5 });
    expect(f.events.map(event => event.kind)).toEqual(Array.from({ length: 5 }, () => ["guard", "push"]).flat());
    expect(service().live.get("run").publishPending).toMatchObject({ imported: true, snapshot: { head: f.head } });
    expect(await f.git(f.cwd, "rev-parse", "HEAD")).toBe(f.head);
    expect(runs.get("run")).toMatchObject({ pushed: false, head_sha: f.base });
    expect(await f.remoteHead()).toBe("");
    expect(githubRequests()).toEqual([availabilityEndpoint, ...Array(5).fill(prEndpoint)]);
    const previous = f.events.length;
    // The same kept commit is no longer safe to publish, even though its diff is safe.
    vi.mocked(gh).mockResolvedValueOnce({ state: "closed", merged: false });
    await service().publish("run", f.live);
    expect(f.events.slice(previous).map(event => event.kind)).toEqual(["guard"]);
    f.expectLeasedPushes();
    f.expectGaveUp();
    expect(runs.get("run").head_sha).toBe(f.base);
    expect(await f.remoteHead()).toBe("");
    expect(f.rpc.mock.calls.filter(([method]) => method === "snapshot")).toHaveLength(1); // No new snapshot/import from the retained worker.
    expect(githubRequests()).toEqual([availabilityEndpoint, ...Array(6).fill(prEndpoint)]);
  }, 20_000);

  it("watches the kept commit after a retained publication succeeds without another snapshot or import", async () => {
    const f = await fixture({ failPushes: 5 });
    await expect(service().publish("run", f.live)).rejects.toMatchObject({ step: "push", attempts: 5 });
    expect(runs.get("run")).toMatchObject({ pushed: false, head_sha: f.base });
    const previous = f.events.length;
    await service().finish("run", f.live);
    expect(f.events.slice(previous).map(event => event.kind)).toEqual(["guard", "push"]);
    f.expectLeasedPushes();
    expect(await f.remoteHead()).toBe(f.head);
    expect(runs.get("run")).toMatchObject({ pushed: true, head_sha: f.head, ci_pending_sha: f.head });
    expect(f.rpc.mock.calls.filter(([method]) => method === "snapshot")).toHaveLength(1);
    expect(githubRequests()).toEqual([availabilityEndpoint, ...Array(6).fill(prEndpoint)]);
    expect(f.start).toHaveBeenCalledExactlyOnceWith("run", f.head);
  }, 20_000);

  it("refuses a real .github change in an automatic kept commit during boot before pushing or cloning", async () => {
    const f = await fixture({ configChange: true });
    await f.git(f.cwd, "fetch", "--no-tags", f.bundlePath, "HEAD");
    await f.git(f.cwd, "reset", "--hard", "FETCH_HEAD");
    service().live.delete("run");
    const current = runs.get("run");
    current.kept_commit = f.head;
    current.pending.push({ text: "Fix CI", images: [], source: "ci" });
    runs.save(current);

    await service().boot("run");

    expect(f.events.map(event => event.kind)).toEqual(["guard"]);
    expect(f.events[0].args.slice(-3)).toEqual([f.base, f.head, "--"]);
    f.expectGaveUp();
    expect(runs.get("run")).toMatchObject({
      pushed: false, head_sha: f.base, kept_commit: f.head, phase: "idle",
      ci_reason: "needs a person: automatic fixes cannot push changes to CI configuration.",
    });
    expect(await f.remoteHead()).toBe("");
    expect(f.rpc).not.toHaveBeenCalled();
    expect(gh).not.toHaveBeenCalled();
    expect(service().booting.has("run")).toBe(false);
  }, 20_000);

  it("rechecks current CI policy on a capacity-reclaimed kept_commit retry and gives up without cloning or a second push", async () => {
    const f = await fixture({ failPushes: 1, removeBaselineOnFailure: true });
    // Capacity reclamation keeps the imported Git checkout, not a live worker.
    await f.git(f.cwd, "fetch", "--no-tags", f.bundlePath, "HEAD");
    await f.git(f.cwd, "reset", "--hard", "FETCH_HEAD");
    service().live.delete("run");
    const current = runs.get("run");
    Object.assign(current, { work_kept: true, kept_commit: f.head });
    current.pending.push({ text: "Fix CI", images: [], source: "ci" });
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

  it.each(["previously refused", "not yet retried"])("delivers human follow-ups without publishing or looping on a %s automatic kept commit", async state => {
    const f = await fixture({ configChange: true });
    await f.git(f.cwd, "fetch", "--no-tags", f.bundlePath, "HEAD");
    await f.git(f.cwd, "reset", "--hard", "FETCH_HEAD");
    service().live.delete("run");
    const current = runs.get("run");
    current.kept_commit = f.head;
    if (state === "previously refused") current.pending.push({ text: "Fix CI", images: [], source: "ci" });
    runs.save(current);
    if (state === "previously refused") {
      await service().boot("run");
      f.expectGaveUp();
      expect(runs.get("run").kept_commit).toBe(f.head);
    }

    // Real local Git clones/bundles keep refused files out of the human turn.
    const rpc = await humanWorkspace(f);
    runs.enqueue("run", "u", "Please keep my message");
    await service().launches.get("run");
    expect(rpc).toHaveBeenCalledWith("send", { input: expect.objectContaining({ type: "user", text: "Please keep my message" }) });
    expect(runs.get("run")).toMatchObject({ ci_turn: false, pending: [] });
    expect(runs.get("run").kept_commit).toBeUndefined();
    expect(await f.remoteHead()).toBe("");
    expect(f.events.filter(event => event.kind === "push")).toEqual([]);
    expect(runs.history("run", 0)).toContainEqual(expect.objectContaining({
      type: "run.ci", reason: expect.stringContaining("unpushed automatic changes were dropped"),
    }));

    await service().finish("run", service().live.get("run"));
    expect(await f.remoteHead()).toBe(f.base);
    expect(await f.git(join(dir, "remote.git"), "ls-tree", "-r", ref, ".github")).toBe("");
    runs.enqueue("run", "u", "A later follow-up");
    await service().launches.get("run");
    expect(rpc).toHaveBeenCalledWith("send", { input: expect.objectContaining({ type: "user", text: "A later follow-up" }) });
    expect(runs.get("run")).toMatchObject({ ci_turn: false, pending: [], head_sha: f.base });
    expect(runs.get("run").kept_commit).toBeUndefined();
    expect(await f.remoteHead()).not.toBe(f.head);
  }, 20_000);

  it.each(["before publication", "during snapshot", "after stop"])("keeps an automatic push guarded when a human queues work %s, then delivers only the human message", async timing => {
    const f = await fixture({ configChange: true });
    const rpc = await humanWorkspace(f);
    if (timing === "before publication") runs.enqueue("run", "u", "Do not lose this queued message");
    // Also cover a human request arriving after publication captured the turn,
    // but before the pinned-commit guard executes.
    const originalRpc = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async method => {
      if (method !== "snapshot") return originalRpc(method);
      if (timing === "after stop") await runs.stop("run", "u");
      if (timing !== "before publication") runs.enqueue("run", "u", "Do not lose this queued message");
      expect(runs.get("run").ci_turn).toBe(false);
      const current = runs.get("run");
      current.pending.unshift({ text: "Obsolete CI work", images: [], source: "ci" });
      runs.save(current);
      return { bundle: (await readFile(f.bundlePath)).toString("base64"), head: f.head };
    });

    await service().finish("run", f.live);
    await service().launches.get("run");
    expect(runs.get("run")).toMatchObject({ ci_state: "gave_up", ci_active: false, ci_reason: expect.stringContaining("needs a person"), pending: [] });
    expect(f.events.map(event => event.kind)).toEqual(timing === "after stop" ? [] : ["guard"]);
    expect(await f.remoteHead()).toBe("");
    expect(rpc).toHaveBeenCalledWith("send", { input: expect.objectContaining({ type: "user", text: "Do not lose this queued message" }) });
    expect(rpc.mock.calls.filter(([method, params]) => method === "send" && (params as any)?.input?.type === "user")).toHaveLength(1);
    expect(f.destroy).toHaveBeenCalledTimes(1);
    await service().finish("run", service().live.get("run"));
    expect(await f.remoteHead()).toBe(f.base);
    expect(await f.git(join(dir, "remote.git"), "ls-tree", "-r", ref, ".github")).toBe("");
  }, 20_000);

  it("preserves accepted human messages if refused-workspace cleanup fails and retries cleanup on a follow-up", async () => {
    const f = await fixture({ configChange: true });
    runs.enqueue("run", "u", "Keep this even if cleanup fails");
    f.destroy.mockRejectedValueOnce(new Error("Fixture cleanup failure"));
    await service().finish("run", f.live);
    expect(runs.get("run")).toMatchObject({
      status: "failed", ci_state: "gave_up", pending: [{ text: "Keep this even if cleanup fails" }],
      error: expect.stringContaining("Your queued messages are kept"),
    });
    expect(await f.remoteHead()).toBe("");
    expect(service().booting.has("run")).toBe(false);
    const rpc = await humanWorkspace(f);
    runs.enqueue("run", "u", "Retry cleanup");
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith("send", {
      input: expect.objectContaining({ type: "user", text: "Keep this even if cleanup fails" }),
    }));
    expect(runs.get("run")).toMatchObject({ pending: [{ text: "Retry cleanup" }] });
    expect(await f.remoteHead()).toBe("");
    expect(f.destroy).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("preserves a human message queued while an automatic kept-commit boot is being refused", async () => {
    const f = await fixture({ configChange: true });
    await f.git(f.cwd, "fetch", "--no-tags", f.bundlePath, "HEAD");
    await f.git(f.cwd, "reset", "--hard", "FETCH_HEAD");
    service().live.delete("run");
    const current = runs.get("run");
    Object.assign(current, { kept_commit: f.head, pending: [{ text: "Fix CI", images: [], source: "ci" }] });
    runs.save(current);
    const rpc = await humanWorkspace(f);
    const execute = vi.mocked(command).getMockImplementation()!;
    let queued = false;
    vi.mocked(command).mockImplementation(async (file, args, options) => {
      if (!queued && file === "git" && isCiGuard(args)) {
        queued = true;
        runs.enqueue("run", "u", "I arrived during boot");
      }
      return execute(file, args, options);
    });
    service().booting.add("run");
    await service().boot("run");
    expect(runs.get("run")).toMatchObject({ ci_state: "gave_up", ci_turn: false, pending: [], head_sha: f.base });
    expect(runs.get("run").kept_commit).toBeUndefined();
    expect(f.events.map(event => event.kind)).toEqual(["guard"]);
    expect(await f.remoteHead()).toBe("");
    expect(rpc).toHaveBeenCalledWith("send", { input: expect.objectContaining({ type: "user", text: "I arrived during boot" }) });
  }, 20_000);
});

async function humanWorkspace(f: Awaited<ReturnType<typeof fixture>>) {
  vi.spyOn(service(), "pump").mockResolvedValue(undefined);
  vi.mocked(checkout).mockImplementation(async (_data, _id, _repo, _base, _branch, resume) => {
    await rm(f.cwd, { recursive: true, force: true });
    await mkdir(f.cwd, { recursive: true });
    await f.git(f.cwd, "clone", "--no-tags", "--branch", resume ? branch : "main", join(dir, "remote.git"), ".");
    return { cwd: f.cwd, archive: Buffer.from("local fixture checkout") };
  });
  const rpc = vi.fn<Workspace["rpc"]>().mockImplementation(async method => {
    if (method !== "snapshot") return undefined as never;
    const path = join(f.cwd, ".git", "human.bundle");
    await f.git(f.cwd, "bundle", "create", path, "HEAD");
    return { bundle: (await readFile(path)).toString("base64"), head: f.base } as never;
  });
  factory.mockImplementation(async () => ({ rpc: rpc as Workspace["rpc"], destroy: vi.fn(async () => {}) }));
  return rpc;
}
