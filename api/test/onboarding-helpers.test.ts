import { describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { dockerCommand, remainingTimeout, waitForOnboarding } from "./helpers/onboarding";

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test HTTP address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

describe("onboarding Docker command budgets", () => {
  it("names the command/phase, elapsed time and timeout without argv", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onboarding-command-"));
    const fakeDocker = join(dir, "docker");
    // Real execFile/SIGTERM/classification, with a scaled-down timeout so the unit
    // suite stays cheap. A longer operation must opt into a larger harness cap.
    await writeFile(fakeDocker, `#!${process.execPath}\nsetTimeout(() => process.stdout.write('done'), 300);`, { mode: 0o755 });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const start = performance.now();
      const failure = await dockerCommand(fakeDocker, ["private-script-body"], { label: "docker run browser bootstrap (390px)", timeout: 150 }).catch(error => error);
      expect(failure.message).toMatch(/^docker run browser bootstrap \(390px\) failed after \d+ms \(timeout 150ms\): ClassifiedRetryFailure:/);
      expect(failure.cause).toMatchObject({ class: "timeout", retryable: true });
      expect(failure.message).not.toContain("private-script-body");
      expect(performance.now() - start).toBeLessThan(2_000);
      console.info(`Observed diagnostic: ${failure.message}`);
      await expect(dockerCommand(fakeDocker, [], { label: "docker run browser returning (390px)", timeout: 2_000 }))
        .resolves.toEqual(Buffer.from("done"));
    } finally { log.mockRestore(); await rm(dir, { recursive: true, force: true }); }
  });

  it("does not replay a retryable Docker failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onboarding-no-retry-"));
    const fakeDocker = join(dir, "docker"), calls = join(dir, "calls");
    await writeFile(fakeDocker, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, 'call\\n');process.stderr.write('connection reset');process.exit(1);`, { mode: 0o755 });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failure = await dockerCommand(fakeDocker, [], { label: "docker compose up --force-recreate (390px)", timeout: 2_000 }).catch(error => error);
      expect(failure.cause).toMatchObject({ class: "network", retryable: true });
      expect(await readFile(calls, "utf8")).toBe("call\n");
    } finally { log.mockRestore(); await rm(dir, { recursive: true, force: true }); }
  });

  it("never turns an exhausted workflow budget into execFile's unlimited timeout", async () => {
    expect(remainingTimeout(performance.now() - 1, 10_000)).toBe(0);
    const deadline = performance.now() + 200;
    expect(remainingTimeout(deadline, 10_000)).toBeGreaterThan(0);
    expect(remainingTimeout(deadline, 10_000)).toBeLessThanOrEqual(200);
    await expect(dockerCommand("not-an-executable", [], { label: "docker compose up (390px)", timeout: 0 }))
      .rejects.toThrow(/timeout 0ms.*budget exhausted before command started/);
  });
});

describe("onboarding HTTP/SQLite readiness", () => {
  it("waits through cold HTTP and stale bootstrap state before accepting saved accounts", async () => {
    let health = 0, bootstrap = 0;
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") {
        if (++health === 1) { res.writeHead(503).end(); return; }
        res.end('{"ok":true}');
      } else {
        expect(req.url).toBe("/api/auth/bootstrap");
        res.end(JSON.stringify({ firstAccount: ++bootstrap === 1 }));
      }
    });
    const origin = await listen(server);
    try {
      await waitForOnboarding(origin, false, { timeout: 2_000, interval: 5 });
      expect(health).toBe(3);
      expect(bootstrap).toBe(2);
    } finally { await close(server); }
  });

  it("reports the last real readiness condition within the shared budget", async () => {
    const server = createServer((req, res) => res.end(JSON.stringify(req.url === "/health" ? { ok: true } : { firstAccount: true })));
    const origin = await listen(server);
    try {
      const start = performance.now();
      const failure = await waitForOnboarding(origin, false, { timeout: 600, interval: 1_000 }).catch(error => error);
      expect(failure.message).toMatch(/HTTP\/SQLite readiness failed after \d+ms \(timeout 600ms; firstAccount=false\).*expected firstAccount=false, got true/);
      expect(performance.now() - start).toBeLessThan(2_000);
      console.info(`Observed bounded wait: ${failure.message}`);
    } finally { await close(server); }
  });

  it("bounds stalled HTTP response bodies as well as connection attempts", async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"ok":'); // Never finish the body.
    });
    const origin = await listen(server);
    try {
      const start = performance.now();
      await expect(waitForOnboarding(origin, true, { timeout: 500, requestTimeout: 50, interval: 5 }))
        .rejects.toThrow(/HTTP\/SQLite readiness failed.*timeout 500ms/);
      expect(performance.now() - start).toBeLessThan(2_000);
      expect(requests).toBeGreaterThan(0);
    } finally { await close(server); }
  });
});
