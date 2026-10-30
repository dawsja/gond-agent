import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { command } from "../src/command";
import { gh, checkout, importBundle } from "../src/github";
vi.mock("../src/command", () => ({ command: vi.fn(async () => Buffer.from("{}")) }));

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
      expect(calls.filter(([file]) => file === "gh").length).toBe(1);
      expect(calls.filter(([, args]) => args.includes("clone") || args.includes("push") || args.includes("api")).map(([, , opts]) => opts?.env?.GH_TOKEN === "test-managed-token")).toEqual([true, true, true]);
      expect(JSON.stringify(calls.map(([file, args]) => [file, args]))).not.toMatch(/test-managed-token|setup-git|--global/);
      const clone = calls.find(([, args]) => args.includes("clone"))!;
      expect(clone[1]).toContain("https://github.com/acme/app.git");
      expect(clone[1]).toContain("credential.https://github.com.helper=!gh auth git-credential");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
