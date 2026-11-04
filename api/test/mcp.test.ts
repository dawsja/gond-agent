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
import { createAuthentication, seal } from "../src/auth";
import { createApp } from "../src/app";
import { Runs, type Run } from "../src/runs/service";
import { emptySummary, fold, planState } from "../src/runs/fold";
import { createToken } from "../src/mcp";
import type { Config } from "../src/config";
import { saveProviderSettings } from "../src/providers";
import { unverifiedDescription } from "./fixtures/evidence";

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
function seedFollowUpRun() {
  const r = seed();
  r.model_id = "local:model";
  db.prepare("UPDATE runs SET data=? WHERE id=?").run(JSON.stringify(r), r.id);
  db.prepare("INSERT INTO github_connections(user_id,token,connected_at) VALUES(?,?,?)")
    .run(owner, seal(cfg.secret, "publication-fixture-token"), Date.now());
  saveProviderSettings(db, cfg.secret, {
    connections: [{id:"local",name:"Local",format:"openai",baseURL:"http://127.0.0.1:8000/v1",apiKey:"fixture-key",discover:false,models:[{id:"model",name:"Model",contextWindow:128000,maxOutput:8192,reasoning:"none",images:true}]}],
    defaultModel:"local:model",
  });
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
  const run = runs.get(sessionId, owner);
  run.status = "working";
  db.prepare("UPDATE runs SET status=?,data=? WHERE id=?").run(run.status, JSON.stringify(run), sessionId);
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
    "stop_session", "close_session", "open_session_pull_request",
  ].sort());
  for (const name of ["get_session", "read_session_events", "send_session_message"]) {
    const description = tools.tools.find(tool => tool.name === name)!.description!;
    expect(description).toContain("done true");
    expect(description).toContain("resume tool");
    if (name !== "send_session_message") expect(description).toContain("send_session_message");
  }
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
it("advertises optional publication fields through the MCP tool schemas", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const start = tools.find(t => t.name === "start_session")!.inputSchema;
  const send = tools.find(t => t.name === "send_session_message")!.inputSchema;
  expect(start.properties).toMatchObject({
    title: { type: "string", maxLength: 120 },
    branch: { type: "string", pattern: expect.any(String) },
    pr_body: { type: "string", maxLength: 20000 },
  });
  for (const field of ["title", "branch", "pr_body"])
    expect(start.required).not.toContain(field);
  expect(send.properties).toMatchObject({ pr_body: { type: "string", maxLength: 20000 } });
  expect(send.required).not.toContain("pr_body");
  expect(send.properties).not.toHaveProperty("title");
  expect(send.properties).not.toHaveProperty("branch");
  expect(send.additionalProperties).toBe(false);
});
it("rejects invalid publication fields at the MCP schema boundary", async () => {
  seed();
  const create = vi.spyOn(runs, "create");
  const enqueue = vi.spyOn(runs, "enqueue");
  const client = await connect();
  const start = { request_id: "invalid-start", repo: "acme/app", model: "model", prompt: "Fix this" };
  for (const fields of [
    { title: "Two\nlines" },
    { title: "a".repeat(121) },
    { branch: "main" },
    { branch: "feat/../escape" },
    { pr_body: "b".repeat(20001) },
    { pr_body: 42 },
  ]) {
    const result = await client.callTool({ name: "start_session", arguments: { ...start, ...fields } });
    expect(result.isError).toBe(true);
  }
  for (const fields of [
    { pr_body: "b".repeat(20001) },
    { pr_body: 42 },
    { title: "Cannot rename a session" },
  ]) {
    const result = await client.callTool({
      name: "send_session_message",
      arguments: { session_id: "run_test", request_id: "invalid-send", text: "Continue", ...fields },
    });
    expect(result.isError).toBe(true);
  }
  expect(create).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});
