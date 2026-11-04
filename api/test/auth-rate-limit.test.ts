import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthentication } from "../src/auth";
import type { Config } from "../src/config";
import { openStore } from "../src/db";

it("preserves exhausted per-client session request budgets across a database reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gond-agent-auth-limit-"));
  const cfg: Config = { data: dir, origin: "http://localhost:8787", secret: "test-only-auth-rate-limit-secret-at-least-32-characters", signup: false, port: 8787, dockerBin: "docker", workerImage: "unused", maxRuns: 1, runCPUs: 1, runMemoryMB: 512 };
  let db = openStore(dir);
  try {
    let auth = await createAuthentication(db, cfg);
    // No elapsed-time dependency: consume a real limiter bucket, not mocked responses.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const session = (ip = "192.0.2.1") => auth.current.handler(new Request(cfg.origin + "/api/auth/get-session", {
      headers: { "x-gond-agent-client-ip": ip },
    }));
    for (let i = 0; i < 60; i++) expect((await session()).status).toBe(200);
    expect((await session()).status).toBe(429);
    db.close();
    db = openStore(dir);
    auth = await createAuthentication(db, cfg);
    const limited = await session();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("x-retry-after"))).toBeGreaterThan(0);
    expect((await session("192.0.2.2")).status).toBe(200);
  } finally {
    vi.restoreAllMocks();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
