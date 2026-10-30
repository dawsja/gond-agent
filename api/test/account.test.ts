import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore, getSetting, setSetting } from "../src/db";
import { createAuthentication, seal } from "../src/auth";
import { createApp } from "../src/app";
import { Runs } from "../src/runs/service";
import type { Config } from "../src/config";

let dir: string, db: ReturnType<typeof openStore>, auth: Awaited<ReturnType<typeof createAuthentication>>;
let runs: Runs, instance: ReturnType<typeof createApp>, cfg: Config;
const password = "correct horse battery staple";
const request = (path: string, cookie = "", body?: unknown, method = body === undefined ? "GET" : "POST", origin = cfg.origin) => instance.app.request(cfg.origin + path, {
  method, headers: { cookie, origin, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body),
});
async function signup(email: string) {
  const result = await request("/api/auth/sign-up/email", "", { name: "Test", email, password });
  expect(result.status).toBe(200);
  const body = await result.json();
  return { id: body.user.id as string, email, cookie: result.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") };
}
type User = Awaited<ReturnType<typeof signup>>;
const remove = (user: User, body: unknown = { confirmation: user.email, password }) => request("/api/v1/me", user.cookie, body, "DELETE");
function history(user: User, suffix: string, status = "ready") {
  const id = `run_${suffix.repeat(24)}`, schedule = `runner_${suffix.repeat(24)}`;
  db.prepare("INSERT INTO runs(id,user_id,repo,status,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?)")
    .run(id, user.id, "acme/app", status, 1, 1, JSON.stringify({ id, user_id: user.id, status, phase: "idle", pending: [] }));
  db.prepare("INSERT INTO events(run_id,data) VALUES(?,?)").run(id, '{"type":"user","text":"Keep scoped"}');
  db.prepare("INSERT INTO images(id,user_id,run_id,media_type,bytes,created_at) VALUES(?,?,?,?,?,?)").run(`image_${suffix}`, user.id, id, "image/png", Buffer.from("image"), 1);
  db.prepare("INSERT INTO images(id,user_id,media_type,bytes,created_at) VALUES(?,?,?,?,?)").run(`pending_${suffix}`, user.id, "image/png", Buffer.from("image"), 1);
  db.prepare("INSERT INTO runners(id,user_id,enabled,next_run_at,data) VALUES(?,?,?,?,?)").run(schedule, user.id, 1, 1, "{}");
  db.prepare("INSERT INTO occurrences(key,created_at) VALUES(?,?)").run(`schedule:${schedule}:1`, 1);
  db.prepare("INSERT INTO usage(user_id,run_id,model_id,input,output,cache_read,cost_micros,created_at) VALUES(?,?,?,?,?,?,?,?)").run(user.id, id, "model", 1, 1, 0, 0, 1);
  db.prepare("INSERT INTO profile_photos(user_id,revision,bytes) VALUES(?,?,?)").run(user.id, "fixture", Buffer.from("photo"));
  const checkout = join(dir, "checkouts", id); mkdirSync(checkout, { recursive: true }); writeFileSync(join(checkout, "fixture.txt"), "checkout");
  return { id, schedule, checkout };
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gond-agent-account-"));
  cfg = { data: dir, origin: "http://localhost:8787", secret: "fixture-account-secret-at-least-32-characters", signup: true, port: 8787, dockerBin: "docker", workerImage: "unused", maxRuns: 2, runCPUs: 1, runMemoryMB: 2048, idleMs: 60000, turnMs: 60000 };
  db = openStore(dir); auth = await createAuthentication(db, cfg);
  runs = new Runs(db, cfg, async () => { throw new Error("No worker should start"); });
  instance = createApp(db, cfg, auth, runs);
});
afterEach(async () => {
  await instance.githubLogin.close(); await runs.shutdown(); db.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks();
});
describe("confirmed account deletion", () => {
  it("requires an authenticated same-origin request, exact confirmation and a verified password", async () => {
    const user = await signup("owner@example.test");
    expect((await request("/api/v1/me", "", { confirmation: user.email, password }, "DELETE")).status).toBe(401);
    expect((await request("/api/v1/me", user.cookie, { confirmation: user.email, password }, "DELETE", "https://other.test")).status).toBe(403);
    expect((await remove(user, {})).status).toBe(400);
    expect((await remove(user, { confirmation: "someone@example.test", password })).status).toBe(400);
    expect((await remove(user, { confirmation: user.email })).status).toBe(400);
    const wrong = await remove(user, { confirmation: user.email, password: "incorrect password" });
    expect(wrong.status).toBe(400); expect((await wrong.json()).error.code).toBe("invalid_password");
    expect((await request("/api/auth/delete-user", user.cookie, { password })).status).toBe(404);
    expect((await request("/api/v1/me", user.cookie)).status).toBe(200);
    expect((await remove(user)).status).toBe(200);
  });
  it("erases only the current account and all of its local data, retaining other accounts and connections", async () => {
    const admin = await signup("admin@example.test"), user = await signup("member@example.test");
    const kept = history(admin, "a"), erased = history(user, "b");
    setSetting(db, "providers", { connections: [{ id: "kept" }] });
    const result = await remove(user);
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ ok: true, setup_reset: false });
    expect(result.headers.getSetCookie().some(c => c.includes("Max-Age=0"))).toBe(true);
    expect((await request("/api/v1/me", user.cookie)).status).toBe(401);
    for (const table of ["profiles", "profile_photos", "images", "runners", "runs", "usage", "administrators"])
      expect(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id=?`).get(user.id)).toEqual({ n: 0 });
    for (const table of ["session", "account"]) expect(db.prepare(`SELECT count(*) AS n FROM "${table}" WHERE userId=?`).get(user.id)).toEqual({ n: 0 });
    expect(db.prepare("SELECT 1 FROM events WHERE run_id=?").get(erased.id)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM occurrences WHERE key=?").get(`schedule:${erased.schedule}:1`)).toBeUndefined();
    expect(existsSync(erased.checkout)).toBe(false); expect(existsSync(kept.checkout)).toBe(true);
    expect(db.prepare("SELECT 1 FROM events WHERE run_id=?").get(kept.id)).toBeDefined();
    expect(getSetting(db, "providers")).toEqual({ connections: [{ id: "kept" }] });
    expect((await request("/api/v1/me", admin.cookie)).status).toBe(200);
  });
  it("does not orphan remaining accounts by deleting their only administrator", async () => {
    const admin = await signup("admin@example.test"), member = await signup("member@example.test");
    const policy = await (await request("/api/v1/me/deletion", admin.cookie)).json();
    expect(policy.last_account).toBe(false); expect(policy.blocked_reason).toContain("administrator");
    expect((await remove(admin)).status).toBe(409);
    expect((await request("/api/v1/me", member.cookie)).status).toBe(200);
    db.prepare("INSERT INTO administrators(user_id) VALUES(?)").run(member.id);
    expect((await remove(admin)).status).toBe(200);
    expect((await (await request("/api/v1/me", member.cookie)).json()).admin).toBe(true);
  });
  it("returns an empty instance to administrator registration and model setup, even with registration closed", async () => {
    cfg.signup = false;
    const user = await signup("only@example.test"); history(user, "c");
    setSetting(db, "providers", { connections: [{ id: "old" }] });
    setSetting(db, "github", { token: seal(cfg.secret, "old-github-secret") });
    setSetting(db, "oidc", { enabled: true, name: "Old SSO", issuer: "https://issuer.example.test", clientId: "old", secret: seal(cfg.secret, "old-oidc-secret") });
    const result = await remove(user);
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ ok: true, setup_reset: true });
    for (const key of ["providers", "github", "oidc"]) expect(getSetting(db, key)).toBeNull();
    expect(auth.providers()).toEqual([]);
    expect(await (await request("/api/auth/bootstrap")).json()).toEqual({ firstAccount: true, signupAllowed: true, providers: [] });
    const next = await signup("new-owner@example.test"), me = await (await request("/api/v1/me", next.cookie)).json();
    expect(me.admin).toBe(true); expect(me.setup_required).toBe(true);
    expect((await request("/api/v1/me", user.cookie)).status).toBe(401);
  });
  it("blocks active runs, preserves data on cleanup failure and allows a later retry", async () => {
    const user = await signup("owner@example.test"), run = history(user, "d", "working");
    const active = await remove(user); expect(active.status).toBe(409); expect((await active.json()).error.code).toBe("active_runs");
    expect((await request("/api/v1/me", user.cookie)).status).toBe(200);
    db.prepare("UPDATE runs SET status='ready' WHERE id=?").run(run.id);
    vi.spyOn(runs, "close").mockRejectedValueOnce(new Error("fixture cleanup failure"));
    expect((await remove(user)).status).toBe(500);
    expect(db.prepare('SELECT 1 FROM "user" WHERE id=?').get(user.id)).toBeDefined();
    expect(existsSync(run.checkout)).toBe(true);
    expect((await remove(user)).status).toBe(200);
  });
  it("limits password guesses without deleting the account", async () => {
    const user = await signup("owner@example.test");
    for (let n = 0; n < 5; n++) expect((await remove(user, { confirmation: user.email, password: "incorrect password" })).status).toBe(400);
    expect((await remove(user)).status).toBe(429);
    expect((await request("/api/v1/me", user.cookie)).status).toBe(200);
  });
  it("requires a recent sign-in for passwordless accounts", async () => {
    const user = await signup("oidc@example.test");
    db.prepare('DELETE FROM "account" WHERE userId=?').run(user.id);
    db.prepare('UPDATE "session" SET createdAt=? WHERE userId=?').run(Date.now() - 16 * 60000, user.id);
    expect((await remove(user, { confirmation: user.email })).status).toBe(403);
    db.prepare('UPDATE "session" SET createdAt=? WHERE userId=?').run(Date.now(), user.id);
    expect((await remove(user, { confirmation: user.email })).status).toBe(200);
  });
  it("cleans local records and last-account connections atomically with the user deletion", async () => {
    const user = await signup("owner@example.test"), run = history(user, "f");
    setSetting(db, "github", { kept: true });
    expect(() => db.transaction(() => {
      db.prepare('DELETE FROM "user" WHERE id=?').run(user.id);
      expect(db.prepare("SELECT 1 FROM runs WHERE id=?").get(run.id)).toBeUndefined();
      expect(getSetting(db, "github")).toBeNull();
      throw new Error("rollback fixture");
    })()).toThrow("rollback fixture");
    expect((await request("/api/v1/me", user.cookie)).status).toBe(200);
    expect(db.prepare("SELECT 1 FROM runs WHERE id=?").get(run.id)).toBeDefined();
    expect(getSetting(db, "github")).toEqual({ kept: true });
  });
  it("serializes last-account deletion and registration so the new owner always gets fresh setup", async () => {
    const user = await signup("old@example.test"); history(user, "e");
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const original = runs.close.bind(runs), close = vi.spyOn(runs, "close").mockImplementationOnce(async id => { await waiting; await original(id); });
    const deleting = remove(user);
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    const registering = signup("new@example.test");
    release();
    expect((await deleting).status).toBe(200);
    const next = await registering;
    const me = await (await request("/api/v1/me", next.cookie)).json();
    expect(me.admin).toBe(true); expect(me.setup_required).toBe(true);
    expect(db.prepare('SELECT count(*) AS n FROM "user"').get()).toEqual({ n: 1 });
  });
});
