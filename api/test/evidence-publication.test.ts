import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthentication, seal } from "../src/auth";
import { command } from "../src/command";
import type { Config } from "../src/config";
import { openStore } from "../src/db";
import { emptySummary } from "../src/runs/fold";
import { Runs, type Run } from "../src/runs/service";
import { acceptEvidence, emptyEvidence } from "../src/runs/evidence";
import { descriptionFor } from "../src/runs/publication";
import { evidenceSigningKey, evidenceState, signedRecord } from "./fixtures/evidence";

// Real Git bundle import, publication inspection and push; only external GitHub
// reads and commit identity are faked. No worker or GitHub network is required.
vi.mock("../src/github", async original => ({
  ...await original<typeof import("../src/github")>(),
  gh: vi.fn(async () => []),
  commitIdentity: vi.fn(async () => ({ name: "Fixture", email: "fixture@example.test" })),
}));

const branch = "feat/evidence-publication";
let dir: string, db: ReturnType<typeof openStore>, runs: Runs;
const service = () => runs as any;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gond-agent-evidence-publication-"));
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
    .run("u", seal(cfg.secret, "owner-only-fixture-token"), Date.now());
  runs = new Runs(db, cfg, async () => { throw new Error("Tests must not boot a worker"); });
});

afterEach(async () => {
  await runs.shutdown();
  db.close();
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function fixture(docsOnly = false) {
  const remote = join(dir, "remote.git"), cwd = join(dir, "checkouts", "run"), worker = join(dir, "worker");
  await Promise.all([remote, cwd, worker].map(path => mkdir(path, { recursive: true })));
  const git = async (folder: string, ...args: string[]) =>
    (await command("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: folder })).toString().trim();
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
  if (docsOnly) await writeFile(join(worker, "README.md"), "Documentation only\n");
  else {
    await writeFile(join(worker, "work.txt"), "fixed\n");
    await writeFile(join(worker, "work.test.ts"), 'it.skip("important behavior", () => {});\n');
  }
  await git(worker, "add", "."); await git(worker, "commit", "-m", "publication fixture");
  const head = await git(worker, "rev-parse", "HEAD");
  const tree = await git(worker, "rev-parse", `${head}^{tree}`);
  const bundlePath = join(worker, ".git", "fixture.bundle");
  await git(worker, "bundle", "create", bundlePath, "HEAD");
  const bundle = await readFile(bundlePath);
  const run: Run = {
    id: "run", user_id: "u", repo: "acme/app", base_branch: "main", branch,
    explicit_branch: true, model_id: "local:coder", backend: "builtin",
    title: "Check evidence", prompt: "Check evidence", status: "ready", step: null,
    created_at: 1, updated_at: 1, started_at: 1, finished_at: null,
    pr_number: null, pr_url: null, pr_state: null,
    head_sha: base, base_sha: base, error: null, files: 0, additions: 0, deletions: 0,
    plan_done: 0, plan_total: 0, source: "web", phase: "idle", pushed: false,
    diff: "", summary: emptySummary(), pending: [], auto_pr: false,
  };
  db.prepare("INSERT INTO runs(id,user_id,repo,status,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?)")
    .run(run.id, run.user_id, run.repo, run.status, run.created_at, run.updated_at, JSON.stringify(run));
  const rpc = vi.fn(async (method: string) => {
    if (method !== "snapshot") throw new Error(`Unexpected worker call: ${method}`);
    return { bundle: bundle.toString("base64"), head };
  });
  const live = { workspace: { rpc, destroy: vi.fn(async () => {}) }, cwd, cursor: 0, busy: true, closed: false };
  service().live.set("run", live);
  const remoteHead = () => git(remote, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);
  return { live, head, tree, remoteHead };
}

describe("service evidence publication with real Git", () => {
  it.each(["no records", "gate off", "docs only"])("inspects the pinned publication tree without execution records: %s", async mode => {
    const f = await fixture(mode === "docs only");
    const current = runs.get("run");
    if (mode !== "no records") current.evidence = { ...emptyEvidence(), policy: { ...evidenceState().state.evidence.policy, enabled: mode !== "gate off" } };
    runs.save(current);
    expect(await service().publish("run", f.live)).toBe(true);
    expect(runs.get("run").evidence).toMatchObject({ records: [], publication_tree: f.tree, docs_only: mode === "docs only" });
    const body = descriptionFor(runs.get("run"));
    expect(body).toContain("Not verified.");
    expect(body).toContain("### Evidence weakened");
    if (mode === "docs only") expect(runs.get("run").evidence?.weakened).toEqual([]);
    else expect(body).toContain("Skipped or narrowed tests added: work.test.ts");
    if (mode === "gate off") expect(body).toContain("Verification gate: off.");
    expect(await f.remoteHead()).toBe(f.head);
  });

  it.each([true, false])("uses the pinned imported commit tree for evidence freshness (matching=%s)", async matching => {
    const f = await fixture();
    const current = runs.get("run");
    const claimed = matching ? f.tree : "f".repeat(40);
    current.evidence = acceptEvidence(undefined, signedRecord({ tree_hash_before: claimed, tree_hash_after: claimed }), evidenceSigningKey, "run");
    runs.save(current);
    expect(await service().publish("run", f.live)).toBe(true);
    expect(runs.get("run").evidence?.publication_tree).toBe(f.tree);
    expect(descriptionFor(runs.get("run"))).toContain(matching ? "1 fresh successful check(s)" : "Not verified.");
    expect(await f.remoteHead()).toBe(f.head);
  });
});
