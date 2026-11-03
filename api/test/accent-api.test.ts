import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCENTS, DEFAULT_ACCENT } from "../../shared/accents";
import { createApp } from "../src/app";
import { createAuthentication } from "../src/auth";
import type { Config } from "../src/config";
import { openStore } from "../src/db";
import { Runs } from "../src/runs/service";

let dir: string, db: ReturnType<typeof openStore>, cfg: Config;
let runs: Runs, instance: ReturnType<typeof createApp>;
async function start() {
  db = openStore(dir);
  const auth = await createAuthentication(db, cfg);
  runs = new Runs(db, cfg, async () => { throw new Error("No worker should start"); });
  instance = createApp(db, cfg, auth, runs);
}
async function stop() {
  await instance.githubLogin.close();
  await runs.shutdown();
  db.close();
}
function request(path: string, cookie = "", method = "GET", body?: string, origin: string | null = cfg.origin) {
  return instance.app.request(cfg.origin + path, {
    method,
    headers: { cookie, "content-type": "application/json", ...(origin === null ? {} : { origin }) },
    body,
  });
}
async function signup(email: string) {
  const response = await request("/api/auth/sign-up/email", "", "POST", JSON.stringify({ name: "Accent user", email, password: "correct horse battery staple" }));
  expect(response.status).toBe(200);
  const body = await response.json();
  return { id: body.user.id as string, cookie: response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ") };
}
type User = Awaited<ReturnType<typeof signup>>;
const me = async (user: User) => {
  const response = await request("/api/v1/me", user.cookie);
  expect(response.status).toBe(200);
  return response.json();
};
const save = (user: User, body: unknown) => request("/api/v1/me/accent", user.cookie, "PUT", JSON.stringify(body));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gond-accent-api-"));
  cfg = { data: dir, origin: "http://localhost:8787", secret: "fixture-accent-secret-at-least-32-characters", signup: true, port: 8787, dockerBin: "docker", workerImage: "unused", maxRuns: 2, runCPUs: 1, runMemoryMB: 2048 };
  await start();
});
afterEach(async () => { await stop(); rmSync(dir, { recursive: true, force: true }); });

it("defaults to blue and round-trips all seven accents without changing other profile preferences", async () => {
  const user = await signup("owner@example.test");
  expect(DEFAULT_ACCENT).toBe("blue");
  expect((await me(user)).accent).toBe("blue");
  expect(db.prepare("SELECT * FROM user_accents").all()).toEqual([]);
  db.prepare("UPDATE profiles SET auto_pr=0 WHERE user_id=?").run(user.id);
  expect((await request("/api/v1/me/theme", user.cookie, "PUT", JSON.stringify({ theme: "light" }))).status).toBe(200);
  expect(ACCENTS).toHaveLength(7);
  for (const accent of ACCENTS) {
    const response = await save(user, { accent });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accent });
    expect(await me(user)).toMatchObject({ accent, theme: "light", automations: { auto_pr: false } });
    expect(db.prepare("SELECT * FROM profiles WHERE user_id=?").get(user.id)).toEqual({ user_id: user.id, auto_pr: 0, theme: "light" });
    expect(db.prepare("SELECT * FROM user_accents WHERE user_id=?").get(user.id)).toEqual({ user_id: user.id, accent });
  }
  db.prepare("DELETE FROM user_accents WHERE user_id=?").run(user.id);
  expect((await me(user)).accent).toBe("blue");
  db.prepare("INSERT INTO user_accents(user_id,accent) VALUES(?,'invalid')").run(user.id);
  expect((await me(user)).accent).toBe("blue");
});

it("rejects malformed, invalid and extra fields without changing either account", async () => {
  const owner = await signup("owner@example.test"), other = await signup("other@example.test");
  expect((await save(owner, { accent: ACCENTS[1] })).status).toBe(200);
  const invalid = [undefined, "{", "null", "[]", '"blue"', "true", "7", ...[
    {}, { accent: null }, { accent: false }, { accent: 1 }, { accent: [] }, { accent: {} },
    { accent: "" }, { accent: "BLUE" }, { accent: " blue " }, { accent: "invalid" },
    { accent: "blue", user_id: other.id }, { accent: "blue", extra: true }, { user_id: other.id },
  ].map(body => JSON.stringify(body))];
  for (const body of invalid) {
    const response = await request("/api/v1/me/accent", owner.cookie, "PUT", body);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_accent");
  }
  const profiles = db.prepare("SELECT * FROM profiles").all();
  expect(profiles).toHaveLength(2);
  expect(profiles).toEqual(expect.arrayContaining([
    { user_id: owner.id, auto_pr: 1, theme: "system" },
    { user_id: other.id, auto_pr: 1, theme: "system" },
  ]));
  expect(db.prepare("SELECT * FROM user_accents").all()).toEqual([{ user_id: owner.id, accent: ACCENTS[1] }]);
  expect((await me(owner)).accent).toBe(ACCENTS[1]);
  expect((await me(other)).accent).toBe("blue");
});

