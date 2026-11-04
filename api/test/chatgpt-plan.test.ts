import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getSetting, openStore } from "../src/db";
import { createAuthentication, seal, unseal } from "../src/auth";
import { createApp } from "../src/app";
import { Runs } from "../src/runs/service";
import { createToken } from "../src/mcp";
import { saveProviderSettings } from "../src/providers";
import { modelResponse } from "../src/responses";
import { MAX_PENDING_LOGINS, SubscriptionAccounts } from "../src/subscriptions/accounts";
import { ChatGPTProvider, CHATGPT_REDIRECT } from "../src/subscriptions/chatgpt";
import type { Tokens } from "../src/subscriptions/provider";
import type { Config } from "../src/config";
import { OpenAIMock } from "./fixtures/openai-mock";

vi.mock("../src/github", async (original) => ({
  ...await original<typeof import("../src/github")>(),
  gh: vi.fn(async () => ({ default_branch: "main" })),
  checkout: vi.fn(async () => ({ cwd: "/fake", archive: Buffer.from("repo") })),
  git: vi.fn(async () => Buffer.from("a".repeat(40))),
}));

const secret = "chatgpt-plan-test-secret-longer-than-32-characters";
let dir: string, db: ReturnType<typeof openStore>, mock: OpenAIMock, runs: Runs;
let app: ReturnType<typeof createApp>["app"], mcp: ReturnType<typeof createApp>["mcp"];
let cookie: string, user: string, logs: string[];
let rpcs: { method: string; args: unknown }[], handler: ((req: Request) => Promise<Response>) | undefined;
const servers: ReturnType<typeof serve>[] = [];
const cfg = (): Config => ({ data: dir, origin: "http://localhost:8787", secret, signup: true, port: 8787, dockerBin: "docker", workerImage: "unused", maxRuns: 4, runCPUs: 2, runMemoryMB: 2048 });

const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", who = cookie) =>
  app.request("http://localhost:8787" + path, {
    method, headers: { origin: "http://localhost:8787", cookie: who, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function signUp(email: string) {
  const res = await call("/api/auth/sign-up/email", { email, password: "correct horse battery staple", name: "Plan user" }, "POST", "");
  expect(res.status).toBe(200);
  return { cookie: res.headers.getSetCookie().map(c => c.split(";")[0]).join("; "), id: (await res.json()).user.id as string };
}
/** The person approves in their own browser; the loopback page fails to load and they copy its address. */
async function approve(url: string) {
  const response = await fetch(url, { redirect: "manual" });
  expect(response.status, await response.clone().text()).toBe(302);
  return response.headers.get("location")!;
}
async function signIn(accountId?: string) {
  const start = await (await call("/api/v1/subscriptions/chatgpt/login", accountId ? { account_id: accountId } : {})).json();
  const pasted = await approve(start.url);
  const done = await call("/api/v1/subscriptions/chatgpt/callback", { url: pasted });
  return { start, pasted, done, body: await done.json() };
}
const account = () => db.prepare("SELECT * FROM subscription_accounts ORDER BY created_at").get() as Record<string, any>;
const tokensOf = (row: Record<string, any>) => JSON.parse(unseal(secret, row.credentials)) as Tokens;
const runnerRequest = (model: string, extra: Record<string, unknown> = {}) => new Request("http://worker/v1/responses", { method: "POST", body: JSON.stringify({
  model, system: "You are the built-in runner.", max_output_tokens: 4000, metadata: { session_id: "s1" }, reasoning: { effort: "high" },
  messages: [{ role: "user", content: [{ type: "text", text: "Read the README" }] }],
  tools: [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }], ...extra,
}) });
const relay = (model: string, extra?: Record<string, unknown>) => modelResponse(db, secret, user, "run_relay", runnerRequest(model, extra), runs.access);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gond-chatgpt-"));
  db = openStore(dir);
  mock = await new OpenAIMock().start();
  logs = [];
  for (const level of ["log", "error", "warn", "info"] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(a => typeof a === "string" ? a : JSON.stringify(a, Object.getOwnPropertyNames(a ?? {}))).join(" ")); });
  rpcs = []; handler = undefined;
  const subscriptions = new SubscriptionAccounts(db, secret, [new ChatGPTProvider({ issuer: mock.url, baseURL: `${mock.url}/v1` })]);
  runs = new Runs(db, cfg(), async (_id, modelHandler) => {
    handler = modelHandler;
    return { destroy: async () => {}, rpc: async (method: string, args?: Record<string, unknown>) => {
      rpcs.push({ method, args });
      if (method === "export_state") return { state: {} } as never; // Legacy worker: no evidence key.
      return (method === "events" ? { events: [], alive: true } : true) as never;
    } };
  }, subscriptions);
  ({ app, mcp } = createApp(db, cfg(), await createAuthentication(db, cfg()), runs));
  ({ cookie, id: user } = await signUp("plan@example.test"));
  db.prepare("INSERT INTO github_connections(user_id,token,connected_at) VALUES(?,?,?)").run(user, seal(secret, "fixture-plan-github-token"), Date.now());
});

