import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/db";
import { createAuthentication, seal } from "../src/auth";
import { saveProviderSettings } from "../src/providers";
import { BACKEND, assertBackend, type Backend } from "../src/backend";
import { Runs, parseRun, type Run } from "../src/runs/service";
import type { Config } from "../src/config";

vi.mock("../src/github", async (original) => ({
  ...await original<typeof import("../src/github")>(),
  gh: vi.fn(async () => ({ default_branch: "main" })),
  checkout: vi.fn(async () => ({ cwd: "/fake", archive: Buffer.from("repo") })),
  git: vi.fn(async () => Buffer.from("a".repeat(40))),
}));

let dir: string, db: ReturnType<typeof openStore>, runs: Runs;
const started: unknown[] = [];
const cfg = (): Config => ({ data: dir, origin: "http://localhost:8787", secret: "b".repeat(40), signup: true, port: 8787, dockerBin: "docker", workerImage: "unused", maxRuns: 4, runCPUs: 2, runMemoryMB: 2048 });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gond-backend-"));
  db = openStore(dir);
  await createAuthentication(db, cfg());
  db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run("u", "User", "user@example.test", 0, Date.now(), Date.now());
  db.prepare("INSERT INTO github_connections(user_id,token,connected_at) VALUES(?,?,?)").run("u", seal(cfg().secret, "fixture-backend-github-token"), Date.now());
  saveProviderSettings(db, cfg().secret, { connections: [{ id: "local", name: "Local", format: "openai", baseURL: "http://127.0.0.1:9/v1", discover: false, models: [{ id: "coder", name: "Coder", contextWindow: 128000, maxOutput: 8192, reasoning: "none", images: false }] }], defaultModel: "local:coder" });
  started.length = 0;
  runs = new Runs(db, cfg(), async () => ({ destroy: async () => {}, rpc: async (method: string, args?: unknown) => { started.push({ method, args }); return (method === "events" ? { events: [], alive: true } : true) as never; } }));
});
afterEach(async () => {
  await runs.shutdown();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function storeRun(id: string, data: Record<string, unknown>) {
  const now = Date.now();
  db.prepare("INSERT INTO runs(id,user_id,repo,status,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?)").run(id, "u", "acme/app", "ready", now, now, JSON.stringify({
    id, user_id: "u", repo: "acme/app", base_branch: "main", branch: "b", model_id: "local:coder", title: "Old", prompt: "x", status: "ready", step: null,
    created_at: now, updated_at: now, summary: { text: "", question: null }, pending: [], diff: "diff --git a/x b/x", phase: "idle", pushed: true, ...data,
  }));
}

it("has exactly one backend, the built-in runner", () => {
  expectTypeOf<Backend>().toEqualTypeOf<"builtin">();
  expect(BACKEND).toBe("builtin");
  expect(assertBackend(undefined)).toBe("builtin");
  expect(assertBackend("builtin")).toBe("builtin");
  for (const other of ["claude-code", "codex", "api", "", null, 1])
    expect(() => assertBackend(other)).toThrow(expect.objectContaining({ status: 400, code: "invalid_backend" }));
});

it("creates only built-in runs and refuses any other backend before doing work", async () => {
  const run = await runs.create("u", { repo: "acme/app", model: "local:coder", prompt: "Fix it" });
  expect(run.backend).toBe("builtin");
  expect(JSON.parse((db.prepare("SELECT data FROM runs WHERE id=?").get(run.id) as { data: string }).data).backend).toBe("builtin");
  await expect(runs.create("u", { repo: "acme/app", model: "local:coder", prompt: "Fix it", backend: "codex" })).rejects.toMatchObject({ code: "invalid_backend" });
  await expect(runs.create("u", { repo: "acme/app", model: "cli-codex:default", prompt: "Fix it" })).rejects.toMatchObject({ code: "retired_model" });
  expect((db.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n).toBe(1);
  // Saving can't smuggle another backend into a stored run.
  const loaded = runs.get(run.id);
  expect(() => runs.save({ ...loaded, backend: "codex" as unknown as Backend })).toThrow(expect.objectContaining({ code: "invalid_backend" }));
});

it("keeps runs from removed coding agents readable but refuses follow-ups", async () => {
  storeRun("run_retired", { backend: "claude-code", runtime_volume: "gond-agent-cli-" + "a".repeat(32), runtime_version: "2.1.0" });
  storeRun("run_plain", {});
  const retired = runs.get("run_retired", "u");
  expect(retired).toMatchObject({ backend: "builtin", retired_backend: "claude-code", diff: "diff --git a/x b/x" });
  expect(retired).not.toHaveProperty("runtime_volume");
  expect(runs.list("u").map(r => [r.id, r.backend, r.retired_backend])).toEqual(expect.arrayContaining([["run_retired", "builtin", "claude-code"], ["run_plain", "builtin", undefined]]));
  await expect(runs.validateFollowUp("run_retired", "u")).rejects.toMatchObject({ status: 409, code: "retired_backend", message: expect.stringMatching(/history and diff stay readable/) });
  expect(() => runs.enqueue("run_retired", "u", "Continue")).toThrow(expect.objectContaining({ code: "retired_backend" }));
  expect(started).toEqual([]);
  expect(parseRun(JSON.stringify({ id: "x", backend: "codex" } as unknown as Run))).toMatchObject({ backend: "builtin", retired_backend: "codex" });
});
