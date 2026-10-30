import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore, getSetting, setSetting } from "../src/db";
import { seal } from "../src/auth";
import { GithubLogin, deviceLogin, githubEnv, type LoginDriver } from "../src/github-login";

const secret = "fixture-auth-secret-at-least-32-characters";
let dir: string, db: ReturnType<typeof openStore>, login: GithubLogin;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gond-agent-github-")); db = openStore(dir); });
afterEach(async () => { vi.useRealTimers(); await login?.close(); db.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function deferred() {
  let resolve!: (token: string) => void, reject!: (e: Error) => void, code!: (value: string) => void;
  const token = new Promise<string>((ok, no) => { resolve = ok; reject = no; });
  const cancel = vi.fn();
  const driver: LoginDriver = (_root, callback) => { code = callback; return { token, cancel }; };
  return { driver, resolve, reject, cancel, code: (value: string) => code(value) };
}
describe("GitHub browser authorization", () => {
  it("only shares the device code with its initiating session, saves encrypted credentials and survives restart", async () => {
    const job = deferred(); login = new GithubLogin(db, secret, dir, job.driver);
    const flow = login.start("session-a");
    expect(login.start("session-a").id).toBe(flow.id);
    job.code("ABCD-1234");
    expect(login.state("session-a")).toMatchObject({ status: "pending", code: "ABCD-1234", url: "https://github.com/login/device" });
    expect(login.state("session-b")).toEqual({ status: "busy" });
    expect(() => login.start("session-b")).toThrow(/Another administrator/);
    expect(() => login.cancel("session-b", flow.id!)).toThrow(/another session/);
    job.resolve("fixture-token");
    await vi.waitFor(() => expect(login.state("session-a").status).toBe("connected"));
    expect(JSON.stringify(getSetting(db, "github"))).not.toContain("fixture-token");
    expect(JSON.stringify(login.state("session-a"))).not.toMatch(/fixture-token|ABCD/);
    expect(githubEnv(db, secret).GH_TOKEN === "fixture-token").toBe(true);
    expect(process.env.GH_TOKEN === "fixture-token").toBe(false);
    await login.close(); db.close(); db = openStore(dir);
    expect(githubEnv(db, secret).GH_TOKEN === "fixture-token").toBe(true);
  });
  it.each(["cancel", "expire", "signout", "shutdown"])("never persists late approval after %s", async mode => {
    const job = deferred(); login = new GithubLogin(db, secret, dir, job.driver);
    setSetting(db, "github", { token: seal(secret, "old-credential") });
    vi.useFakeTimers();
    const flow = login.start("owner", async () => mode !== "signout"); job.code("ABCD-1234");
    if (mode === "cancel") login.cancel("owner", flow.id!);
    if (mode === "expire") await vi.advanceTimersByTimeAsync(10 * 60000);
    const closed = mode === "shutdown" ? login.close() : undefined;
    job.resolve("late-credential");
    await Promise.resolve(); await Promise.resolve(); await closed;
    expect(githubEnv(db, secret).GH_TOKEN === "old-credential").toBe(true);
    expect(login.state("owner")).not.toHaveProperty("code");
    expect(login.state("owner").status).toBe(mode === "expire" ? "expired" : "cancelled");
  });
  it("does not leak upstream errors and rejects stale cancellation IDs", async () => {
    const job = deferred(); login = new GithubLogin(db, secret, dir, job.driver);
    login.start("owner");
    expect(() => login.cancel("owner", "stale-id")).toThrow(/another session/);
    job.reject(new Error("sensitive-upstream-response"));
    await vi.waitFor(() => expect(login.state("owner").status).toBe("error"));
    expect(JSON.stringify(login.state("owner"))).not.toContain("sensitive-upstream-response");
  });
  it.each(["approve", "approve-old", "fail", "cancel"])("runs the real subprocess driver with isolated config and cleans up on %s", async scenario => {
    const mode = scenario === "approve-old" ? "approve" : scenario;
    const bin = join(dir, "bin"), fixture = join(dir, "fixture"); mkdirSync(bin); mkdirSync(fixture);
    writeFileSync(join(bin, "gh"), readFileSync(new URL("./fixtures/gh.cjs", import.meta.url)), { mode: 0o700 });
    if (scenario === "approve-old") writeFileSync(join(fixture, "old"), "yes");
    vi.stubEnv("PATH", bin + ":" + process.env.PATH);
    vi.stubEnv("GH_TOKEN", "inherited-token-must-not-be-used");
    vi.stubEnv("GITHUB_TOKEN", "inherited-token-must-not-be-used");
    vi.stubEnv("GOND_AGENT_GH_FIXTURE_DIR", fixture);
    login = new GithubLogin(db, secret, dir, deviceLogin); const flow = login.start("owner");
    await vi.waitFor(() => expect(login.state("owner").code).toBe("ABCD-1234"));
    expect(statSync(join(dir, "github-login")).mode & 0o777).toBe(0o700);
    if (mode === "cancel") login.cancel("owner", flow.id!);
    else writeFileSync(join(fixture, mode), "yes");
    await vi.waitFor(() => expect(login.state("owner").status).toBe(mode === "approve" ? "connected" : mode === "fail" ? "error" : "cancelled"));
    await login.close();
    expect(readdirSync(join(dir, "github-login"))).toEqual([]);
    expect(JSON.stringify(login.state("owner"))).not.toMatch(/sensitive-upstream-response|fixture-only-github-token/);
    expect(!!getSetting(db, "github")).toBe(mode === "approve");
  });
});
