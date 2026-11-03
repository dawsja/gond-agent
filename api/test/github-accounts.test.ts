import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, getSetting, setSetting } from "../src/db";
import { createAuthentication, seal } from "../src/auth";
import { githubEnvFor } from "../src/github-login";
import { commitIdentity, gh } from "../src/github";
import { PullRequests } from "../src/pull-requests";
import { createApp } from "../src/app";
import { Runs } from "../src/runs/service";
import { saveProviderSettings } from "../src/providers";
import { Scheduler } from "../src/scheduler";
import type { Config } from "../src/config";

let dir: string, db: ReturnType<typeof openStore>, runs: Runs, instance: ReturnType<typeof createApp>, cfg: Config;
let a: { id: string; cookie: string }, b: typeof a;
const password = "fixture-password-long-enough";
const request = (path: string, cookie = "", body?: unknown, method = body === undefined ? "GET" : "POST") => instance.app.request(cfg.origin + path, { method, headers: { cookie, origin: cfg.origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const connect = (user: string, token: string) => db.prepare("INSERT OR REPLACE INTO github_connections(user_id,token,connected_at) VALUES(?,?,?)").run(user, seal(cfg.secret, token), Date.now());
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gond-github-accounts-"));
  cfg = { data: dir, origin: "http://localhost:8787", secret: "fixture-secret-longer-than-thirty-two-characters", signup: true, port: 8787, dockerBin: "docker", workerImage: "unused", maxRuns: 5, runCPUs: 1, runMemoryMB: 2048 };
  db = openStore(dir);
  const auth = await createAuthentication(db, cfg);
  runs = new Runs(db, cfg, async () => { throw new Error("No container needed"); });
  instance = createApp(db, cfg, auth, runs);
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "gh"), readFileSync(new URL("./fixtures/gh.cjs", import.meta.url)), { mode: 0o700 });
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR"]) vi.stubEnv(key, "");
  vi.stubEnv("GOND_AGENT_GH_FIXTURE_DIR", dir);
  const signup = async (email: string) => {
    const result = await request("/api/auth/sign-up/email", "", { email, name: email, password });
    expect(result.status).toBe(200);
    return { id: (await result.json()).user.id as string, cookie: result.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
  };
  a = await signup("a@example.test"); b = await signup("b@example.test");
});
afterEach(async () => { await instance.githubLogin.close(); await instance.mcp.close(); await runs.shutdown(); db.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it("isolates repository, branch, PR reads and commit identity by account, with no credential fallback to another user", async () => {
  connect(a.id, "fixture-token-a");
  expect((await (await request("/api/v1/github/repos", a.cookie)).json()).repos[0].full_name).toBe("developer-a/app");
  expect((await request("/api/v1/github/branches?repo=developer-a/app", a.cookie)).status).toBe(200);
  expect((await request("/api/v1/github/repos", b.cookie)).status).toBe(409);
  expect((await request("/api/v1/github/branches?repo=developer-a/app", b.cookie)).status).toBe(409);
  const denied = await request("/api/v1/runs", b.cookie, { repo: "developer-a/app", prompt: "Work", model: "auto" });
  expect(denied.status).toBe(409);
  expect((await denied.json()).error.message).toBe("Connect your GitHub account in Settings > Connections");
  expect(await (await request("/api/v1/github", b.cookie)).json()).toEqual({ configured: false, login: null, managed: false });
  connect(b.id, "fixture-token-b");
  expect((await (await request("/api/v1/github/repos", b.cookie)).json()).repos[0].full_name).toBe("developer-b/app");
  expect(await commitIdentity(githubEnvFor(db, cfg.secret, a.id))).toEqual({ name: "developer-a", email: "101+developer-a@users.noreply.github.com" });
  expect(await commitIdentity(githubEnvFor(db, cfg.secret, b.id))).toEqual({ name: "developer-b", email: "202+developer-b@users.noreply.github.com" });
  expect((await gh<{ number: number }>("repos/developer-a/app/pulls", "POST", { title: "Work" }, githubEnvFor(db, cfg.secret, a.id))).number).toBe(42);
  const pulls = new PullRequests(user => githubEnvFor(db, cfg.secret, user));
  const refs = [{ repo: "acme/app", pr_number: 42, pr_state: "open" }];
  await pulls.states(refs, a.id); await pulls.states(refs, b.id);
  const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.filter(call => call.endpoint === "graphql").map(call => call.login)).toEqual(["developer-a", "developer-b"]);
  expect(calls.find(call => call.endpoint.includes("/branches"))).toMatchObject({ login: "developer-a" });
  expect((await request("/api/v1/settings/github", b.cookie)).status).toBe(403);
  expect((await request("/api/v1/github", a.cookie, {}, "DELETE")).status).toBe(200);
  expect(() => githubEnvFor(db, cfg.secret, a.id)).toThrow("Connect your GitHub");
  expect(githubEnvFor(db, cfg.secret, b.id).GH_TOKEN).toBe("fixture-token-b");
});

it("resolves personal before opt-in shared before explicit service credentials; safely migrates only once", () => {
  expect(getSetting(db, "github-shared-fallback")).toBe(false);
  setSetting(db, "github", { token: seal(cfg.secret, "fixture-token-a") });
  expect(() => githubEnvFor(db, cfg.secret, b.id)).toThrow("Connect your GitHub");
  setSetting(db, "github-shared-fallback", true);
  expect(githubEnvFor(db, cfg.secret, b.id).GH_TOKEN).toBe("fixture-token-a");
  connect(b.id, "fixture-token-b");
  expect(githubEnvFor(db, cfg.secret, b.id).GH_TOKEN).toBe("fixture-token-b");
  setSetting(db, "github-shared-fallback", false);
  vi.stubEnv("GH_TOKEN", "service-credential");
  expect(githubEnvFor(db, cfg.secret, a.id).GH_TOKEN).toBe("service-credential");
  expect(githubEnvFor(db, cfg.secret, b.id).GH_TOKEN).toBe("fixture-token-b");
  db.prepare("DELETE FROM settings WHERE key='github-shared-fallback'").run();
  db.close(); db = openStore(dir);
  expect(getSetting(db, "github-shared-fallback")).toBe(true);
  setSetting(db, "github-shared-fallback", false);
  db.close(); db = openStore(dir);
  expect(getSetting(db, "github-shared-fallback")).toBe(false);
});

it("supports simultaneous session-private device flows and erases connections with accounts", async () => {
  const login = instance.githubLogin;
  const flowA = await (await request("/api/v1/github/login", a.cookie, {})).json();
  const flowB = await (await request("/api/v1/github/login", b.cookie, {})).json();
  expect(flowA.id).not.toBe(flowB.id);
  await vi.waitFor(async () => expect((await (await request("/api/v1/github/login", a.cookie)).json()).code).toBe("ABCD-1234"));
  expect(login.state("unrelated-session", a.id)).toEqual({ status: "busy" });
  expect((await request("/api/v1/github/login", b.cookie, { id: flowA.id }, "DELETE")).status).toBe(409);
  expect((await request("/api/v1/github/login", a.cookie, { id: flowA.id }, "DELETE")).status).toBe(200);
  writeFileSync(join(dir, "approve"), "yes");
  await vi.waitFor(async () => expect((await (await request("/api/v1/github/login", b.cookie)).json()).status).toBe("connected"));
  expect(db.prepare("SELECT 1 FROM github_connections WHERE user_id=?").get(a.id)).toBeUndefined();
  expect((await request("/api/v1/me", b.cookie, { confirmation: "b@example.test", password }, "DELETE")).status).toBe(200);
  expect(db.prepare("SELECT 1 FROM github_connections WHERE user_id=?").get(b.id)).toBeUndefined();
});

it("uses the schedule owner's connection when a due schedule starts a real run", async () => {
  connect(a.id, "fixture-token-a"); connect(b.id, "fixture-token-b");
  saveProviderSettings(db, cfg.secret, { connections: [{ id: "local", name: "Local", format: "openai", baseURL: "http://127.0.0.1:8000/v1", discover: false, models: [{ id: "coder", name: "Coder", contextWindow: 128000, maxOutput: 8192, reasoning: "none", images: false }] }] });
  db.prepare("INSERT INTO runners VALUES(?,?,1,?,?)").run("schedule-a", a.id, Date.now() - 1000, JSON.stringify({ name: "Daily", repo: "acme/app", model_id: "auto", prompt: "Work", frequency: "daily", minute: 60, timezone: "UTC", weekdays: [] }));
  await new Scheduler(db, runs).tick();
  const schedule = JSON.parse((db.prepare("SELECT data FROM runners WHERE id='schedule-a'").get() as { data: string }).data);
  expect(schedule.last.status).toBe("started");
  const run = runs.get(schedule.last.run_id);
  expect(run.user_id).toBe(a.id);
  await vi.waitFor(() => expect(readFileSync(join(dir, "calls"), "utf8")).toContain('"endpoint":"repos/acme/app","login":"developer-a"'));
});

it("requires an administrator for role changes and keeps one administrator transactionally", async () => {
  const role = (id: string) => `/api/v1/settings/people/${id}/role`;
  expect((await request("/api/v1/settings/people", b.cookie)).status).toBe(403);
  expect((await request(role(b.id), b.cookie, { admin: true }, "PUT")).status).toBe(403);
  expect((await request(role(a.id), a.cookie, { admin: false }, "PUT")).status).toBe(409);
  expect((await request(role(b.id), a.cookie, { admin: true }, "PUT")).status).toBe(200);
  expect((await request(role(a.id), b.cookie, { admin: false }, "PUT")).status).toBe(200);
  expect((await request(role(b.id), b.cookie, { admin: false }, "PUT")).status).toBe(409);
  const people = await (await request("/api/v1/settings/people", b.cookie)).json();
  expect(people.people.find((person: { id: string }) => person.id === b.id)).toMatchObject({ admin: true, methods: ["credential"] });
});

it("requires a fresh signed-in session for linking and cannot unlink the last sign-in method", async () => {
  expect((await request("/api/auth/link-social", "", { provider: "oidc" })).status).toBe(401);
  db.prepare('UPDATE session SET createdAt=? WHERE userId=?').run(Date.now() - 11 * 60000, b.id);
  expect((await request("/api/auth/link-social", b.cookie, { provider: "oidc" })).status).toBe(403);
  const methods = await (await request("/api/v1/me/sign-in-methods", a.cookie)).json();
  expect(methods.methods).toHaveLength(1);
  const result = await request("/api/auth/unlink-account", a.cookie, { accountId: methods.methods[0].id });
  expect(result.status).toBe(400);
  expect((await result.json()).code).toBe("FAILED_TO_UNLINK_LAST_ACCOUNT");
});

it("structurally forbids user-less GitHub credential resolution in service source", () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
  for (const path of files(join(import.meta.dirname, "../src"))) expect(readFileSync(path, "utf8")).not.toMatch(/\bgithubEnv\s*\(/);
});
