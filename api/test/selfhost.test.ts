import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { openStore } from "../src/db";
import { createAuthentication, seal, unseal } from "../src/auth";
import { createApp } from "../src/app";
import { Runs } from "../src/runs/service";
import { containerArguments } from "../src/containers";
import { validRepo, validBranch } from "../src/github";
import { validateRunner } from "../src/scheduler";
import { GithubLogin } from "../src/github-login";
import { getSetting } from "../src/db";
import type { Config } from "../src/config";
let dir: string,
  db: ReturnType<typeof openStore>,
  auth: Awaited<ReturnType<typeof createAuthentication>>,
  app: ReturnType<typeof createApp>["app"],
  runs: Runs;
const secret = "a-long-random-secret-for-tests-only-123456789";
const cfg = (): Config => ({
  data: dir,
  origin: "http://localhost:8787",
  secret,
  signup: true,
  port: 8787,
  dockerBin: "docker",
  workerImage: "gond-agent-worker:test",
  maxRuns: 2,
  runCPUs: 2,
  runMemoryMB: 2048,
  idleMs: 10000,
  turnMs: 10000,
});
const call = (
  path: string,
  body?: unknown,
  cookie = "",
  method = body === undefined ? "GET" : "POST",
  origin = "http://localhost:8787",
) =>
  app.request("http://localhost:8787" + path, {
    method,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function signup(email = "daws@example.com") {
  const res = await call("/api/auth/sign-up/email", {
    email,
    password: "correct horse battery staple",
    name: "Daws",
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.headers
    .getSetCookie()
    .map((x) => x.split(";")[0])
    .join("; ");
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gond-agent-test-"));
  db = openStore(dir);
  auth = await createAuthentication(db, cfg());
  runs = new Runs(db, cfg(), async () => {
    throw new Error("Container should not start in this test");
  });
  app = createApp(db, cfg(), auth, runs).app;
});
afterEach(async () => {
  await runs.shutdown();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
describe("local authentication and persistence", () => {
  it("protects GitHub device sign-in by administrator, origin and session without exposing credentials", async () => {
    let code!: (code: string) => void, approve!: (token: string) => void;
    const login = new GithubLogin(db, secret, dir, (_root, callback) => {
      code = callback;
      return { token: new Promise<string>(resolve => { approve = resolve; }), cancel: () => {} };
    });
    app = createApp(db, cfg(), auth, runs, login).app;
    const admin = await signup(), other = await signup("other@example.test");
    expect((await call("/api/v1/github/login")).status).toBe(401);
    for (const method of ["GET", "POST", "DELETE"]) expect((await call("/api/v1/github/login", method === "GET" ? undefined : {}, other, method)).status).toBe(403);
    expect((await call("/api/v1/github/login", {}, admin, "POST", "https://elsewhere.test")).status).toBe(403);
    const begun = await call("/api/v1/github/login", {}, admin);
    expect(begun.headers.get("cache-control")).toBe("no-store");
    code("ABCD-1234");
    const pending = await (await call("/api/v1/github/login", undefined, admin)).json();
    expect(pending).toMatchObject({ code: "ABCD-1234", url: "https://github.com/login/device" });
    expect(Object.keys(pending).sort()).toEqual(["code", "expiresAt", "id", "status", "url"]);
    const session = await auth.current.api.getSession({ headers: new Headers({ cookie: admin }) });
    await call("/api/auth/sign-out", {}, admin);
    approve("credential-after-signout");
    await vi.waitFor(() => expect(login.state(session!.session.token).status).toBe("cancelled"));
    await login.close();
    expect(getSetting(db, "github")).toBeNull();
  });
  it("opens the app at the instance root without serving a marketing site", async () => {
    const root = await call("/");
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/agents/");
    for (const path of ["/docs", "/pricing", "/terms", "/privacy", "/missing"]) {
      expect((await call(path)).status).toBe(404);
    }
  });

  it("reports first-account bootstrap publicly without opening further registration", async () => {
    const config = { ...cfg(), signup: false };
    const closed = await createAuthentication(db, config);
    app = createApp(db, config, closed, runs).app;
    const initial = await call("/api/auth/bootstrap");
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(await initial.json()).toEqual({ firstAccount: true, signupAllowed: true, providers: [] });
    await signup();
    expect(await (await call("/api/auth/bootstrap")).json()).toEqual({ firstAccount: false, signupAllowed: false, providers: [] });
    expect((await call("/api/auth/sign-up/email", { name: "Other", email: "other@example.test", password: "test-password-only-123456" })).status).toBeGreaterThanOrEqual(400);
    app = createApp(db, { ...config, signup: true }, auth, runs).app;
    expect(await (await call("/api/auth/bootstrap")).json()).toEqual({ firstAccount: false, signupAllowed: true, providers: [] });
  });

  it("registers, stores a hashed password, signs out and signs back in", async () => {
    const cookie = await signup();
    const me = await (await call("/api/v1/me", undefined, cookie)).json();
    expect(me.admin).toBe(true);
    expect(me.plan).toBeUndefined();
    const account = db
      .prepare("SELECT password FROM account WHERE providerId=?")
      .get("credential") as { password: string };
    expect(account.password).not.toContain("correct horse");
    expect((await call("/api/v1/me")).status).toBe(401);
    const session = await call("/api/v1/sessions", undefined, cookie);
    expect((await session.json()).sessions).toHaveLength(1);
    expect((await call("/api/auth/sign-out", {}, cookie)).status).toBe(200);
    expect((await call("/api/v1/me", undefined, cookie)).status).toBe(401);
    expect(
      (
        await call("/api/auth/sign-in/email", {
          email: "daws@example.com",
          password: "wrong",
        })
      ).status,
    ).toBe(401);
    const signed = await call("/api/auth/sign-in/email", {
      email: "daws@example.com",
      password: "correct horse battery staple",
    });
    expect(signed.status).toBe(200);
    const persistent = await createAuthentication(db, cfg());
    expect(
      await persistent.current.api.getSession({
        headers: new Headers({
          cookie: signed.headers
            .getSetCookie()
            .map((x) => x.split(";")[0])
            .join("; "),
        }),
      }),
    ).not.toBeNull();
  });
  it("blocks cross-origin writes and reserves instance OIDC settings for the administrator", async () => {
    await signup();
    const normal = await signup("other@example.com");
    const me = await (await call("/api/v1/me", undefined, normal)).json();
    expect(me.admin).toBe(false);
    expect(me.plan).toBeUndefined();
    expect(
      (await call("/api/v1/settings/oidc", undefined, normal)).status,
    ).toBe(403);
    expect(
      (
        await call(
          "/api/v1/me/automations",
          { auto_pr: false },
          normal,
          "PUT",
          "https://evil.example",
        )
      ).status,
    ).toBe(403);
    expect(
      (await call("/api/v1/me/automations", { auto_pr: false }, normal, "PUT"))
        .status,
    ).toBe(200);
    expect((await call("/api/v1/models", undefined, normal)).status).toBe(200);
  });
  it("encrypts OIDC secrets, keeps them on blank updates, and never returns them", async () => {
    const cookie = await signup();
    const body = {
      enabled: false,
      name: "Company",
      issuer: "https://idp.example.com/realm",
      clientId: "app",
      clientSecret: "secret-client-value",
    };
    expect(
      (await call("/api/v1/settings/oidc", body, cookie, "PUT")).status,
    ).toBe(200);
    const raw = (
      db.prepare("SELECT value FROM settings WHERE key=?").get("oidc") as {
        value: string;
      }
    ).value;
    expect(raw).not.toContain(body.clientSecret);
    const shown = await (
      await call("/api/v1/settings/oidc", undefined, cookie)
    ).json();
    expect(shown.hasSecret).toBe(true);
    expect(shown.secret).toBeUndefined();
    expect(shown.callbackURL).toBe(
      "http://localhost:8787/api/auth/callback/oidc",
    );
    expect(
      (
        await call(
          "/api/v1/settings/oidc",
          { ...body, clientSecret: "" },
          cookie,
          "PUT",
        )
      ).status,
    ).toBe(200);
    expect(auth.oidc().hasSecret).toBe(true);
    expect(
      (
        await call(
          "/api/v1/settings/oidc",
          { ...body, issuer: "http://idp.example.com" },
          cookie,
          "PUT",
        )
      ).status,
    ).toBe(400);
    const encrypted = seal(secret, "sensitive");
    expect(unseal(secret, encrypted)).toBe("sensitive");
    expect(() => unseal("different secret", encrypted)).toThrow();
  });
  it("completes a verified OIDC login using discovery, PKCE and an ID-token nonce", async () => {
    const cookie = await signup();
    const issuer = "https://identity.example.com";
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const jwk = {
      ...publicKey.export({ format: "jwk" }),
      kid: "test-key",
      use: "sig",
      alg: "RS256",
    };
    let nonce = "";
    const b64 = (x: unknown) =>
      Buffer.from(JSON.stringify(x)).toString("base64url");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes(".well-known"))
        return Response.json({
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          userinfo_endpoint: issuer + "/userinfo",
          jwks_uri: issuer + "/jwks",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        });
      if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
      if (url.endsWith("/userinfo"))
        return Response.json({
          sub: "external-user",
          email: "oidc@example.com",
          email_verified: true,
          name: "OIDC User",
        });
      if (url.endsWith("/token")) {
        const now = Math.floor(Date.now() / 1000);
        const unsigned =
          b64({ alg: "RS256", kid: "test-key" }) +
          "." +
          b64({
            iss: issuer,
            aud: "gond-agent",
            sub: "external-user",
            email: "oidc@example.com",
            email_verified: true,
            name: "OIDC User",
            nonce,
            iat: now,
            exp: now + 300,
          });
        const token =
          unsigned +
          "." +
          sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString(
            "base64url",
          );
        return Response.json({
          access_token: "access",
          token_type: "Bearer",
          expires_in: 300,
          id_token: token,
        });
      }
      throw new Error("Unexpected identity request: " + url);
    });
    expect(
      (
        await call(
          "/api/v1/settings/oidc",
          {
            enabled: true,
            name: "Company",
            issuer,
            clientId: "gond-agent",
            clientSecret: "client-secret",
          },
          cookie,
          "PUT",
        )
      ).status,
    ).toBe(200);
    const start = await call("/api/auth/sign-in/social", {
      provider: "oidc",
      callbackURL: "http://localhost:8787/agents/",
    });
    expect(start.status, await start.clone().text()).toBe(200);
    const url = new URL((await start.json()).url);
    expect(url.origin).toBe(issuer);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    nonce = url.searchParams.get("nonce")!;
    expect(nonce).toBeTruthy();
    const state = url.searchParams.get("state")!;
    const stateCookie = start.headers
      .getSetCookie()
      .map((x) => x.split(";")[0])
      .join("; ");
    const result = await call(
      "/api/auth/callback/oidc?code=test-code&state=" +
        encodeURIComponent(state),
      undefined,
      stateCookie,
    );
    expect(result.headers.get("location")).toBe(
      "http://localhost:8787/agents/",
    );
    const signed = result.headers
      .getSetCookie()
      .map((x) => x.split(";")[0])
      .join("; ");
    const session = await auth.current.api.getSession({
      headers: new Headers({ cookie: signed }),
    });
    expect(session?.user.email).toBe("oidc@example.com");
  });
  it("permits only the initial registration when signup is closed", async () => {
    const closed = await createAuthentication(db, { ...cfg(), signup: false });
    app = createApp(db, cfg(), closed, runs).app;
    await signup();
    const next = await call("/api/auth/sign-up/email", {
      email: "second@example.com",
      password: "correct horse battery staple",
      name: "Other",
    });
    expect(next.status).toBeGreaterThanOrEqual(400);
  });
  it("enforces owner scoping for run history, images and actions", async () => {
    const owner = await signup(),
      other = await signup("other@example.com");
    const user = (await (await call("/api/v1/me", undefined, owner)).json())
      .user.id;
    db.prepare(
      "INSERT INTO runs(id,user_id,repo,status,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?)",
    ).run(
      "run_x",
      user,
      "a/b",
      "ready",
      1,
      1,
      JSON.stringify({
        id: "run_x",
        user_id: user,
        status: "ready",
        diff: "secret",
      }),
    );
    expect(
      (await call("/api/v1/runs/run_x/diff", undefined, owner)).status,
    ).toBe(200);
    expect(
      (await call("/api/v1/runs/run_x/diff", undefined, other)).status,
    ).toBe(404);
    expect((await call("/api/v1/runs/run_x/stop", {}, other)).status).toBe(404);
  });
});
describe("provider setup access", () => {
  const settings = {
    connections: [{ id: "anthropic", name: "Claude", format: "anthropic", baseURL: "https://api.anthropic.com/v1", apiKey: "provider-secret-value", discover: false, models: [{ id: "claude-test", name: "Claude", contextWindow: 128000, maxOutput: 8192, reasoning: "none", images: true }] }],
    defaultModel: "anthropic:claude-test",
  };
  it("requires sign-in and admin access, then completes setup without disclosing keys", async () => {
    expect((await call("/api/v1/settings/providers")).status).toBe(401);
    const admin = await signup(), other = await signup("other@example.com");
    expect((await (await call("/api/v1/me", undefined, admin)).json()).setup_required).toBe(true);
    expect((await (await call("/api/v1/models", undefined, other)).json()).models).toEqual([]);
    expect((await call("/api/v1/settings/providers", settings, other, "PUT")).status).toBe(403);
    expect((await call("/api/v1/settings/providers", undefined, other)).status).toBe(403);
    expect((await call("/api/v1/transcribe", {}, admin)).status).toBe(404);
    expect((await call("/api/v1/settings/providers", settings, admin, "PUT", "https://other.example")).status).toBe(403);
    const saved = await call("/api/v1/settings/providers", settings, admin, "PUT");
    expect(saved.status).toBe(200);
    const shown = await saved.json();
    expect(shown.connections[0].hasKey).toBe(true);
    expect(JSON.stringify(shown)).not.toContain(settings.connections[0].apiKey);
    expect((await (await call("/api/v1/me", undefined, other)).json()).setup_required).toBe(false);
    const models = await (await call("/api/v1/models", undefined, other)).json();
    expect(models.models.map((m: { id: string }) => m.id)).toEqual(["auto", "anthropic:claude-test"]);
    expect(JSON.stringify(models)).not.toContain(settings.connections[0].apiKey);
  });
});
describe("container and input boundaries", () => {
  it("constructs non-root limited containers without host mounts or credentials", () => {
    const args = containerArguments(cfg(), "gond-agent-test", "instance", "run_test");
    expect(args).toContain("--read-only");
    expect(args).toContain("1000:1000");
    expect(args).toContain("ALL");
    expect(args).toContain("no-new-privileges=true");
    expect(args).toContain("2048m");
    expect(args).toContain("type=volume,source=gond-agent-test-work,target=/workspace/repo");
    expect(args).not.toContain("--privileged");
    expect(args.join(" ")).not.toMatch(/docker\.sock|\/data|\/gh|secret|token/);
  });
  it("rejects unsafe repository names, refs and schedules", () => {
    expect(validRepo("dawsja/gond-agent")).toBe(true);
    expect(validRepo("--evil")).toBe(false);
    expect(validRepo("a/..")).toBe(false);
    expect(validBranch("--upload-pack=evil")).toBe(false);
    expect(validBranch("main..evil")).toBe(false);
    expect(() =>
      validateRunner({
        name: "x",
        repo: "a/b",
        prompt: "hello",
        frequency: "weekly",
        weekdays: [],
        minute: 99,
        timezone: "UTC",
      }),
    ).toThrow();
  });
  it("stores data in a local SQLite file across connections", () => {
    db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(
      "saved",
      '"yes"',
    );
    const reopened = openStore(dir);
    expect(
      (
        reopened
          .prepare("SELECT value FROM settings WHERE key=?")
          .get("saved") as { value: string }
      ).value,
    ).toBe('"yes"');
    reopened.close();
  });
});
