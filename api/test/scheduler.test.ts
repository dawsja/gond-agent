import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/db";
import { Scheduler } from "../src/scheduler";
import type { Runs } from "../src/runs/service";
import { gh } from "../src/github";
vi.mock("../src/github", async original => ({ ...await original<typeof import("../src/github")>(), gh: vi.fn(() => { throw new Error("GitHub must not be polled"); }) }));

describe("scheduled runs without GitHub polling", () => {
  it("bounds retired bookkeeping while preserving live-token retries and pending schedule claims", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gond-agent-retention-")), db = openStore(dir);
    const now = Date.now(), old = now - 31 * 86400000;
    try {
      db.exec('CREATE TABLE "user" (id TEXT PRIMARY KEY); INSERT INTO "user" VALUES (\'owner\');');
      for (const [id, expires, revoked] of [
        ["live", now + 86400000, null], ["expired", old, null],
        ["revoked", now + 86400000, old], ["recent", now - 1000, null],
      ] as const) {
        db.prepare("INSERT INTO mcp_tokens(id,user_id,digest,name,prefix,created_at,expires_at,revoked_at) VALUES(?,'owner',?,?,?, ?,?,?)")
          .run(id, id, id, id, old, expires, revoked);
        db.prepare("INSERT INTO mcp_requests VALUES(?,'retry','start_session','fingerprint','run_fixture','{}')").run(id);
      }
      db.prepare("INSERT INTO runners VALUES('saved','owner',0,123,'{}')").run();
      for (const key of ["schedule:deleted:123", "schedule:saved:123"])
        db.prepare("INSERT INTO occurrences VALUES(?,?)").run(key, old);
      await new Scheduler(db, {} as Runs).tick();
      expect(db.prepare("SELECT token_id FROM mcp_requests").all()).toEqual([{ token_id: "live" }]);
      expect(db.prepare("SELECT id FROM mcp_tokens ORDER BY id").all()).toEqual([{ id: "live" }, { id: "recent" }]);
      expect(db.prepare("SELECT key FROM occurrences").all()).toEqual([{ key: "schedule:saved:123" }]);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("starts due schedules once and ignores retired polling settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gond-agent-scheduler-")), db = openStore(dir);
    vi.stubEnv("GOND_AGENT_REPOSITORIES", "acme/app");
    try {
      db.exec("ALTER TABLE profiles ADD COLUMN issue_runs INTEGER DEFAULT 1; ALTER TABLE profiles ADD COLUMN fix_checks INTEGER DEFAULT 1; INSERT INTO profiles(user_id) VALUES('admin'); INSERT INTO administrators(user_id) VALUES('admin');");
      const data = { name: "Daily task", repo: "acme/app", base_branch: "main", model_id: "auto", prompt: "Check the repo", frequency: "daily", weekdays: [], minute: 60, timezone: "UTC" };
      db.prepare("INSERT INTO runners(id,user_id,enabled,next_run_at,data) VALUES(?,?,?,?,?)").run("runner_fixture", "admin", 1, Date.now() - 1000, JSON.stringify(data));
      const create = vi.fn(async () => ({ id: "run_fixture" }));
      const runs = { list: () => [], create } as unknown as Runs;
      const scheduler = new Scheduler(db, runs);
      await scheduler.tick(); await scheduler.tick();
      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith("admin", expect.objectContaining({source: "runner"}));
      expect(create.mock.calls.length).toBe(1);
      expect(gh).not.toHaveBeenCalled();
      const saved = JSON.parse((db.prepare("SELECT data FROM runners WHERE id='runner_fixture'").get() as { data: string }).data);
      expect(saved.last).toMatchObject({ status: "started", run_id: "run_fixture" });
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); }
  });
});