afterEach(async () => {
  // Structural guard: no issued token, ID token or authorization code ever reaches a log line.
  const output = logs.join("\n");
  for (const value of mock.issued) expect(output).not.toContain(value);
  await mcp.close();
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  await runs.shutdown();
  await mock.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Sign in with ChatGPT by pasting the loopback address", () => {
  it("registers dynamically, verifies the ID token and keeps tokens sealed on the server", async () => {
    const { start, pasted, done, body } = await signIn();
    const url = new URL(start.url), q = url.searchParams;
    expect(`${url.origin}${url.pathname}`).toBe(`${mock.url}/api/accounts/authorize`);
    expect(Object.fromEntries([...q].filter(([k]) => !["state", "nonce", "code_challenge"].includes(k)))).toEqual({
      client_id: "dynamic_agent_client", agent_name_hint: "Gond Agent", ext_agent_host_id: getSetting(db, "subscription-host"),
      response_type: "code", redirect_uri: "http://127.0.0.1:1455/auth/callback",
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct", resource: "https://api.openai.com/v1", code_challenge_method: "S256",
    });
    expect(q.get("ext_agent_host_id")).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(pasted.startsWith(`${CHATGPT_REDIRECT}?`)).toBe(true);
    expect(done.status).toBe(200);
    expect(body).toMatchObject({ account: { provider: "chatgpt", email: "person@example.test", status: "active", plan: "enabled", label: "ChatGPT · person@example.test" }, welcome: true });
    const exchange = mock.calls.find(c => c.path === "/api/accounts/oauth/token")!.form!;
    expect(exchange).toMatchObject({ grant_type: "authorization_code", redirect_uri: CHATGPT_REDIRECT, resource: "https://api.openai.com/v1" });
    expect(exchange.client_id).toMatch(/^oaiapp_/);
    expect(exchange.client_secret).toBeUndefined();
    const row = account();
    expect(row).toMatchObject({ user_id: user, client_id: exchange.client_id, subject: "user-sub-1", status: "active", plan: "enabled" });
    expect(tokensOf(row).scopes).toContain("chatgpt.tokens.use.direct");
    // Browsers get account metadata only; the database holds sealed tokens only.
    const listed = await (await call("/api/v1/subscriptions")).text();
    db.pragma("wal_checkpoint(TRUNCATE)");
    const stored = readFileSync(join(dir, "gond-agent.sqlite")).toString("latin1") + (existsSync(join(dir, "gond-agent.sqlite-wal")) ? readFileSync(join(dir, "gond-agent.sqlite-wal")).toString("latin1") : "");
    for (const value of mock.issued.filter(v => !v.startsWith("oaiapp_"))) {
      expect(listed).not.toContain(value);
      expect(stored).not.toContain(value);
    }
    expect(JSON.parse(listed)).toMatchObject({ pending: null, welcome: true });
    expect((await call("/api/v1/subscriptions/welcome", {})).status).toBe(200);
    expect((await (await call("/api/v1/subscriptions")).json()).welcome).toBe(false);
    expect((await (await call("/api/v1/me")).json()).setup_required).toBe(false);
  });

  it("accepts only the fixed loopback callback, never requests it, and binds the attempt to its session", async () => {
    const hits: string[] = [];
    const bait = createServer((req, res) => { hits.push(req.url ?? ""); res.end(); });
    await new Promise<void>(resolve => bait.listen(0, "127.0.0.1", resolve));
    const port = (bait.address() as { port: number }).port;
    try {
      const start = await (await call("/api/v1/subscriptions/chatgpt/login", {})).json();
      const pasted = new URL(await approve(start.url));
      const variants = [
        `https://evil.example/auth/callback${pasted.search}`,
        `http://localhost:1455/auth/callback${pasted.search}`,
        `http://127.0.0.1:1455/callback${pasted.search}`,
        `http://127.0.0.1:${port}/auth/callback${pasted.search}`,
        `http://user:pass@127.0.0.1:1455/auth/callback${pasted.search}`,
        `${pasted}&state=again`,
        "not a url",
      ];
      for (const url of variants) {
        const res = await call("/api/v1/subscriptions/chatgpt/callback", { url });
        expect(res.status, url).toBe(400);
        expect((await res.json()).error.code).toBe("chatgpt_callback");
      }
      const stale = new URL(pasted); stale.searchParams.set("state", "someone-else");
      expect((await (await call("/api/v1/subscriptions/chatgpt/callback", { url: stale.toString() })).json()).error.code).toBe("chatgpt_state");
      // Another browser session of the same person can't finish this attempt.
      const other = await call("/api/auth/sign-in/email", { email: "plan@example.test", password: "correct horse battery staple" }, "POST", "");
      const otherCookie = other.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
      expect((await call("/api/v1/subscriptions/chatgpt/callback", { url: pasted.toString() }, "POST", otherCookie)).status).toBe(409);
      expect(hits).toEqual([]);
      expect(mock.count("/api/accounts/oauth/token")).toBe(0);
      expect((await (await call("/api/v1/subscriptions")).json()).pending).toMatchObject({ provider: "chatgpt" });
      expect((await call("/api/v1/subscriptions/chatgpt/callback", { url: pasted.toString() })).status).toBe(200);
      // A code works once; the attempt is gone afterwards.
      expect((await call("/api/v1/subscriptions/chatgpt/callback", { url: pasted.toString() })).status).toBe(409);
    } finally { await new Promise<void>(resolve => bait.close(() => resolve())); }
  });

  it("bounds pending sign-ins and sweeps expired sessions on new login", () => {
    for (let i = 0; i < MAX_PENDING_LOGINS; i++) runs.subscriptions.begin(user, `session-${i}`, "chatgpt");
    expect(() => runs.subscriptions.begin(user, "overflow", "chatgpt")).toThrow(expect.objectContaining({ code: "signin_capacity" }));
    expect(runs.subscriptions.begin(user, "session-0", "chatgpt")).toBeDefined();
    const future = Date.now() + 10 * 60_000 + 1;
    const clock = vi.spyOn(Date, "now").mockReturnValue(future);
    try {
      expect(runs.subscriptions.begin(user, "overflow", "chatgpt")).toBeDefined();
      for (let i = 0; i < MAX_PENDING_LOGINS; i++) expect(runs.subscriptions.pending(user, `session-${i}`)).toBeUndefined();
    } finally { clock.mockRestore(); }
  });

  it("expires attempts after ten minutes", async () => {
    const start = await (await call("/api/v1/subscriptions/chatgpt/login", {})).json();
    const pasted = await approve(start.url);
    vi.spyOn(Date, "now").mockReturnValue(start.expires_at + 1);
    const res = await call("/api/v1/subscriptions/chatgpt/callback", { url: pasted });
    vi.mocked(Date.now).mockRestore();
    expect(res.status).toBe(409);
    expect(mock.count("/api/accounts/oauth/token")).toBe(0);
  });

  it("stops on declined consent and keeps a sign-in without plan permission disabled", async () => {
    mock.consent = "deny";
    const denied = await signIn();
    expect(denied.done.status).toBe(400);
    expect(denied.body.error).toMatchObject({ code: "chatgpt_declined" });
    expect(denied.body.error.message).toMatch(/Nothing was saved/);
    expect(mock.count("/api/accounts/oauth/token")).toBe(0);
    expect(account()).toBeUndefined();
    mock.consent = "no-plan-scope";
    const limited = await signIn();
    expect(limited.body.account).toMatchObject({ status: "active", plan: "disabled" });
    const catalog = await (await call("/api/v1/models")).json();
    expect(catalog.models).toEqual([]);
    expect(catalog.connections).toEqual([expect.objectContaining({ access: "chatgpt", status: "error", message: "ChatGPT plan use isn't enabled for this sign-in." })]);
    expect((await (await call("/api/v1/me")).json()).setup_required).toBe(true);
    expect(mock.count("/v1/models")).toBe(0);
  });

  it("uses the requested scopes when the code exchange omits scope", async () => {
    mock.omitTokenScope = true;
    const { start, done, body } = await signIn();
    expect(done.status).toBe(200);
    expect(body.account.plan).toBe("enabled");
    expect(tokensOf(account()).scopes).toEqual(new URL(start.url).searchParams.get("scope")!.split(" ").sort());
    expect((await runs.catalog(user)).models).not.toEqual([]);
  });

  it.each([
    [true, "unrequested.scope", "enabled"],
    [false, "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct unrequested.scope", "disabled"],
  ])("ignores pasted callback scope when token scope is omitted=%s", async (omitted, callbackScope, plan) => {
    mock.omitTokenScope = omitted;
    if (!omitted) mock.consent = "no-plan-scope";
    const start = await (await call("/api/v1/subscriptions/chatgpt/login", {})).json();
    const pasted = new URL(await approve(start.url));
    pasted.searchParams.set("scope", callbackScope);
    const response = await call("/api/v1/subscriptions/chatgpt/callback", { url: pasted.toString() });
    expect(response.status).toBe(200);
    expect((await response.json()).account.plan).toBe(plan);
    const requested = new URL(start.url).searchParams.get("scope")!.split(" ");
    expect(tokensOf(account()).scopes).toEqual(requested.filter(scope => omitted || scope !== "chatgpt.tokens.use.direct").sort());
  });

  it("retains the old scopes when refresh omits scope, including a narrower grant", async () => {
    mock.consent = "no-plan-scope";
    await signIn();
    const row = account(), old = tokensOf(row);
    mock.omitTokenScope = true;
    const refreshed = await runs.subscriptions.tokens(row.id, old.accessToken);
    expect(refreshed.scopes).toEqual(old.scopes);
    expect(refreshed.scopes).not.toContain("chatgpt.tokens.use.direct");
  });

  it("rejects an ID token whose nonce doesn't match the attempt", async () => {
    mock.wrongNonce = true;
    const { done, body } = await signIn();
    expect(done.status).toBe(502);
    expect(body.error.code).toBe("chatgpt_identity");
    expect(account()).toBeUndefined();
  });

  it("reauthorizes with the issued client ID and rejects a different client or account", async () => {
    const first = await signIn();
    const id = first.body.account.id, clientId = account().client_id;
    const hinted = new URL((await (await call("/api/v1/subscriptions/chatgpt/login", { account_id: id })).json()).url).searchParams;
    expect(hinted.get("client_id")).toBe(clientId);
    expect(hinted.has("agent_name_hint")).toBe(false);
    expect(hinted.get("id_token_hint")).toBe(tokensOf(account()).idToken);
    expect(hinted.get("login_hint")).toBe("person@example.test");
    expect(hinted.get("ext_agent_host_id")).toBe(getSetting(db, "subscription-host"));
    await call("/api/v1/subscriptions/chatgpt/login", undefined, "DELETE");

    const out = await (await call(`/api/v1/subscriptions/accounts/${id}/sign-out`, {})).json();
    expect(out).toEqual({ revoked: true });
    expect(mock.revoked).toEqual([{ token: expect.stringMatching(/^rt_/), token_type_hint: "refresh_token", client_id: clientId }]);
    expect(account()).toMatchObject({ id, client_id: clientId, credentials: "", status: "signed_out" });

    mock.returnClientId = "oaiapp_someone_else";
    const wrong = await signIn(id);
    expect(new URL(wrong.start.url).searchParams.has("id_token_hint")).toBe(false);
    expect(wrong.body.error.code).toBe("chatgpt_client");
    expect(account()).toMatchObject({ status: "signed_out", client_id: clientId });
    mock.returnClientId = undefined;
    const again = await signIn(id);
    expect(again.body.account).toMatchObject({ id, status: "active" });
    expect(account().client_id).toBe(clientId);
    expect(db.prepare("SELECT count(*) AS n FROM subscription_accounts").get()).toEqual({ n: 1 });
  });

  it("keeps different subjects separate when the issuer reuses a host client ID", async () => {
    mock.sharedClientId = "oaiapp_shared_host";
    const first = (await signIn()).body.account;
    const before = account().credentials;
    mock.subject = "second-subject";
    mock.email = "second@example.test";
    const second = (await signIn()).body.account;
    const rows = db.prepare("SELECT * FROM subscription_accounts ORDER BY created_at").all() as Record<string, any>[];
    expect(rows).toHaveLength(2);
    expect(first.id).not.toBe(second.id);
    expect(rows[0]!.credentials).toBe(before);
    expect(rows[0]!.subject).toBe("user-sub-1");
    expect(rows[1]!.subject).toBe("second-subject");
    expect(tokensOf(rows[0]!).refreshToken).not.toBe(tokensOf(rows[1]!).refreshToken);
  });

  it("keeps several ChatGPT accounts separate", async () => {
    const a = (await signIn()).body.account;
    mock.subject = "user-sub-2"; mock.email = "second@example.test";
    const b = (await signIn()).body.account;
    const rows = db.prepare("SELECT id,client_id,subject FROM subscription_accounts ORDER BY created_at").all() as { id: string; client_id: string; subject: string }[];
    expect(rows.map(r => r.subject)).toEqual(["user-sub-1", "user-sub-2"]);
    expect(new Set(rows.map(r => r.client_id)).size).toBe(2);
    const catalog = await (await call("/api/v1/models")).json();
    expect(catalog.connections.map((c: { name: string }) => c.name)).toEqual(["ChatGPT · person@example.test", "ChatGPT · second@example.test"]);
    const response = await relay(`chatgpt.${b.id}:gpt-5.5`);
    expect(await response.text()).toContain("response.end");
    const used = mock.accessTokens.get(mock.calls.filter(c => c.path === "/v1/responses").at(-1)!.auth!.replace("Bearer ", ""))!;
    expect(used.client).toBe(rows[1]!.client_id);
    expect(a.id).not.toBe(b.id);
  });
});