it("forwards a valid title, branch and explicit empty PR body when starting a session", async () => {
  const r = seed();
  Object.assign(r, { title: "Fix login", branch: "fix/login", pr_body: "", prompt: "Fix this" });
  const create = vi.spyOn(runs, "create").mockResolvedValue(r);
  const client = await connect();
  const args = {
    request_id: "publication-start", repo: r.repo, model: r.model_id, prompt: r.prompt,
    title: r.title, branch: r.branch, pr_body: "",
  };
  const { result, body } = await call(client, "start_session", args);
  expect(result.isError).not.toBe(true);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0].slice(0, 2)).toEqual([owner, { ...args, source: "mcp" }]);
  expect(body).toMatchObject({ id: r.id, title: r.title, branch: r.branch, pr_body: "", description: unverifiedDescription("") });
});
it("forwards follow-up PR body overrides to enqueue", async () => {
  const r = seedFollowUpRun();
  const enqueue = vi.spyOn(runs, "enqueue").mockImplementation(() => {});
  const client = await connect();
  const { result, body } = await call(client, "send_session_message", {
    session_id: r.id, request_id: "publication-send", text: "Continue", pr_body: "Updated description",
  });
  expect(result.isError).not.toBe(true);
  expect(body).toEqual({ accepted: true, session_id: r.id });
  expect(enqueue).toHaveBeenCalledExactlyOnceWith(r.id, owner, "Continue", [], undefined, undefined, `${token.id}:publication-send`, "Updated description");
});
it("persists follow-up PR bodies, preserves omitted overrides and exposes the description", async () => {
  const r = seedFollowUpRun();
  // Exercise real enqueue and SQLite persistence without starting a worker.
  vi.spyOn(runs as unknown as { boot(id: string): Promise<void> }, "boot").mockResolvedValue(undefined);
  const client = await connect();
  for (const [index, fields, expected] of [
    [0, { pr_body: "Updated description" }, "Updated description"],
    [1, {}, "Updated description"],
    [2, { pr_body: "" }, ""],
  ] as const) {
    const { result, body } = await call(client, "send_session_message", {
      session_id: r.id, request_id: `persist-body-${index}`, text: "Continue", ...fields,
    });
    expect(result.isError).not.toBe(true);
    expect(body.accepted).toBe(true);
    const stored = db.prepare("SELECT data FROM runs WHERE id=?").get(r.id) as { data: string };
    expect(JSON.parse(stored.data).pr_body).toBe(expected);
    expect((await call(client, "get_session", { session_id: r.id })).body).toMatchObject({ pr_body: expected, description: unverifiedDescription(expected) });
    expect((await call(client, "list_sessions")).body.sessions[0]).toMatchObject({ pr_body: expected, description: unverifiedDescription(expected) });
  }
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
    async (user, _input, attribution) => {
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
  // Only the built-in runner exists: another backend is refused, and a run created by a
  // removed coding agent stays readable but takes no follow-ups.
  vi.mocked(runs.create).mockRestore();
  expect(
    (await call(client, "start_session", { ...args, request_id: "create-2", backend: "codex" })).body.error,
  ).toBe("invalid_backend");
  const retired = seed(owner, "run_retired");
  db.prepare("UPDATE runs SET data=json_set(data,'$.backend','codex') WHERE id=?").run(retired.id);
  expect((await call(client, "get_session", { session_id: retired.id })).body).toMatchObject({ backend: "builtin", retired_backend: "codex" });
  expect(
    (
      await call(client, "send_session_message", {
        session_id: retired.id,
        text: "Continue",
        request_id: "message-2",
        model: "model",
      })
    ).body.error,
  ).toBe("retired_backend");
});
it("paginates events, reports large events and releases waiting reads on revoke", async () => {
  seed();
  const first = runs.append("run_test", { type: "text", text: "hello" })!;
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
  })!;
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


it.each([
  ["queued", "queued", false], ["working", "working", false],
  ["ready", "done", true], ["failed", "failed", true],
  ["stopped", "stopped", true], ["merged", "merged", true],
] as const)("exposes completion consistently for %s", async (status, state, done) => {
  const r = seed();
  r.status = status;
  r.pr_url = "https://github.com/acme/app/pull/42";
  r.error = status === "failed" ? "Model unavailable" : null;
  db.prepare("UPDATE runs SET status=?,data=? WHERE id=?").run(status, JSON.stringify(r), r.id);
  const client = await connect();
  const detail = (await call(client, "get_session", {session_id:r.id})).body;
  const listed = (await call(client, "list_sessions")).body.sessions[0];
  const events = (await call(client, "read_session_events", {session_id:r.id, wait_seconds:done ? 30 : 0})).body;
  for (const result of [detail, listed, events]) {
    expect(result).toMatchObject({state, done, waiting_for_input:false, asking_question:false, question:null, pr_url:r.pr_url, last_error:r.error});
  }
  if (done) expect(events.return_reason).toBe("done");
});

it("wakes a waiting read on completion without a transcript event", async () => {
  const r = seed(); r.status = "working";
  db.prepare("UPDATE runs SET status=?,data=? WHERE id=?").run(r.status, JSON.stringify(r), r.id);
  const client = await connect();
  const waiting = call(client, "read_session_events", {session_id:r.id, wait_seconds:30});
  const timer = setTimeout(() => {
    r.status = "ready";
    db.prepare("UPDATE runs SET status=?,data=? WHERE id=?").run(r.status, JSON.stringify(r), r.id);
  }, 300);
  try { expect((await waiting).body).toMatchObject({events:[], state:"done", done:true, return_reason:"done", pr_url:null}); }
  finally { clearTimeout(timer); }
});

it("exposes live queue positions only on the token owner's sessions", async () => {
  const r = seed(); r.status = "queued";
  seed(other, "foreign");
  db.prepare("UPDATE runs SET status=?,data=? WHERE id=?").run(r.status, JSON.stringify(r), r.id);
  // Queue metadata is computed on reads, not persisted with the run.
  const get = runs.get.bind(runs);
  let queued = true;
  vi.spyOn(runs, "get").mockImplementation((id, user) => {
    const run = get(id, user);
    return queued && id === r.id ? { ...run, queue_position: 2, queue_length: 3 } : run;
  });
  const client = await connect();
  const detail = (await call(client, "get_session", {session_id:r.id})).body;
  const list = (await call(client, "list_sessions")).body.sessions;
  const events = (await call(client, "read_session_events", {session_id:r.id})).body;
  expect(list.map((session: {id:string}) => session.id)).toEqual([r.id]);
  for (const result of [detail, list[0], events]) {
    expect(result).toMatchObject({state:"queued", done:false, queue_position:2, queue_length:3});
  }
  for (const name of ["get_session", "read_session_events"]) {
    expect((await call(client, name, {session_id:"foreign"})).body).toMatchObject({error:"not_found"});
  }
  queued = false;
  r.status = "working";
  db.prepare("UPDATE runs SET status=?,data=? WHERE id=?").run(r.status, JSON.stringify(r), r.id);
  const resumed = (await call(client, "get_session", {session_id:r.id})).body;
  expect(resumed.state).toBe("working");
  expect(resumed).not.toHaveProperty("queue_position");
  expect(resumed).not.toHaveProperty("queue_length");
});

it("reports a pending question without calling it done", async () => {
  const r = seed(); r.status = "working";
  r.summary = {...r.summary, question:{request_id:"q1",question:"Which branch?"}};
  db.prepare("UPDATE runs SET status=?,data=? WHERE id=?").run(r.status, JSON.stringify(r), r.id);
  const client = await connect();
  for (const name of ["get_session", "read_session_events"]) {
    expect((await call(client, name, {session_id:r.id, ...(name === "read_session_events" ? {wait_seconds:30} : {})})).body).toMatchObject({state:"waiting_for_input", done:false, waiting_for_input:true, asking_question:true, question:"Which branch?"});
  }
});

it("closes only owned idle sessions while preserving readable history", async () => {
  seed(); seed(other, "foreign");
  const client = await connect();
  expect((await call(client, "close_session", {session_id:"foreign"})).body.error).toBe("not_found");
  expect((await call(client, "close_session", {session_id:"run_test"})).body).toEqual({closed:true});
  expect((await call(client, "get_session", {session_id:"run_test"})).body.id).toBe("run_test");
  const r = runs.get("run_test", owner); r.status = "working";
  db.prepare("UPDATE runs SET status=?,data=? WHERE id=?").run(r.status, JSON.stringify(r), r.id);
  expect((await call(client, "close_session", {session_id:r.id})).body.error).toBe("workspace_busy");
});

it("bounds plan state, ignores subagent plans and preserves completion with pending steps", async () => {
  const items = [{text:"Read",status:"done"}, {text:"Implement",status:"in_progress"}, ...Array.from({length:60}, () => ({text:"x".repeat(400),status:"pending"}))];
  const summary = fold(emptySummary(), {type:"todos",agent_id:"main",items});
  expect(summary).toMatchObject({plan_total:50,plan_done:1,current_step:{text:"Implement",index:2}});
  expect(summary.plan_steps[49].text).toHaveLength(300);
  expect(fold(summary, {type:"todos",agent_id:"helper",items:[]})).toBe(summary);
  expect(planState([{text:"bad",status:"unknown"},null])).toMatchObject({plan_total:0,current_step:null});
  const r = seed();
  runs.append(r.id, {type:"todos",agent_id:"main",items});
  // A fresh service and a legacy summary must reconstruct the plan from SQLite events.
  const reopenedDb = openStore(dir);
  const reopened = new Runs(reopenedDb, cfg, async () => { throw new Error("No worker expected"); });
  expect(reopened.get(r.id).summary.plan_steps).toEqual(summary.plan_steps);
  await reopened.recover();
  await reopened.shutdown();
  reopenedDb.close();
  const client = await connect();
  for (const name of ["get_session", "read_session_events"]) {
    const result = (await call(client, name, {session_id:r.id})).body;
    expect(result).toMatchObject({done:true,state:"done",plan_total:50,plan_done:1,current_step:{text:"Implement",index:2}});
    expect(result.plan_steps).toEqual(summary.plan_steps);
  }
  expect(runs.list(owner)[0].plan_total).toBe(50);
});

it("persists an empty legacy plan marker instead of querying events on every read", () => {
  const r = seed();
  const prepare = vi.spyOn(db, "prepare");
  for (let i = 0; i < 3; i++) {
    expect(runs.get(r.id).summary.plan_steps).toEqual([]);
    expect(runs.list(owner)[0].summary.plan_steps).toEqual([]);
  }
  expect(prepare.mock.calls.filter(([sql]) => sql.includes("json_extract(data,'$.type')='todos'"))).toHaveLength(1);
  const stored = db.prepare("SELECT data FROM runs WHERE id=?").get(r.id) as { data: string };
  expect(JSON.parse(stored.data).summary.plan_steps).toEqual([]);
});

it("uses only the MCP token owner's GitHub connection, never another account's", async () => {
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR"]) vi.stubEnv(key, "");
  try {
    db.prepare("INSERT INTO github_connections(user_id,token,connected_at) VALUES(?,?,?)").run(other, seal(cfg.secret, "other-users-token"), Date.now());
    const client = await connect();
    const denied = await call(client, "list_repositories");
    expect(denied.result.isError).toBe(true);
    expect(JSON.stringify(denied.body)).toContain("Connect your GitHub account in Plugins > GitHub");
    expect(JSON.stringify(denied.body)).not.toContain("other-users-token");
  } finally { vi.unstubAllEnvs(); }
});
