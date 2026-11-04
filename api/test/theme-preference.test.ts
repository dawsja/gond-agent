import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_THEME, THEMES, isTheme } from "../../shared/theme-preference";
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
const request = (path: string, cookie = "", body?: unknown, origin = cfg.origin) => instance.app.request(cfg.origin + path, {
  method: body === undefined ? "GET" : "PUT",
  headers: { cookie, origin, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
async function signup(email: string) {
  const result = await instance.app.request(cfg.origin + "/api/auth/sign-up/email", {
    method: "POST", headers: { origin: cfg.origin, "content-type": "application/json" },
    body: JSON.stringify({ name: "Test", email, password: "correct horse battery staple" }),
  });
  expect(result.status).toBe(200);
  const body = await result.json();
  return { id: body.user.id as string, cookie: result.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") };
}
const me = async (cookie: string) => {
  const result = await request("/api/v1/me", cookie);
  expect(result.status).toBe(200);
  return result.json();
};

describe("account theme preference", () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "gond-agent-theme-"));
    cfg = { data: dir, origin: "http://localhost:8787", secret: "fixture-theme-secret-at-least-32-characters", signup: true, port: 8787, dockerBin: "docker", workerImage: "unused", maxRuns: 2, runCPUs: 1, runMemoryMB: 2048 };
    await start();
  });
  afterEach(async () => { await stop(); rmSync(dir, { recursive: true, force: true }); });

  it("defaults fresh, missing and invalid stored preferences to system", async () => {
    expect(THEMES).toEqual(["system", "light", "dark"]);
    expect(DEFAULT_THEME).toBe("system");
    const user = await signup("owner@example.test");
    expect((await me(user.cookie)).theme).toBe("system");
    expect(db.prepare("SELECT theme FROM profiles WHERE user_id=?").get(user.id)).toEqual({ theme: "system" });
    db.prepare("DELETE FROM profiles WHERE user_id=?").run(user.id);
    expect((await me(user.cookie)).theme).toBe("system");
    db.prepare("UPDATE profiles SET theme='unsupported' WHERE user_id=?").run(user.id);
    expect((await me(user.cookie)).theme).toBe("system");
  });

  it("saves every supported value and keeps /me and other profile settings intact across restart", async () => {
    const user = await signup("owner@example.test");
    db.prepare("UPDATE profiles SET auto_pr=0 WHERE user_id=?").run(user.id);
    expect((await request("/api/v1/me/accent", user.cookie, { accent: "purple" })).status).toBe(200);
    for (const theme of THEMES) {
      expect(isTheme(theme)).toBe(true);
      const result = await request("/api/v1/me/theme", user.cookie, { theme });
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ theme });
      expect(await me(user.cookie)).toMatchObject({ theme, accent: "purple", automations: { auto_pr: false } });
    }
    await stop();
    await start();
    expect(await me(user.cookie)).toMatchObject({ theme: "dark", accent: "purple", automations: { auto_pr: false } });
  });

  it("rejects invalid values, body shapes and malformed JSON without changing the saved preference", async () => {
    const user = await signup("owner@example.test");
    await request("/api/v1/me/theme", user.cookie, { theme: "light" });
    for (const theme of [null, true, 1, "", "Dark", "auto", " dark ", [], {}]) {
      expect(isTheme(theme)).toBe(false);
      const result = await request("/api/v1/me/theme", user.cookie, { theme });
      expect(result.status).toBe(400);
      expect((await result.json()).error.code).toBe("invalid_request");
    }
    for (const body of [null, [], "dark", {}, { theme: "dark", user_id: user.id }])
      expect((await request("/api/v1/me/theme", user.cookie, body)).status).toBe(400);
    const malformed = await instance.app.request(cfg.origin + "/api/v1/me/theme", {
      method: "PUT", headers: { cookie: user.cookie, origin: cfg.origin, "content-type": "application/json" }, body: "{",
    });
    expect(malformed.status).toBe(400);
    expect((await me(user.cookie)).theme).toBe("light");
  });

  it("requires a same-origin session and lets non-administrators update only their own preference", async () => {
    const admin = await signup("admin@example.test"), member = await signup("member@example.test");
    expect((await me(member.cookie)).admin).toBe(false);
    expect((await request("/api/v1/me/theme", "", { theme: "dark" })).status).toBe(401);
    for (const origin of ["https://other.test", ""])
      expect((await request("/api/v1/me/theme", member.cookie, { theme: "dark" }, origin)).status).toBe(403);
    expect((await request("/api/v1/me/theme", member.cookie, { theme: "dark", user_id: admin.id })).status).toBe(400);
    // Saving also works for an account with no profile row yet.
    db.prepare("DELETE FROM profiles WHERE user_id=?").run(member.id);
    expect((await request("/api/v1/me/theme", member.cookie, { theme: "dark" })).status).toBe(200);
    expect((await me(member.cookie)).theme).toBe("dark");
    expect((await me(admin.cookie)).theme).toBe("system");
    expect((await request("/api/v1/me/theme", admin.cookie, { theme: "light" })).status).toBe(200);
    expect((await me(admin.cookie)).theme).toBe("light");
    expect((await me(member.cookie)).theme).toBe("dark");
  });
});

it("adds the theme column to existing profiles without losing data and preserves saved values on repeated opens", () => {
  const data = mkdtempSync(join(tmpdir(), "gond-agent-theme-migration-"));
  let store = new Database(join(data, "gond-agent.sqlite"));
  try {
    store.exec("CREATE TABLE profiles (user_id TEXT PRIMARY KEY, auto_pr INTEGER NOT NULL DEFAULT 1); INSERT INTO profiles(user_id,auto_pr) VALUES('existing',0)");
    store.close();
    store = openStore(data);
    expect(store.prepare("SELECT * FROM profiles").all()).toEqual([{ user_id: "existing", auto_pr: 0, theme: "system" }]);
    store.prepare("UPDATE profiles SET theme='light' WHERE user_id='existing'").run();
    store.close();
    store = openStore(data);
    expect(store.prepare("SELECT * FROM profiles").all()).toEqual([{ user_id: "existing", auto_pr: 0, theme: "light" }]);
  } finally {
    if (store.open) store.close();
    rmSync(data, { recursive: true, force: true });
  }
});