describe("ChatGPT plan models and inference", () => {
  it("lists listed models with efforts in the catalog and MCP, and starts sessions with them", async () => {
    // Pin allowed startup controls rather than depending on the test host's environment.
    vi.stubEnv("GOND_AGENT_PLAN_REMINDER_EVERY", "6");
    vi.stubEnv("GOND_AGENT_PLAN_NUDGE_LIMIT", "2");
    const id = (await signIn()).body.account.id, model = `chatgpt.${id}:gpt-5.5`;
    const catalog = await (await call("/api/v1/models")).json();
    expect(catalog.models.map((m: { id: string }) => m.id)).toEqual([model, `chatgpt.${id}:gpt-5.5-mini`]);
    expect(catalog.models[0]).toMatchObject({ provider: "openai", backend: "builtin", access: "chatgpt", display_name: "GPT-5.5 · ChatGPT", context_window: 272000, efforts: ["low", "medium", "high", "xhigh"], connection_id: `chatgpt.${id}` });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    servers.push(server);
    if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
    const client = new Client({ name: "plan", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${createToken(db, user, "bot").token}` } } }));
    let runId!: string;
    try {
      const tool = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text);
      const listed = await tool("list_models", {});
      expect(listed.models).toContainEqual(expect.objectContaining({ id: model, backend: "builtin", access: "chatgpt", connection_id: `chatgpt.${id}`, connection_name: "ChatGPT · person@example.test", efforts: ["low", "medium", "high", "xhigh"] }));
      expect(listed.connections).toContainEqual(expect.objectContaining({ id: `chatgpt.${id}`, access: "chatgpt", status: "ready" }));
      const started = await tool("start_session", { request_id: "plan-1", repo: "acme/app", model, effort: "xhigh", prompt: "Use my plan" });
      expect(started).toMatchObject({ model, effort: "xhigh", backend: "builtin" });
      runId = started.id;
      expect(runId).toEqual(expect.any(String));
      expect((await tool("start_session", { request_id: "plan-2", repo: "acme/app", model: "cli-codex:default", prompt: "Old id" })).error).toBe("retired_model");
    } finally { await client.close(); }
    await vi.waitFor(() => expect(rpcs.some(r => r.method === "send")).toBe(true));
    // Structural guard: the worker gets model IDs and the loopback relay, never plan credentials.
    const workerTraffic = JSON.stringify(rpcs);
    for (const value of mock.issued) expect(workerTraffic).not.toContain(value);
    expect(rpcs.filter(r => r.method === "start")).toEqual([{ method: "start", args: {
      model, effort: "xhigh", interactive: true, question_wait_minutes: 240,
      plan_reminder_every: 6, plan_nudge_limit: 2,
      evidence_seq: 0, evidence_gate_rounds: 0, evidence_resumes: 0,
      evidence_base_sha: "a".repeat(40), evidence_mode: "on", evidence_repo_policy: "",
    } }]);
    expect(rpcs.filter(r => r.method === "export_state")).toEqual([
      { method: "export_state", args: { run_id: runId, owner_id: user } },
    ]);
    expect(rpcs.filter(r => r.method === "init_evidence")).toEqual([
      { method: "init_evidence", args: { run_id: runId, owner_id: user, key: expect.stringMatching(/^[a-f0-9]{64}$/) } },
    ]);
    expect(rpcs.findIndex(r => r.method === "init_evidence")).toBeGreaterThan(rpcs.findIndex(r => r.method === "start"));
    expect(rpcs.findIndex(r => r.method === "init_evidence")).toBeLessThan(rpcs.findIndex(r => r.method === "export_state"));
    expect(rpcs.findIndex(r => r.method === "export_state")).toBeGreaterThan(rpcs.findIndex(r => r.method === "start"));
    expect(rpcs.findIndex(r => r.method === "export_state")).toBeLessThan(rpcs.findIndex(r => r.method === "send"));
    const relayed = await (await handler!(runnerRequest(model))).text();
    for (const value of mock.issued) expect(relayed).not.toContain(value);
    expect(relayed).toContain('"name":"read"');
  });

  it("sends runner requests within the plan preview limits, with namespaced tools and full history", async () => {
    const id = (await signIn()).body.account.id, model = `chatgpt.${id}:gpt-5.5`;
    const first = await (await relay(model)).text();
    expect(first).toMatch(/event: block\.start\ndata: \{"index":0,"type":"tool_call","id":"call_mock","name":"read"\}/);
    expect(first).toContain("event: response.end");
    const sent = mock.calls.filter(c => c.path === "/v1/responses").at(-1)!.body as Record<string, any>;
    expect(OpenAIMock.violation(sent)).toBeUndefined();
    expect(sent).toMatchObject({ model: "gpt-5.5", store: false, stream: true, instructions: "You are the built-in runner.", reasoning: { effort: "high" }, tools: [{ type: "namespace", name: "gond", tools: [{ type: "function", name: "read" }] }] });
    expect(sent).not.toHaveProperty("max_output_tokens");
    expect(sent).not.toHaveProperty("metadata");
    // The follow-up replays the whole history, including the namespaced call, in `input`.
    const history = [
      { role: "user", content: [{ type: "text", text: "Read the README" }, { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" }] },
      { role: "assistant", content: [{ type: "tool_call", id: "call_mock", name: "read", input: { path: "README.md" } }] },
      { role: "tool", content: [{ type: "tool_result", call_id: "call_mock", name: "read", content: [{ type: "text", text: "# Readme" }] }] },
    ];
    const second = await (await relay(model, { messages: history })).text();
    expect(second).toContain("Plan request completed.");
    const replay = mock.calls.filter(c => c.path === "/v1/responses").at(-1)!.body as Record<string, any>;
    expect(OpenAIMock.violation(replay)).toBeUndefined();
    expect(replay.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Read the README" }, { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }] },
      { type: "function_call", call_id: "call_mock", name: "read", namespace: "gond", arguments: '{"path":"README.md"}' },
      { type: "function_call_output", call_id: "call_mock", output: "# Readme" },
    ]);
    // The mock rejects the API-key request shape the same way the preview does.
    expect(OpenAIMock.violation({ ...replay, tools: replay.tools[0].tools })).toBe("tools");
    expect(OpenAIMock.violation({ ...replay, temperature: 0.2 })).toBe("temperature");
    expect(OpenAIMock.violation({ ...replay, input: [{ type: "message", role: "system", content: [] }] })).toBe("input.role");
    expect(OpenAIMock.violation({ ...replay, tools: [{ type: "image_generation" }] })).toBe("tools.image_generation");
    expect(db.prepare("SELECT model_id,input,output,cache_read,cost_micros FROM usage ORDER BY id DESC").get()).toEqual({ model_id: model, input: 100, output: 30, cache_read: 20, cost_micros: 0 });
  });

  it("refreshes before expiry once for concurrent callers and stores the rotated token set together", async () => {
    await signIn();
    const row = account(), before = tokensOf(row);
    db.prepare("UPDATE subscription_accounts SET credentials=?").run(seal(secret, JSON.stringify({ ...before, expiresAt: Date.now() + 60_000 })));
    mock.refreshDelay = 50;
    const results = await Promise.all([1, 2, 3].map(() => runs.subscriptions.tokens(row.id)));
    expect(mock.calls.filter(c => c.form?.grant_type === "refresh_token")).toHaveLength(1);
    expect(new Set(results.map(t => t.accessToken)).size).toBe(1);
    const after = tokensOf(account());
    expect(after.accessToken).toBe(results[0]!.accessToken);
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(after.idToken).toBe(before.idToken);
    expect(after.expiresAt).toBeGreaterThan(Date.now() + 3_000_000);
    expect(mock.refreshTokens.get(before.refreshToken!)!.state).toBe("used");
    expect(mock.calls.find(c => c.form?.grant_type === "refresh_token")!.form).toEqual({ grant_type: "refresh_token", client_id: row.client_id, refresh_token: before.refreshToken, resource: "https://api.openai.com/v1" });
  });

  it("revokes the rotated token when signing out during a slow refresh", async () => {
    await signIn();
    const row = account(), old = tokensOf(row);
    mock.refreshDelay = 100;
    const refreshing = runs.subscriptions.tokens(row.id, old.accessToken);
    await vi.waitFor(() => expect(mock.calls.some(c => c.form?.grant_type === "refresh_token")).toBe(true));
    const signedOut = runs.subscriptions.signOut(user, row.id);
    const rotated = await refreshing;
    expect(await signedOut).toEqual({ revoked: true });
    expect(mock.refreshTokens.get(rotated.refreshToken!)!.state).toBe("revoked");
    expect(account().credentials).toBe("");
  });

  it("revokes a rotated token discarded after a compare-and-swap miss", async () => {
    await signIn();
    const row = account();
    mock.refreshDelay = 100;
    const refreshing = runs.subscriptions.tokens(row.id, tokensOf(row).accessToken);
    const rejected = expect(refreshing).rejects.toMatchObject({ code: "subscription_signin" });
    await vi.waitFor(() => expect(mock.calls.some(c => c.form?.grant_type === "refresh_token")).toBe(true));
    db.prepare("UPDATE subscription_accounts SET credentials='' WHERE id=?").run(row.id);
    await rejected;
    expect([...mock.refreshTokens.values()].filter(t => t.state === "active")).toEqual([]);
    expect(mock.revoked).toHaveLength(1);
  });

  it("revokes an exchanged grant if the local session is no longer authorized", async () => {
    const pending = runs.subscriptions.begin(user, "expired-session", "chatgpt");
    const pasted = await approve(pending.url);
    await expect(runs.subscriptions.complete(user, "expired-session", pasted, async () => false)).rejects.toMatchObject({ code: "unauthorized" });
    expect(account()).toBeUndefined();
    expect([...mock.refreshTokens.values()].map(t => t.state)).toEqual(["revoked"]);
  });

  it("requires a new sign-in after a refresh-token reuse error and keeps the registration", async () => {
    await signIn();
    const row = account(), stale = tokensOf(row);
    await runs.subscriptions.tokens(row.id, stale.accessToken);
    // A stale copy (another process, a restored backup) tries the rotated refresh token again.
    db.prepare("UPDATE subscription_accounts SET credentials=?").run(seal(secret, JSON.stringify({ ...stale, expiresAt: 0 })));
    await expect(runs.subscriptions.tokens(row.id)).rejects.toMatchObject({ status: 401, code: "subscription_signin", message: expect.stringMatching(/Continue with ChatGPT/) });
    expect(account()).toMatchObject({ status: "reauth", credentials: "", client_id: row.client_id });
    expect(logs.join("\n")).toContain("ChatGPT token refresh failed 400 refresh_token_reused");
    const catalog = await (await call("/api/v1/models")).json();
    expect(catalog.connections[0]).toMatchObject({ status: "error", message: "Sign in to ChatGPT again to use this account." });
  });

  it("refreshes once and retries once after a 401", async () => {
    const id = (await signIn()).body.account.id;
    await call("/api/v1/models");
    mock.rejectOnce = true;
    expect(await (await relay(`chatgpt.${id}:gpt-5.5`)).text()).toContain("response.end");
    expect(mock.calls.filter(c => c.form?.grant_type === "refresh_token")).toHaveLength(1);
    expect(mock.count("/v1/responses")).toBe(2);
  });

  it("maps plan-usage errors to plain messages and never falls back to API billing", async () => {
    const apiCalls: string[] = [];
    const api = createServer((req, res) => { apiCalls.push(req.url ?? ""); res.writeHead(500); res.end(); });
    await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
    try {
      saveProviderSettings(db, secret, { connections: [{ id: "paid", name: "Paid", format: "openai-responses", baseURL: `http://127.0.0.1:${(api.address() as { port: number }).port}/v1`, apiKey: "paid-key", discover: false, models: [{ id: "gpt-5.5", name: "GPT-5.5", contextWindow: 128000, maxOutput: 8192, reasoning: "none", images: true }] }], defaultModel: "paid:gpt-5.5" });
      const id = (await signIn()).body.account.id, model = `chatgpt.${id}:gpt-5.5`;
      const failWith = async (status: number, body: unknown) => {
        mock.responseFailures.push({ status, body });
        const response = await relay(model);
        return { status: response.status, ...(await response.json()).error };
      };
      const limit = await failWith(429, { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } });
      expect(limit).toMatchObject({ status: 429, code: "chatgpt_usage_limit", retryable: false });
      expect(limit.message).toContain("https://chatgpt.com/settings/usage");
      expect(limit.message).toContain("doesn't switch to API billing");
      // Plan requests pause instead of hammering the limit.
      const responses = mock.count("/v1/responses");
      const paused = await relay(model);
      expect(paused.status).toBe(429);
      expect(mock.count("/v1/responses")).toBe(responses);
      const card = (await (await call("/api/v1/models")).json()).connections.find((c: { access: string }) => c.access === "chatgpt");
      expect(card).toMatchObject({ limited: true, usage_url: "https://chatgpt.com/settings/usage" });
      db.prepare("UPDATE subscription_accounts SET limited_at=NULL").run();

      expect(await failWith(503, { error: { code: "subscription_sharing_usage_unavailable" } })).toMatchObject({ status: 503, code: "chatgpt_usage_unavailable", retryable: true });
      expect(await failWith(503, { error: { code: "subscription_sharing_user_unavailable" } })).toMatchObject({ status: 503, retryable: true });
      expect(await failWith(503, { detail: "Direct routing is unavailable." })).toMatchObject({ status: 503, code: "chatgpt_unavailable", retryable: true });
      expect(await failWith(400, { error: { code: "subscription_sharing_unsupported_capability", param: "tools[0]" } })).toMatchObject({ status: 400, message: expect.stringContaining("(tools[0])") });
      expect(await failWith(403, { error: { code: "subscription_sharing_route_not_supported" } })).toMatchObject({ status: 403, code: "chatgpt_route" });
      expect(await failWith(403, { detail: "Region" })).toMatchObject({ status: 403, code: "chatgpt_forbidden" });

      mock.streamFailure = "subscription_sharing_usage_limit_exceeded";
      const streamed = await (await relay(model)).text();
      expect(streamed).toMatch(/event: error\ndata: \{"code":"chatgpt_usage_limit"/);
      db.prepare("UPDATE subscription_accounts SET limited_at=NULL").run();

      const authCalls = mock.count("/api/accounts/authorize") + mock.count("/api/accounts/oauth/token");
      expect(await failWith(403, { error: { code: "subscription_sharing_user_not_eligible" } })).toMatchObject({ status: 403, code: "chatgpt_not_eligible", retryable: false });
      expect(account().plan).toBe("not_eligible");
      const again = await relay(model);
      expect(again.status).toBe(403);
      expect(mock.count("/api/accounts/authorize") + mock.count("/api/accounts/oauth/token")).toBe(authCalls);
      expect(apiCalls).toEqual([]);
    } finally { await new Promise<void>(resolve => api.close(() => resolve())); }
  });

  it("revokes on sign-out with retries, then removes the account's models", async () => {
    const id = (await signIn()).body.account.id;
    mock.revokeFailures = 1;
    expect(await (await call(`/api/v1/subscriptions/accounts/${id}/sign-out`, {})).json()).toEqual({ revoked: true });
    expect(mock.count("/oauth/revoke")).toBe(2);
    expect((await (await call("/api/v1/models")).json()).models).toEqual([]);
    const response = await relay(`chatgpt.${id}:gpt-5.5`);
    expect(response.status).toBe(404);
    expect((await call(`/api/v1/subscriptions/accounts/${id}`, undefined, "DELETE")).status).toBe(200);
    expect(account()).toBeUndefined();
  });
});
