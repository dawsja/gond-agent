// Disposable real HTTP/static boundary for the local mocked-UI browser suite.
import { serve } from "@hono/node-server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createAuthentication } from "../src/auth";
import { openStore } from "../src/db";
import { Runs } from "../src/runs/service";
import type { Config } from "../src/config";

export async function startPaginationServer() {
  const data = mkdtempSync(join(tmpdir(), "home-pagination-ui-"));
  const cfg: Config = { data, origin: "http://localhost", secret: "local-pagination-fixture-secret-at-least-32-characters", signup: true, port: 0, dockerBin: "docker", workerImage: "unused", maxRuns: 2, runCPUs: 1, runMemoryMB: 2048 };
  const db = openStore(data);
  const auth = await createAuthentication(db, cfg);
  const runs = new Runs(db, cfg, async () => { throw new Error("No workers in UI fixture"); });
  const instance = createApp(db, cfg, auth, runs);
  const server = serve({ fetch: instance.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await instance.mcp.close(); await instance.githubLogin.close(); await runs.shutdown(); db.close();
      rmSync(data, { recursive: true, force: true });
    },
  };
}
