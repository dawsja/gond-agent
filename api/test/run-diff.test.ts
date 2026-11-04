import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../src/command";
import { Runs, type Run } from "../src/runs/service";
import { emptySummary } from "../src/runs/fold";
import { preferPullDiff } from "../src/runs/diff";

vi.mock("../src/github-login", () => ({ githubEnvFor: () => process.env }));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "run-diff-")); dirs.push(dir);
  const remote = join(dir, "remote"), cwd = join(dir, "checkout");
  await mkdir(remote);
  const env = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_EMAIL: "fixture@example.test" };
  const git = async (where: string, ...args: string[]) => (await command("git", args, { cwd: where, env })).toString().trim();
  const commit = async (where: string, title: string) => { await git(where, "add", "."); await git(where, "commit", "-m", title); };
  await git(remote, "init", "-b", "main");
  await writeFile(join(remote, "base.txt"), "base\n");
  await writeFile(join(remote, "rename-me.txt"), "unchanged rename content\n"); await commit(remote, "base");
  const base = await git(remote, "rev-parse", "HEAD");
  await git(dir, "clone", "--depth", "1", "--single-branch", "--no-tags", `file://${remote}`, cwd);
  await git(cwd, "checkout", "-b", "fix/run");
  await writeFile(join(cwd, "own.txt"), "own change\n"); await commit(cwd, "own change");
  for (let i = 0; i < 40; i++) await writeFile(join(remote, `main-${i}.txt`), "main change\n".repeat(100));
  await commit(remote, "later main");
  await git(cwd, "fetch", "origin", "main"); await git(cwd, "merge", "--no-edit", "origin/main");
  const head = await git(cwd, "rev-parse", "HEAD");
  const run = { id: "run", user_id: "owner", repo: "acme/app", base_branch: "main", base_sha: base, head_sha: head, status: "ready", pending: [], pr_number: null, files: 0, additions: 0, deletions: 0, summary: emptySummary() } as unknown as Run;
  const events: unknown[] = [];
  const service = Object.assign(Object.create(Runs.prototype), {
    cfg: { secret: "test" }, db: {},
    get: () => structuredClone(run), save: (next: Run) => Object.assign(run, next),
    append: (_id: string, event: unknown) => events.push(event),
    pullRequests: { metadata: vi.fn(async () => new Map()) },
  });
  const record = () => service.recordDiff("run", { cwd }, head, true);
  return { dir, cwd, remote, base, head, git, commit, run, record, events, service };
}

it("records PR-style text, totals and per-file counts after a shallow branch merges later main", async () => {
  const f = await fixture();
  const stale = await f.git(f.cwd, "diff", "--shortstat", f.base, f.head);
  const expected = await f.git(f.cwd, "diff", "--shortstat", "origin/main...HEAD");
  console.log(`git diff --shortstat <original-base> HEAD\n${stale}\ngit diff --shortstat origin/main...HEAD\n${expected}`);
  expect(stale).toContain("41 files changed, 4001 insertions(+)");
  expect(expected).toContain("1 file changed, 1 insertion(+)");
  // A still newer remote base must be refreshed, not just the tracking ref read.
  await writeFile(join(f.remote, "remote-only.txt"), "not this run\n"); await f.commit(f.remote, "newer remote main");
  const remoteHead = await f.git(f.remote, "rev-parse", "HEAD");
  await f.record();
  expect(f.run).toMatchObject({ files: 1, additions: 1, deletions: 0, base_sha: f.base, diff_base_head: remoteHead });
  expect(f.run.diff).toContain("own.txt"); expect(f.run.diff).not.toContain("main-0.txt");
  expect(f.run.summary.files).toEqual({ "own.txt": { add: 1, del: 0 } });
  expect(f.events.at(-1)).toMatchObject({ type: "run.diff", files: 1, additions: 1, deletions: 0 });
});

it("keeps using the last known base head's merge-base when the fetch fails", async () => {
  const f = await fixture(); await f.record();
  await f.git(f.cwd, "remote", "set-url", "origin", join(f.cwd, "missing-remote"));
  // Prove the fallback also works without a remote-tracking ref in a resumed clone.
  await f.git(f.cwd, "update-ref", "-d", "refs/remotes/origin/main");
  await f.record();
  expect(f.run).toMatchObject({ files: 1, additions: 1, deletions: 0, base_sha: f.base });
});

it("repairs ancestry for a resumed depth-one branch clone without using the pinned base", async () => {
  const f = await fixture();
  await f.git(f.cwd, "push", "origin", "HEAD:refs/heads/fix/run");
  const resumed = join(f.dir, "resumed");
  await f.git(f.dir, "clone", "--depth", "1", "--single-branch", "--no-tags", "--branch", "fix/run", `file://${f.remote}`, resumed);
  expect(await f.git(resumed, "rev-list", "--count", "HEAD")).toBe("1");
  await f.service.recordDiff("run", { cwd: resumed }, f.head, true);
  expect(f.run).toMatchObject({ files: 1, additions: 1, deletions: 0, base_sha: f.base });
  expect(await f.git(resumed, "diff", "--shortstat", "origin/main...HEAD")).toContain("1 file changed, 1 insertion(+)");
});

