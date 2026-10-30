import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
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
      await writeFile(join(remote, "old.bin"), randomBytes(4 * 1024 * 1024));
      await git(remote, "add", ".");
      await git(remote, "-c", "user.email=test@example.test", "commit", "-m", "large old history");
      await unlink(join(remote, "old.bin"));
      await writeFile(join(remote, "base.txt"), "base\n");
      await git(remote, "add", ".");
      await git(remote, "-c", "user.email=test@example.test", "commit", "-m", "fixture");
      // Rewrite only this test's command environment to a local remote; no GitHub account is used.
      const { cwd, archive } = await checkout(dir, "run_fixture", "acme/app", "main", "gond-agent/fixture", false, env);
      expect((await git(cwd, "rev-parse", "--is-shallow-repository")).toString().trim()).toBe("true");
      expect((await git(cwd, "rev-list", "--count", "HEAD")).toString().trim()).toBe("1");
      expect(archive.length).toBeLessThan(100000);
      const baseSHA = (await git(cwd, "rev-parse", "HEAD")).toString().trim();
      expect(gunzipSync(archive).includes(Buffer.from("test-managed-token"))).toBe(false);
      const config = await readFile(join(cwd, ".git", "config"), "utf8");
      expect(config).toContain("https://github.com/acme/app.git");
      expect(config).not.toMatch(/credential|helper|test-managed-token/);
      const worker = join(dir, "worker");
      await mkdir(worker);
      await command("tar", ["-xzf", "-", "-C", worker], { input: archive });
      // Read-only turns can export their unchanged shallow HEAD too.
      const unchanged = join(dir, "unchanged.bundle");
      await git(worker, "bundle", "create", unchanged, "HEAD");
      await git(cwd, "bundle", "verify", unchanged);
      await writeFile(join(worker, "change.txt"), "implemented\n");
      await git(worker, "add", ".");
      await git(worker, "-c", "user.email=test@example.test", "commit", "-m", "worker result");
      const bundle = join(dir, "worker.bundle");
      await git(worker, "bundle", "create", bundle, "HEAD");
      await importBundle(cwd, await readFile(bundle), "gond-agent/fixture", env);
      expect((await git(remote, "show", "gond-agent/fixture:change.txt")).toString()).toBe("implemented\n");
      expect((await git(remote, "rev-list", "--count", "main")).toString().trim()).toBe("2");
      // Recovery clones only the saved run branch, retaining the same HEAD for follow-ups.
      const resumed = await checkout(dir, "run_resumed", "acme/app", "main", "gond-agent/fixture", true, env, () => {}, baseSHA);
      expect((await git(resumed.cwd, "show", "HEAD:change.txt")).toString()).toBe("implemented\n");
      expect((await git(resumed.cwd, "rev-list", "--count", "HEAD")).toString().trim()).toBe("1");
      expect((await git(resumed.cwd, "diff", baseSHA, "HEAD")).toString()).toContain("implemented");
      const resumedWorker = join(dir, "resumed-worker"); await mkdir(resumedWorker);
      await command("tar", ["-xzf", "-", "-C", resumedWorker], { input: resumed.archive });
      await writeFile(join(resumedWorker, "followup.txt"), "follow-up\n");
      await git(resumedWorker, "add", ".");
      await git(resumedWorker, "-c", "user.email=test@example.test", "commit", "-m", "follow-up result");
      const followup = join(dir, "followup.bundle"); await git(resumedWorker, "bundle", "create", followup, "HEAD");
      await importBundle(resumed.cwd, await readFile(followup), "gond-agent/fixture", env);
      expect((await git(resumed.cwd, "diff", baseSHA, "HEAD")).toString()).toContain("follow-up");
      expect((await git(remote, "show", "gond-agent/fixture:followup.txt")).toString()).toBe("follow-up\n");
      expect(await readFile(join(home, ".gitconfig"), "utf8")).toBe(marker);
      expect(await readFile(join(cwd, ".git", "config"), "utf8")).toBe(config);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
