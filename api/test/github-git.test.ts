import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { command } from "../src/command";
import { checkout, importBundle } from "../src/github";

describe("real service Git operations", () => {
  it("clones, imports a worker bundle and pushes without persisting credentials or changing global helpers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gond-agent-github-git-"));
    try {
      const remote = join(dir, "remote"), home = join(dir, "home");
      await mkdir(remote); await mkdir(home);
      const marker = "[user]\n\tname = Unchanged\n";
      await writeFile(join(home, ".gitconfig"), marker);
      const env = { ...process.env, HOME: home, GH_TOKEN: "test-managed-token", GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.file://${remote}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/acme/app.git" };
      const git = (cwd: string, ...args: string[]) => command("git", args, { cwd, env });
      await git(remote, "init", "-b", "main");
      await writeFile(join(remote, "base.txt"), "base\n");
      await git(remote, "add", ".");
      await git(remote, "-c", "user.email=test@example.test", "commit", "-m", "fixture");
      // Rewrite only this test's command environment to a local remote; no GitHub account is used.
      const { cwd, archive } = await checkout(dir, "run_fixture", "acme/app", "main", "gond-agent/fixture", false, env);
      expect(gunzipSync(archive).includes(Buffer.from("test-managed-token"))).toBe(false);
      const config = await readFile(join(cwd, ".git", "config"), "utf8");
      expect(config).toContain("https://github.com/acme/app.git");
      expect(config).not.toMatch(/credential|helper|test-managed-token/);
      const worker = join(dir, "worker");
      await git(dir, "clone", cwd, worker);
      await writeFile(join(worker, "change.txt"), "implemented\n");
      await git(worker, "add", ".");
      await git(worker, "-c", "user.email=test@example.test", "commit", "-m", "worker result");
      const bundle = join(dir, "worker.bundle");
      await git(worker, "bundle", "create", bundle, "HEAD");
      await importBundle(cwd, await readFile(bundle), "gond-agent/fixture", env);
      expect((await git(remote, "show", "gond-agent/fixture:change.txt")).toString()).toBe("implemented\n");
      expect(await readFile(join(home, ".gitconfig"), "utf8")).toBe(marker);
      expect(await readFile(join(cwd, ".git", "config"), "utf8")).toBe(config);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
