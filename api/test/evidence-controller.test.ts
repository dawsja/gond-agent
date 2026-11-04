// Real Python controller, state RPCs, capture locks, holds, Git bundles and SQLite.
// Docker and model execution are replaced, not the controller's dispatch semantics.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAuthentication, seal } from "../src/auth";
import type { Config } from "../src/config";
import { ContainerPool, type Workspace } from "../src/containers";
import { openStore, setSetting } from "../src/db";
import { importBundle } from "../src/github";
import { saveProviderSettings } from "../src/providers";
import { Runs } from "../src/runs/service";
import { descriptionFor } from "../src/runs/publication";
import { evidenceState, signedRecord } from "./fixtures/evidence";

vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn((file, args, options) => file === "fixture-docker"
    ? actual.spawn("python3", [resolve("test/fixtures/evidence-controller.py"), repo], options)
    : actual.spawn(file, args, options)) };
});
vi.mock("../src/command", async original => {
  const actual = await original<typeof import("../src/command")>();
  return { ...actual, command: vi.fn((file, args, options) => file === "fixture-docker"
    ? Promise.resolve(Buffer.from("")) : actual.command(file, args, options)) };
});
vi.mock("../src/github", async original => {
  const actual = await original<typeof import("../src/github")>();
  return { ...actual,
    gh: vi.fn(async () => ({ default_branch: "main" })),
    // The controller and service share this fixture checkout, so setup receives
    // an empty archive rather than overwriting existing read-only Git objects.
    checkout: vi.fn(async () => ({ cwd: repo, archive: execFileSync("tar", ["-czf", "-", "--files-from", "/dev/null"]) })),
    commitIdentity: vi.fn(async () => ({ name: "Fixture", email: "fixture@example.test" })),
    importBundle: vi.fn(async (...args: Parameters<typeof actual.importBundle>) => {
      const [cwd, bundle, branch, , , options] = args;
      // Check that publication really produced a valid Git bundle, then exercise
      // the service-side freshness inspection normally run immediately before push.
      const path = join(dir, "published.bundle");
      writeFileSync(path, bundle);
      execFileSync("git", ["bundle", "verify", path], { cwd, stdio: "pipe" });
      await options?.beforePush?.({ cwd, branch, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim() });
    }),
  };
});

let dir: string, repo: string, runs: Runs, db: ReturnType<typeof openStore>, workspace: Workspace;
let signingKey: Buffer, persistenceDelay: number, persistenceStarted: boolean;
let calls: string[];