it("records an unpublished child of a shallow resumed branch, without replacing its counts with cached PR totals on reads", async () => {
  const f = await fixture();
  await f.git(f.cwd, "push", "origin", "HEAD:refs/heads/fix/run");
  const resumed = join(f.dir, "unpublished");
  await f.git(f.dir, "clone", "--depth", "1", "--single-branch", "--no-tags", "--branch", "fix/run", `file://${f.remote}`, resumed);
  await writeFile(join(resumed, "new.txt"), "unpublished\n".repeat(7)); await f.commit(resumed, "unpublished child");
  const candidate = await f.git(resumed, "rev-parse", "HEAD");
  Object.assign(f.run, { pushed: true, pr_number: 35, pr_state: "open", pr_diff: { head_sha: f.head, files: 1, additions: 1, deletions: 0 } });
  await f.service.recordDiff("run", { cwd: resumed }, candidate, false);
  expect(f.run).toMatchObject({ head_sha: f.head, diff_head: candidate, files: 2, additions: 8, deletions: 0 });
  f.service.assertAccount = () => {};
  f.service.pullRequests.metadata.mockResolvedValueOnce(new Map([["acme/app#35", { state: "open", ...f.run.pr_diff }]]));
  await f.service.refreshPulls("owner", "run");
  expect(f.run).toMatchObject({ head_sha: f.head, diff_head: candidate, files: 2, additions: 8, deletions: 0 });
  expect(f.run.diff).toContain("new.txt");
});

it("counts arbitrary file names, deletions, renames and binary changes from the same numstat", async () => {
  const f = await fixture();
  await f.git(f.cwd, "mv", "rename-me.txt", "renamed\tfile.txt");
  await writeFile(join(f.cwd, "__proto__"), "ordinary file\n");
  await writeFile(join(f.cwd, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await f.git(f.cwd, "rm", "base.txt"); await f.commit(f.cwd, "special paths");
  const candidate = await f.git(f.cwd, "rev-parse", "HEAD");
  await f.service.recordDiff("run", { cwd: f.cwd }, candidate, false);
  expect(f.run).toMatchObject({ files: 5, additions: 2, deletions: 1 });
  expect(Object.keys(f.run.summary.files).sort()).toEqual(["__proto__", "base.txt", "binary.bin", "own.txt", "renamed\tfile.txt"]);
  expect(f.run.summary.files["__proto__"]).toEqual({ add: 1, del: 0 });
  expect(f.run.summary.files["base.txt"]).toEqual({ add: 0, del: 1 });
});

it("preserves the prior diff and succeeds if neither a base head nor ancestry is available offline", async () => {
  const f = await fixture();
  Object.assign(f.run, { diff: "last known diff", files: 3, additions: 17, deletions: 4 });
  await f.git(f.cwd, "remote", "set-url", "origin", join(f.cwd, "missing-remote"));
  await f.git(f.cwd, "update-ref", "-d", "refs/remotes/origin/main");
  await expect(f.record()).resolves.toBe(true);
  expect(f.run).toMatchObject({ pushed: true, head_sha: f.head, diff: "last known diff", files: 3, additions: 17, deletions: 4 });
});

it("keeps publication and concurrent lifecycle/transcript changes when PR metadata throws", async () => {
  const f = await fixture(); f.run.pr_number = 35;
  f.service.pullRequests.metadata.mockImplementationOnce(async () => {
    await Promise.resolve();
    f.run.status = "stopped"; f.run.title = "Concurrent title";
    f.run.pending = [{ text: "next turn", images: [] }]; f.run.summary.text = "Concurrent transcript";
    throw new Error("unavailable metadata");
  });
  await expect(f.record()).resolves.toBe(true);
  expect(f.run).toMatchObject({ status: "stopped", title: "Concurrent title", pushed: true, head_sha: f.head,
    files: 1, additions: 1, deletions: 0, pending: [{ text: "next turn", images: [] }], summary: { text: "Concurrent transcript" } });
});

it.each(["kept_commit", "publication_head"])("preserves legacy unpublished counts identified by %s without a diff_head", marker => {
  const head_sha = "a".repeat(40);
  const run = { head_sha, [marker]: "b".repeat(40), files: 7, additions: 91, deletions: 12 };
  preferPullDiff(run, { head_sha, files: 1, additions: 1, deletions: 0 });
  expect(run).toMatchObject({ files: 7, additions: 91, deletions: 12 });
});

it("prefers cached GitHub PR totals for the published head and preserves them on lookup failure", async () => {
  const f = await fixture(); f.run.pr_number = 35;
  f.service.pullRequests.metadata.mockResolvedValueOnce(new Map([["acme/app#35", { state: "open", head_sha: f.head, files: 32, additions: 2249, deletions: 76 }]]));
  await f.record();
  expect(f.run).toMatchObject({ files: 32, additions: 2249, deletions: 76 });
  await f.record();
  expect(f.run).toMatchObject({ files: 32, additions: 2249, deletions: 76 });
  // Never apply eventually consistent numbers for a different published commit.
  f.run.pr_diff!.head_sha = "a".repeat(40);
  f.service.pullRequests.metadata.mockResolvedValueOnce(new Map([["acme/app#35", { state: "open", head_sha: "b".repeat(40), files: 999, additions: 99999, deletions: 99999 }]]));
  await f.record();
  expect(f.run).toMatchObject({ files: 1, additions: 1, deletions: 0 });
});