it("allows nonadministrators to update only their own preference, including a missing profile", async () => {
  const admin = await signup("admin@example.test"), member = await signup("member@example.test");
  expect((await me(admin)).admin).toBe(true);
  expect((await me(member)).admin).toBe(false);
  db.prepare("DELETE FROM profiles WHERE user_id=?").run(member.id);
  expect((await save(member, { accent: ACCENTS[1] })).status).toBe(200);
  expect((await me(member)).accent).toBe(ACCENTS[1]);
  expect((await me(admin)).accent).toBe("blue");
  expect((await save(admin, { accent: ACCENTS[2] })).status).toBe(200);
  expect((await me(admin)).accent).toBe(ACCENTS[2]);
  expect((await me(member)).accent).toBe(ACCENTS[1]);
});

it("requires authentication and the configured origin for writes", async () => {
  const user = await signup("owner@example.test");
  expect((await request("/api/v1/me")).status).toBe(401);
  expect((await request("/api/v1/me/accent", "", "PUT", '{"accent":"blue"}')).status).toBe(401);
  for (const origin of [null, "https://other.test"]) {
    const response = await request("/api/v1/me/accent", user.cookie, "PUT", '{"accent":"blue"}', origin);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("origin");
  }
  expect((await me(user)).accent).toBe("blue");
});

it("migrates old profiles and preserves accents, auto_pr, photos and account data across reopen and cleanup", async () => {
  const user = await signup("owner@example.test");
  db.prepare("UPDATE profiles SET auto_pr=0 WHERE user_id=?").run(user.id);
  db.prepare("INSERT INTO profile_photos(user_id,revision,bytes) VALUES(?,?,?)").run(user.id, "kept", Buffer.from("photo"));
  // Simulate a pre-accent database while retaining real auth tables and sessions.
  db.exec("DROP TABLE user_accents; ALTER TABLE profiles ADD COLUMN retired_preference TEXT");
  await stop();
  await start();
  expect(await me(user)).toMatchObject({ accent: "blue", automations: { auto_pr: false }, user: { id: user.id, email: "owner@example.test", has_photo: true } });
  expect((await save(user, { accent: ACCENTS[1] })).status).toBe(200);
  // Retired profile cleanup must stay independent of the account's saved accent.
  db.exec("ALTER TABLE profiles ADD COLUMN retired_preference TEXT");
  await stop();
  await start();
  expect(await me(user)).toMatchObject({ accent: ACCENTS[1], automations: { auto_pr: false }, user: { id: user.id, email: "owner@example.test", has_photo: true } });
  expect(db.prepare("SELECT * FROM profiles").all()).toEqual([{ user_id: user.id, auto_pr: 0, theme: "system" }]);
  expect(db.prepare("SELECT * FROM user_accents").all()).toEqual([{ user_id: user.id, accent: ACCENTS[1] }]);
  expect((db.pragma("table_info(profiles)") as { name: string }[]).map(column => column.name)).toEqual(["user_id", "auto_pr", "theme"]);
  expect(db.prepare("SELECT revision,bytes FROM profile_photos WHERE user_id=?").get(user.id)).toEqual({ revision: "kept", bytes: Buffer.from("photo") });
});

it("cascades account deletion to its accent without removing another account's preference", async () => {
  const owner = await signup("owner@example.test"), other = await signup("other@example.test");
  expect((await save(owner, { accent: ACCENTS[1] })).status).toBe(200);
  expect((await save(other, { accent: ACCENTS[2] })).status).toBe(200);
  db.prepare('DELETE FROM "user" WHERE id=?').run(owner.id);
  expect(db.prepare("SELECT * FROM user_accents").all()).toEqual([{ user_id: other.id, accent: ACCENTS[2] }]);
  expect((await me(other)).accent).toBe(ACCENTS[2]);
});