beforeEach(async () => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "gond-evidence-controller-"));
  repo = join(dir, "repo"); mkdirSync(repo);
  execFileSync("git", ["init", "--initial-branch=main", repo], { stdio: "pipe" });
  writeFileSync(join(repo, "app.ts"), "export const value = 1;\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Base"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repo });
  const cfg = { data: dir, origin: "http://localhost:8787", secret: "q".repeat(40), signup: true, port: 8787,
    dockerBin: "fixture-docker", workerImage: "unused", maxRuns: 1, runCPUs: 2, runMemoryMB: 2048 } as Config;
  db = openStore(dir);
  await createAuthentication(db, cfg);
  setSetting(db, "github-shared-fallback", false);
  db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
    .run("owner", "Owner", "owner@example.test", 0, Date.now(), Date.now());
  db.prepare("INSERT INTO github_connections(user_id,token,connected_at) VALUES(?,?,?)").run("owner", seal(cfg.secret, "fixture"), Date.now());
  db.prepare("INSERT INTO profiles(user_id,auto_pr) VALUES(?,0)").run("owner");
  saveProviderSettings(db, cfg.secret, { connections: [{ id: "local", name: "Local", format: "openai",
    baseURL: "http://127.0.0.1:9/v1", apiKey: "fixture", discover: false,
    models: [{ id: "coder", name: "Coder", contextWindow: 128000, maxOutput: 8192, reasoning: "none", images: true }] }], defaultModel: "local:coder" });
  persistenceDelay = 0; persistenceStarted = false; calls = [];
  const pool = new ContainerPool(cfg);
  runs = new Runs(db, cfg, async (id, handler) => {
    workspace = await pool.start(id, handler);
    const rpc = workspace.rpc.bind(workspace);
    workspace.rpc = (method, args) => {
      calls.push(method);
      if (method === "init_evidence") signingKey = Buffer.from(args!.key as string, "hex");
      return rpc(method, args);
    };
    const enable = workspace.enableCheckpoints!.bind(workspace);
    workspace.enableCheckpoints = (options, save, onError) => enable(options, async cp => {
      const wait = persistenceDelay; persistenceDelay = 0;
      persistenceStarted = true;
      await delay(wait);
      await save(cp);
    }, onError);
    return workspace;
  });
});
afterEach(async () => {
  await runs?.shutdown();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function start(treeDelay = 0, exportDelay = 0) {
  const run = await runs.create("owner", { repo: "acme/app", model: "local:coder", prompt: "Implement it" });
  await vi.waitFor(() => expect(calls).toContain("send"));
  writeFileSync(join(repo, "app.ts"), "export const value = 2;\n");
  // Compute the canonical tree without changing HEAD, matching the controller.
  execFileSync("git", ["add", "."], { cwd: repo });
  const tree = execFileSync("git", ["write-tree"], { cwd: repo }).toString().trim();
  const evidence = evidenceState(signingKey.toString("hex")).state.evidence;
  evidence.unverified = [];
  const record = signedRecord({ run_id: run.id, tree_hash_before: tree, tree_hash_after: tree }, signingKey);
  await workspace.rpc("fixture.configure", { tree_delay: treeDelay, export_delay: exportDelay, evidence: { ...evidence, records: [record] } });
  await workspace.rpc("send", { input: { type: "fixture.finish" } });
  return run.id;
}
async function published(id: string) {
  await vi.waitFor(() => expect(runs.get(id)).toMatchObject({ status: "ready", pushed: true }), { timeout: 12_000 });
  expect(importBundle).toHaveBeenCalledTimes(1);
  expect(runs.history(id, 0).some(event => event.type === "run.error")).toBe(false);
  const body = descriptionFor(runs.get(id));
  expect(body).toContain("1 fresh successful check(s)");
  return body;
}

it.each(["tree export", "persistence"])("publishes after a 2.5 s checkpoint %s through the real controller", async operation => {
  if (operation === "persistence") persistenceDelay = 2500;
  const id = await start(operation === "tree export" ? 2.5 : 0);
  if (operation === "persistence") await vi.waitFor(() => expect(persistenceStarted).toBe(true));
  await vi.waitFor(async () => expect(await workspace.rpc("fixture.status")).toEqual({ held: true, locked: operation === "tree export" }));
  expect(await workspace.rpc("fixture.probe_snapshot")).toBe(operation === "tree export"
    ? "A checkpoint operation is already pending." : "The worker is held for a checkpoint.");
  const body = await published(id);
  expect(body).toContain("Verification gate: on");
  expect(body).not.toContain("policy source: unavailable");
  expect(runs.history(id, 0).some(event => event.type === "run.checkpoint_unavailable")).toBe(false);
}, 20_000);

it("drains the real controller hold after a flush deadline before snapshotting", async () => {
  // Accelerate only the first 30 s flush deadline; the independent drain keeps
  // its real bound and the controller still takes a real 2.5 s to export.
  const original = globalThis.setTimeout;
  let accelerated = false;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    if (args[1] === 30_000 && !accelerated) { accelerated = true; args[1] = 1200; }
    return original(...args);
  }) as typeof setTimeout);
  const id = await start(2.5);
  await published(id);
  expect(accelerated).toBe(true);
  expect(runs.history(id, 0).some(event => event.type === "run.checkpoint_unavailable")).toBe(true);
}, 20_000);

it("retains policy and passed checks after a slow-but-successful private export", async () => {
  const id = await start(0, 2.5);
  const body = await published(id);
  expect(body).toContain("Verification gate: on");
  expect(body).toContain("Policy source and frozen checks:");
  expect(body).not.toContain("Verification policy status unavailable");
  expect(body).not.toContain("policy source: unavailable");
}, 20_000);
