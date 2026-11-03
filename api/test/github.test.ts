import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { command } from "../src/command";
import { gh, checkout, importBundle, cloneProgress, commitIdentity } from "../src/github";
vi.mock("../src/command", () => ({ command: vi.fn(async () => Buffer.from('{"login":"fixture","id":123}')) }));
afterEach(() => vi.restoreAllMocks());

describe("service GitHub credential routing", () => {
  it("passes credentials to API/clone/push commands without writing them into arguments or global Git config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gond-agent-git-"));
    const env = { PATH: process.env.PATH, GH_TOKEN: "test-managed-token" };
    try {
      vi.mocked(command).mockClear();
      await gh("user", "GET", undefined, env);
      await checkout(dir, "run_test", "acme/app", "main", "gond-agent/test", false, env);
      const cwd = join(dir, "checkouts", "run_test"); mkdirSync(join(cwd, ".git"), { recursive: true });
      await importBundle(cwd, Buffer.from("fixture"), "gond-agent/test", env);
      const calls = vi.mocked(command).mock.calls;
      expect(calls.filter(([file]) => file === "gh").length).toBe(2);
      expect(calls.filter(([, args]) => args.includes("clone") || args.includes("push") || args.includes("api")).map(([, , opts]) => opts?.env?.GH_TOKEN === "test-managed-token")).toEqual([true, true, true, true]);
      expect(JSON.stringify(calls.map(([file, args]) => [file, args]))).not.toMatch(/test-managed-token|setup-git|--global/);
      const clone = calls.find(([, args]) => args.includes("clone"))!;
      expect(clone[1]).toContain("https://github.com/acme/app.git");
      expect(clone[1]).toContain("credential.https://github.com.helper=!gh auth git-credential");
      expect(clone[1]).toEqual(expect.arrayContaining(["--depth", "1", "--single-branch", "--no-tags", "--progress"]));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("reports bounded progress from split Git output without forwarding raw logs or secrets", () => {
    const report = vi.fn(), progress = cloneProgress(report);
    const now = vi.spyOn(Date, "now").mockReturnValue(2000);
    progress("Receiving obj"); progress("ects: 12% (12/100)\r");
    progress("Receiving objects: 13% (13/100)\r");
    now.mockReturnValue(3100);
    progress("Receiving objects: 50% (50/100)\r");
    progress("Resolving deltas: 100% (20/20)\rprivate-token-and-URL\n");
    expect(report.mock.calls.map(call => call[0])).toEqual(["Downloading repository (12%)", "Downloading repository (50%)", "Preparing repository (100%)"]);
  });
  it.each(["clone", "archive", "oversized"])("returns a plain actionable error for %s failures", async failure => {
    const dir = mkdtempSync(join(tmpdir(), "gond-agent-git-error-"));
    const progress: string[] = [];
    try {
      vi.mocked(command).mockImplementation(async (file, args) => {
        if ((failure === "clone" && args.includes("clone")) || (failure !== "clone" && file === "tar")) throw new Error(failure === "oversized" ? "tar failed (ERR_CHILD_PROCESS_STDIO_MAXBUFFER)" : "private-upstream-error");
        return Buffer.from('{"login":"fixture","id":123}');
      });
      const error = await checkout(dir, "run_test", "acme/app", "main", "gond-agent/test", false, {}, step => progress.push(step)).catch(error => error);
      expect(error.code).toBe(failure === "clone" ? "checkout_failed" : failure === "oversized" ? "repository_too_large" : "archive_failed");
      expect(error.message).not.toContain("private-upstream-error");
      expect(progress[0]).toBe("Cloning repository");
    } finally { vi.mocked(command).mockImplementation(async () => Buffer.from('{"login":"fixture","id":123}')); rmSync(dir, { recursive: true, force: true }); }
  });
});


it("resolves and caches connected identity, with explicit overrides and no invented fallback", async () => {
  vi.mocked(command).mockClear();
  const env = { GH_TOKEN:"identity-test-token" };
  expect(await commitIdentity(env)).toEqual({name:"fixture",email:"123+fixture@users.noreply.github.com"});
  expect(await commitIdentity({...env,GOND_AGENT_COMMIT_NAME:"Custom",GOND_AGENT_COMMIT_EMAIL:"custom@example.test"})).toEqual({name:"Custom",email:"custom@example.test"});
  expect(vi.mocked(command)).toHaveBeenCalledTimes(1);
  vi.mocked(command).mockResolvedValueOnce(Buffer.from("{}"));
  await expect(commitIdentity({GH_TOKEN:"missing-identity"})).rejects.toMatchObject({code:"github_identity"});
});

it("refreshes cached commit identity after one hour", async () => {
  const env = {GH_TOKEN:"expiring-identity-test"};
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    await commitIdentity(env);
    clock.mockReturnValue(now + 3600_001);
    vi.mocked(command).mockResolvedValueOnce(Buffer.from('{"login":"renamed","id":123}'));
    expect(await commitIdentity(env)).toEqual({name:"renamed",email:"123+renamed@users.noreply.github.com"});
  } finally { clock.mockRestore(); }
});

it("invalidates cached identities after a GitHub request failure", async () => {
  const env = {GH_TOKEN:"revoked-identity-test"};
  await commitIdentity(env);
  vi.mocked(command).mockRejectedValueOnce(new Error("HTTP 401"));
  await expect(gh("user", "GET", undefined, env)).rejects.toThrow("HTTP 401");
  vi.mocked(command).mockResolvedValueOnce(Buffer.from('{"login":"reconnected","id":456}'));
  expect(await commitIdentity(env)).toEqual({name:"reconnected",email:"456+reconnected@users.noreply.github.com"});
});
