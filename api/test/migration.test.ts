import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, installAccountCleanup, openStore } from "../src/db";
import { seal } from "../src/auth";
import { removeRetiredRuntimes } from "../src/retired-runtimes";
import { Runs } from "../src/runs/service";
import type { Config } from "../src/config";

const secret = "c".repeat(40);
const instance = "0123456789abcdef01234567";
const volume = (n: number) => `gond-agent-cli-${String(n).repeat(32)}`;
let dir: string, logs: string[];
const credential = seal(secret, JSON.stringify({ ".codex/auth.json": Buffer.from('{"refresh_token":"old-codex-refresh"}').toString("base64") }));
const session = seal(secret, JSON.stringify({ files: { ".codex/sessions/a.jsonl": "e30=" } }));

/** A database exactly as the previous release left it, with Codex and Claude Code data. */
function oldDatabase() {
  const db = new Database(join(dir, "gond-agent.sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec(readFileSync(join(import.meta.dirname, "fixtures/schema-before-builtin-only.sql"), "utf8"));
  const now = Date.now();
  db.prepare('INSERT INTO "user"(id,name,email) VALUES(?,?,?)').run("u", "User", "u@example.test");
  db.prepare("INSERT INTO cli_accounts(user_id,backend,credentials,connected_at,models) VALUES('u','codex',?,?,'[]')").run(credential, now);
  const run = (id: string, data: Record<string, unknown>) => db.prepare("INSERT INTO runs(id,user_id,repo,status,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?)")
    .run(id, "u", "acme/app", "ready", now, now, JSON.stringify({ id, user_id: "u", repo: "acme/app", status: "ready", model_id: "x", summary: {}, pending: [], diff: "diff --git a/f b/f", phase: "idle", ...data }));
  run("run_codex", { backend: "codex", model_id: "cli-codex:default", runtime_volume: volume(1), runtime_version: "0.166.0", pending: [{ text: "queued", images: [] }] });
  run("run_api", { model_id: "local:coder" });
  db.prepare("INSERT INTO events(run_id,data) VALUES('run_codex',?)").run(JSON.stringify({ type: "text", text: "Codex history" }));
  db.prepare("INSERT INTO cli_sessions(run_id,state) VALUES('run_codex',?)").run(session);
  db.prepare("INSERT INTO cli_usage(event_id,user_id,run_id,model_id,data,created_at) VALUES('run_codex:1','u','run_codex','cli-codex:default',?,?)").run(JSON.stringify({ input_uncached: 70, output: 9, cache_read: 4, cache_write: 0, reasoning: 2 }), now);
  db.prepare("INSERT INTO cli_usage_totals(key,run_id,data) VALUES('k','run_codex','{}')").run();
  for (const [key, value] of [["runtime:codex", { backend: "codex", volume: volume(1), version: "0.166.0" }], ["runtime-history:codex", [volume(2)]], ["runtime-staging:claude-code", volume(3)], ["runtime-instance", instance], ["providers", { connections: [], defaultModel: "" }]] as const)
    db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(key, JSON.stringify(value));
  const schedule = (id: string, model: string) => db.prepare("INSERT INTO runners(id,user_id,enabled,next_run_at,data) VALUES(?,?,1,?,?)").run(id, "u", now, JSON.stringify({ id, model_id: model, enabled: true, next_run_at: now }));
  schedule("runner_codex", "cli-codex:default");
  schedule("runner_api", "local:coder");
  db.close();
}
const fileText = () => ["gond-agent.sqlite", "gond-agent.sqlite-wal"].map(f => join(dir, f)).filter(existsSync).map(f => readFileSync(f).toString("latin1")).join("");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gond-migrate-"));
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it("retires Claude Code and Codex data idempotently while keeping history readable", async () => {
  oldDatabase();
  expect(fileText()).toContain(credential);
  const db = openStore(dir);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name);
  expect(tables.filter(t => t.startsWith("cli_"))).toEqual([]);
  expect(tables).toEqual(expect.arrayContaining(["subscription_accounts", "subscription_notices"]));
  expect((db.prepare("SELECT key FROM settings ORDER BY key").all() as { key: string }[]).map(r => r.key)).toEqual(["providers", "retired-runtime-cleanup"]);
  const cleanup = getSetting<{ instance: string; volumes: string[] }>(db, "retired-runtime-cleanup")!;
  expect(cleanup.instance).toBe(instance);
  expect([...cleanup.volumes].sort()).toEqual([volume(1), volume(2), volume(3)]);
  const codex = JSON.parse((db.prepare("SELECT data FROM runs WHERE id='run_codex'").get() as { data: string }).data);
  expect(codex).toMatchObject({ backend: "builtin", retired_backend: "codex", pending: [], diff: "diff --git a/f b/f", model_id: "cli-codex:default" });
  expect(codex).not.toHaveProperty("runtime_volume");
  expect(codex).not.toHaveProperty("runtime_version");
  expect(JSON.parse((db.prepare("SELECT data FROM runs WHERE id='run_api'").get() as { data: string }).data)).not.toHaveProperty("retired_backend");
  expect(db.prepare("SELECT count(*) AS n FROM events WHERE run_id='run_codex'").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT user_id,run_id,model_id,input,output,cache_read,cost_micros FROM usage").all()).toEqual([{ user_id: "u", run_id: "run_codex", model_id: "cli-codex:default", input: 70, output: 9, cache_read: 4, cost_micros: 0 }]);
  expect(db.prepare("SELECT id,enabled FROM runners ORDER BY id").all()).toEqual([{ id: "runner_api", enabled: 1 }, { id: "runner_codex", enabled: 0 }]);
  // The log says what was removed, never what the credentials were.
  expect(logs).toEqual(["Retired Claude Code and Codex agents: 1 coding-agent sign-ins; 1 saved coding-agent sessions; 1 runtime installations; follow-ups for 1 coding-agent runs (history kept); 1 schedules that used coding-agent models (paused)."]);
  // Sealed credentials and session state are overwritten on disk, not just unlinked.
  db.pragma("wal_checkpoint(TRUNCATE)");
  expect(fileText()).not.toContain(credential);
  expect(fileText()).not.toContain(session);
  // The new account cleanup trigger only names current tables.
  installAccountCleanup(db);
  const runs = new Runs(db, { data: dir, origin: "http://localhost", secret, signup: false, port: 1, dockerBin: "docker", workerImage: "x", maxRuns: 1, runCPUs: 1, runMemoryMB: 512 } as Config, async () => { throw new Error("no workers"); });
  expect(runs.get("run_codex", "u")).toMatchObject({ backend: "builtin", retired_backend: "codex" });
  expect(() => runs.enqueue("run_codex", "u", "more")).toThrow(expect.objectContaining({ code: "retired_backend" }));
  db.close();

  logs.length = 0;
  const again = openStore(dir);
  expect(logs).toEqual([]);
  expect(JSON.parse((again.prepare("SELECT data FROM runs WHERE id='run_codex'").get() as { data: string }).data)).toEqual(codex);
  expect(again.prepare("SELECT count(*) AS n FROM usage").get()).toEqual({ n: 1 });
  again.prepare('DELETE FROM "user" WHERE id=?').run("u");
  expect(again.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 0 });
  again.close();
});

it("removes only this instance's labelled runtime volumes, once, and retries after Docker failures", async () => {
  oldDatabase();
  const db = openStore(dir);
  const ours = { "io.gond-agent.runtime": "true", "io.gond-agent.runtime-instance": instance };
  const volumes = new Map<string, Record<string, string>>([
    [volume(1), ours], [volume(3), ours],
    [volume(4), { "io.gond-agent.runtime": "true", "io.gond-agent.runtime-instance": "fedcba9876543210fedcba98" }],
    [volume(5), {}], ["unrelated", ours],
  ]);
  const calls: string[][] = [];
  let failRemoval = true;
  const docker = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "volume" && args[1] === "ls") {
      const filters = args.filter((_, i) => args[i - 1] === "--filter").map(f => f.slice(6).split("="));
      return [...volumes].filter(([, labels]) => filters.every(([k, v]) => labels[k!] === v)).map(([name]) => name).join("\n");
    }
    if (args[0] === "volume" && args[1] === "rm") {
      if (failRemoval) { failRemoval = false; throw new Error("volume in use"); }
      volumes.delete(args[2]!);
    }
    return "";
  };
  await expect(removeRetiredRuntimes(db, { dockerBin: "docker" }, docker)).rejects.toThrow();
  expect(getSetting(db, "retired-runtime-cleanup")).not.toBeNull();
  expect(await removeRetiredRuntimes(db, { dockerBin: "docker" }, docker)).toEqual([volume(1), volume(3)]);
  expect([...volumes.keys()]).toEqual([volume(4), volume(5), "unrelated"]);
  expect(calls.filter(c => c[0] === "rm")).toContainEqual(["rm", "--force", `${volume(3)}-install`]);
  expect(calls.flat().join(" ")).not.toMatch(new RegExp(`${volume(4)}|${volume(5)}|volume rm unrelated`));
  expect(getSetting(db, "retired-runtime-cleanup")).toBeNull();
  expect(logs.at(-1)).toBe(`Removed retired coding-agent runtime volumes: ${volume(1)}, ${volume(3)}.`);
  calls.length = 0;
  expect(await removeRetiredRuntimes(db, { dockerBin: "docker" }, docker)).toEqual([]);
  expect(calls).toEqual([]);
  db.close();
});

it("retains cleanup records without an instance identity", async () => {
  const db = openStore(dir);
  const pending = { volumes: [volume(1)] };
  db.prepare("INSERT INTO settings(key,value) VALUES('retired-runtime-cleanup',?)").run(JSON.stringify(pending));
  let called = false;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await removeRetiredRuntimes(db, { dockerBin: "docker" }, async () => { called = true; return ""; })).toEqual([]);
    expect(called).toBe(false);
    expect(getSetting(db, "retired-runtime-cleanup")).toEqual(pending);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cleanup record retained"));
  } finally { db.close(); }
});
