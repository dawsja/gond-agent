import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { openStore } from "../src/db";
import { createAuthentication } from "../src/auth";
import { createApp } from "../src/app";
import { Runs, type Run } from "../src/runs/service";
import { createToken } from "../src/mcp";
import type { Config } from "../src/config";

let dir: string,
  db: ReturnType<typeof openStore>,
  runs: Runs,
  app: ReturnType<typeof createApp>["app"],
  mcp: ReturnType<typeof createApp>["mcp"];
let owner: string,
  other: string,
  cookie: string,
  token: ReturnType<typeof createToken>;
const clients: Client[] = [];
const servers: ReturnType<typeof serve>[] = [];
const cfg: Config = {
  data: "",
  origin: "http://localhost:8787",
  secret: "mcp-test-secret-longer-than-thirty-two-characters",
  signup: true,
  port: 8787,
  dockerBin: "docker",
  workerImage: "unused",
  maxRuns: 2,
  runCPUs: 2,
  runMemoryMB: 2048,
  idleMs: 10000,
  turnMs: 10000,
};
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gond-mcp-"));
  cfg.data = dir;
  db = openStore(dir);
  const auth = await createAuthentication(db, cfg);
  runs = new Runs(db, cfg, async () => {
    throw new Error("No worker in auth tests");
  });
  ({ app, mcp } = createApp(db, cfg, auth, runs));
  for (const email of ["owner@example.test", "other@example.test"]) {
    const res = await app.request(cfg.origin + "/api/auth/sign-up/email", {
      method: "POST",
      headers: { origin: cfg.origin, "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "test-password-long-enough",
        name: "Test",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    if (!owner) {
      owner = body.user.id;
      cookie = res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    } else other = body.user.id;
  }
  token = createToken(db, owner, "Test agent");
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await mcp.close();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (s) =>
          new Promise<void>((resolve, reject) =>
            s.close((e) => (e ? reject(e) : resolve())),
          ),
      ),
  );
  await runs.shutdown();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  owner = "";
  other = "";
  vi.restoreAllMocks();
});
function seed(user = owner, runId = "run_test") {
  const now = Date.now();
  const r = {
    id: runId,
    user_id: user,
    repo: "acme/app",
    title: "Browser run",
    status: "ready",
    phase: "idle",
    source: "web",
    model_id: "model",
    backend: undefined,
    summary: {},
    pending: [],
    diff: "x".repeat(65000),
    created_at: now,
    updated_at: now,
    runtime_volume: "private-volume",
    runtime_version: "private-version",
  } as unknown as Run;
  db.prepare(
    "INSERT INTO runs(id,user_id,repo,status,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?)",
  ).run(r.id, user, r.repo, r.status, now, now, JSON.stringify(r));
  return r;
}
async function connect(legacy = false) {
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  servers.push(server);
  if (!server.listening)
    await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const client = new Client({ name: "integration", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token.token}` } } },
    ),
    legacy ? { prior: { kind: "legacy" } } : undefined,
  );
  return client;
}
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { result, body: JSON.parse(content[0].text) };
}
async function withWaitingReads(client: Client, sessionId: string, afterSeq: number, action: () => void | Promise<void>, count = 4) {
  const waits = Array.from({ length: count }, () => call(client, "read_session_events", {
    session_id: sessionId, after_seq: afterSeq, wait_seconds: 30,
  }));
  let results: Awaited<ReturnType<typeof call>>[] = [];
  try {
    // The public capacity response confirms the reads have entered their wait;
    // a fixed sleep can revoke a token before a slow request even arrives.
    await vi.waitFor(async () => {
      const blocked = await app.request(cfg.origin + "/mcp", {
        headers: { Authorization: `Bearer ${token.token}` },
      });
      expect(blocked.status).toBe(429);
    }, { timeout: 2000, interval: 50 });
    await action();
  } finally {
    runs.append(sessionId, { type: "text", text: "Release waiting reads" });
    results = await Promise.all(waits);
  }
  return results;
}
it("supports the stateless 2025 HTTP client", async () => {
  seed();
  const client = await connect(true);
  expect(
    (await call(client, "get_session", { session_id: "run_test" })).body.id,
  ).toBe("run_test");
});
it.each([false, true])(
  "bounds outstanding tool calls for legacy=%s",
  async (legacy) => {
    seed();
    const client = await connect(legacy);
    await withWaitingReads(client, "run_test", 0, () => {});
    expect(
      (await call(client, "get_session", { session_id: "run_test" })).body.id,
    ).toBe("run_test");
  },
);
it("preserves token revocation across SQLite reopen", async () => {
  db.prepare("UPDATE mcp_tokens SET revoked_at=? WHERE id=?").run(
    Date.now(),
    token.id,
  );
  await mcp.close();
  db.close();
  db = openStore(dir);
  runs = new Runs(db, cfg, async () => {
    throw new Error("No worker");
  });
  const auth = await createAuthentication(db, cfg);
  ({ app, mcp } = createApp(db, cfg, auth, runs));
  expect(
    (
      await app.request(cfg.origin + "/mcp", {
        headers: { Authorization: `Bearer ${token.token}` },
      })
    ).status,
  ).toBe(401);
  expect(
    db
      .prepare("SELECT count(*) AS n FROM mcp_tokens WHERE user_id=?")
      .get(owner),
  ).toEqual({ n: 1 });
});
it("negotiates with the official HTTP client and reads only owned browser runs", async () => {
  seed();
  seed(other, "other_run");
  const client = await connect();
  const tools = await client.listTools();
  // This is the public capability boundary, rather than an arbitrary tool count:
  // adding a shell or an administrator tool must require an intentional review.
  expect(tools.tools.map(t => t.name).sort()).toEqual([
    "list_models", "list_repositories", "start_session", "list_sessions", "get_session",
    "read_session_events", "read_session_event", "get_session_diff", "send_session_message",
    "stop_session", "open_session_pull_request",
  ].sort());
  const list = await call(client, "list_sessions");
  expect(list.body.sessions.map((r: Run) => r.id)).toEqual(["run_test"]);
  expect(JSON.stringify(list)).not.toContain("private-volume");
  expect(
    (await call(client, "get_session", { session_id: "other_run" })).body.error,
  ).toBe("not_found");
  expect(
    (await call(client, "get_session_diff", { session_id: "other_run" })).body
      .error,
  ).toBe("not_found");
  expect(
    (await call(client, "read_session_events", { session_id: "other_run" }))
      .body.error,
  ).toBe("not_found");
  const first = await call(client, "get_session_diff", {
    session_id: "run_test",
  });
  expect(first.body.diff).toHaveLength(32000);
  expect(first.body.next_cursor).toBe(32000);
  const last = await call(client, "get_session_diff", {
    session_id: "run_test",
    cursor: 64000,
  });
  expect(last.body.diff).toHaveLength(1000);
  expect(last.body.next_cursor).toBe(null);
});
it("rejects missing, expired, revoked and cross-origin tokens without cookie fallback", async () => {
  const req = (headers: Record<string, string>) =>
    app.request(cfg.origin + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    });
  expect((await req({ cookie })).status).toBe(401);
  expect(
    (
      await req({
        authorization: `Bearer ${token.token}`,
        origin: "https://other.test",
      })
    ).status,
  ).toBe(403);
  db.prepare("UPDATE mcp_tokens SET expires_at=0 WHERE id=?").run(token.id);
  expect((await req({ authorization: `Bearer ${token.token}` })).status).toBe(
    401,
  );
  db.prepare("UPDATE mcp_tokens SET expires_at=?,revoked_at=1 WHERE id=?").run(
    Date.now() + 10000,
    token.id,
  );
  expect((await req({ authorization: `Bearer ${token.token}` })).status).toBe(
    401,
  );
  expect(
    JSON.stringify(db.prepare("SELECT * FROM mcp_tokens").all()),
  ).not.toContain(token.token);
});
it("creates tokens once, hides secrets in listings, enforces CSRF and cascades account deletion", async () => {
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    origin = cfg.origin,
  ) =>
    app.request(cfg.origin + path, {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  expect(
    (
      await request(
        "/api/v1/mcp/tokens",
        "POST",
        { name: "Bad" },
        "https://other.test",
      )
    ).status,
  ).toBe(403);
  const created = await request("/api/v1/mcp/tokens", "POST", { name: "New" });
  expect((await request("/api/v1/mcp/tokens", "POST", null)).status).toBe(400);
  expect(created.status).toBe(201);
  const value = await created.json();
  expect(value.token).toMatch(/^gond_mcp_/);
  const listing = await request("/api/v1/mcp/tokens");
  expect(listing.headers.get("cache-control")).toBe("no-store");
  expect(await listing.text()).not.toContain(value.token);
  const foreign = createToken(db, other, "Other");
  expect(
    (await request(`/api/v1/mcp/tokens/${foreign.id}`, "DELETE")).status,
  ).toBe(404);
  expect(
    (await request(`/api/v1/mcp/tokens/${value.id}`, "DELETE")).status,
  ).toBe(200);
  db.prepare('DELETE FROM "user" WHERE id=?').run(owner);
  expect(
    db.prepare("SELECT 1 FROM mcp_tokens WHERE user_id=?").get(owner),
  ).toBeUndefined();
});
it("deduplicates concurrent starts and rejects changed retry arguments and backend switches", async () => {
  seed();
  const client = await connect();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(runs, "create").mockImplementation(
    async (user, input, attribution) => {
      await pending;
      return seed(user, attribution!.id);
    },
  );
  const args = {
    request_id: "create-1",
    repo: "acme/app",
    model: "model",
    prompt: "Fix this",
  };
  const starts = Promise.all([
    call(client, "start_session", args),
    call(client, "start_session", args),
  ]);
  let results: Awaited<ReturnType<typeof call>>[] = [];
  try {
    // Two waiting reads fill the remaining slots, proving both starts have
    // entered the server before the first creation is allowed to finish.
    await withWaitingReads(client, "run_test", 0, () => {}, 2);
  } finally {
    release();
    results = await starts;
  }
  const [a, b] = results;
  expect(a.body.id).toBe(b.body.id);
  expect(runs.create).toHaveBeenCalledTimes(1);
  expect(
    (await call(client, "start_session", { ...args, prompt: "Different" })).body
      .error,
  ).toBe("request_conflict");
  const backend = vi.spyOn(runs, "resolveSelection").mockResolvedValue({
    id: "cli",
    backend: "codex",
    upstream_id: "model",
    capabilities: { reasoning: "effort" },
  } as never);
  expect(
    (
      await call(client, "send_session_message", {
        session_id: "run_test",
        text: "Continue",
        request_id: "message-2",
        model: "cli",
      })
    ).body.error,
  ).toBe("invalid_backend");
  expect(backend).toHaveBeenCalled();
});
it("paginates events, reports large events and releases waiting reads on revoke", async () => {
  seed();
  const first = runs.append("run_test", { type: "text", text: "hello" });
  runs.append("run_test", { type: "text", text: "world" });
  const client = await connect();
  const page = await call(client, "read_session_events", {
    session_id: "run_test",
    limit: 1,
  });
  expect(page.body.next_cursor).toBe(first.seq);
  expect(page.body.has_more).toBe(true);
  const huge = runs.append("run_test", {
    type: "text",
    text: "a".repeat(150000),
  });
  const large = await call(client, "read_session_events", {
    session_id: "run_test",
    after_seq: huge.seq - 1,
  });
  expect(large.body.large_event.seq).toBe(huge.seq);
  const chunk = await call(client, "read_session_event", {
    session_id: "run_test",
    seq: huge.seq,
  });
  expect(chunk.body.text).toHaveLength(32000);
  const waiting = await withWaitingReads(client, "run_test", huge.seq, () => {
    db.prepare("UPDATE mcp_tokens SET revoked_at=? WHERE id=?").run(Date.now(), token.id);
  });
  for (const result of waiting) expect(result.body.error).toBe("invalid_token");
});
