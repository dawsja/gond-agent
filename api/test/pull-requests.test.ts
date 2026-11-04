import { expect, it, vi } from "vitest";
import { PullRequests } from "../src/pull-requests";
import { gh } from "../src/github";
vi.mock("../src/github", async original => ({ ...await original<typeof import("../src/github")>(), gh: vi.fn() }));

it("batches and caches linked PR reads, distinguishes closed PRs and tolerates unavailable results", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
  const refs = [
    { repo: "acme/app", pr_number: 1, pr_state: "open" },
    { repo: "acme/app", pr_number: 2, pr_state: "open" },
    { repo: "acme/private", pr_number: 3, pr_state: "open" },
  ];
  const reads = new PullRequests(() => ({ GH_TOKEN: "test-token" }));
  try {
    vi.mocked(gh).mockResolvedValueOnce({ data: { p0: { pullRequest: { state: "MERGED" } }, p1: { pullRequest: { state: "CLOSED" } }, p2: null } });
    const [a, b] = await Promise.all([reads.states(refs, "owner"), reads.states(refs, "owner")]);
    expect(a).toEqual(b);
    expect([...a]).toEqual([["acme/app#1", "merged"], ["acme/app#2", "closed"], ["acme/private#3", undefined]]);
    expect(gh).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gh).mock.calls[0]).toMatchObject(["graphql", "POST", { query: expect.stringContaining("pullRequest(number:1){state additions deletions changedFiles headRefOid}") }, { GH_TOKEN: "test-token" }, { timeout: 5000 }]);
    clock.mockReturnValue(130_001);
    vi.mocked(gh).mockResolvedValueOnce({ data: { p0: { pullRequest: { state: "OPEN" } } } });
    expect((await reads.states([refs[1]], "owner")).get("acme/app#2")).toBe("open");
    clock.mockReturnValue(160_002);
    vi.mocked(gh).mockRejectedValueOnce(new Error("Unavailable"));
    expect((await reads.states([refs[1]], "owner")).get("acme/app#2")).toBeUndefined();
    expect(await reads.states([{ repo: "injected\"repo", pr_number: 2, pr_state: "open" }, { ...refs[0], pr_state: "merged", head_sha: "a".repeat(40), pr_diff: { head_sha: "a".repeat(40), files: 1, additions: 1, deletions: 0 } }], "owner")).toEqual(new Map());
    expect(gh).toHaveBeenCalledTimes(3);
  } finally { clock.mockRestore(); }
});

it("caches PR totals by owner, forces a publication refresh and rejects incomplete counts", async () => {
  vi.mocked(gh).mockClear();
  const credentials = vi.fn(user => ({ GH_TOKEN: `${user}-fixture` }));
  const reads = new PullRequests(credentials);
  const refs = [{ repo: "acme/app", pr_number: 35, pr_state: "open" }];
  const headRefOid = "a".repeat(40);
  vi.mocked(gh).mockResolvedValueOnce({ data: { p0: { pullRequest: { state: "OPEN", additions: 2249, deletions: 76, changedFiles: 32, headRefOid } } } });
  const expected = { state: "open", additions: 2249, deletions: 76, files: 32, head_sha: headRefOid };
  expect((await reads.metadata(refs, "owner")).get("acme/app#35")).toEqual(expected);
  expect((await reads.metadata(refs, "owner")).get("acme/app#35")).toEqual(expected);
  expect(gh).toHaveBeenCalledTimes(1);
  vi.mocked(gh).mockResolvedValueOnce({ data: { p0: { pullRequest: { state: "OPEN", additions: 0, deletions: 0, changedFiles: 0, headRefOid } } } });
  expect((await reads.metadata(refs, "owner", true)).get("acme/app#35")).toMatchObject({ files: 0, additions: 0, deletions: 0 });
  expect(gh).toHaveBeenCalledTimes(2);
  vi.mocked(gh).mockResolvedValueOnce({ data: { p0: { pullRequest: { state: "OPEN", additions: -1, deletions: 0, changedFiles: 0, headRefOid } } } });
  expect((await reads.metadata(refs, "other")).get("acme/app#35")).toEqual({ state: "open" });
  expect(credentials.mock.calls.map(([user]) => user)).toEqual(["owner", "owner", "other"]);
  expect(vi.mocked(gh).mock.calls.at(-1)?.[3]).toEqual({ GH_TOKEN: "other-fixture" });
});

it("retries merged PR totals until the cached numbers match the published head", async () => {
  vi.mocked(gh).mockClear();
  const reads = new PullRequests(() => ({}));
  const head_sha = "b".repeat(40);
  const old = { head_sha: "a".repeat(40), files: 1, additions: 1, deletions: 0 };
  const run = { repo: "acme/app", pr_number: 35, pr_state: "merged", head_sha, pr_diff: old };
  vi.mocked(gh).mockResolvedValueOnce({ data: { p0: { pullRequest: { state: "MERGED", additions: 2, deletions: 0, changedFiles: 2, headRefOid: head_sha } } } });
  expect((await reads.metadata([run], "owner")).get("acme/app#35")).toMatchObject({ head_sha, files: 2, additions: 2 });
  expect(gh).toHaveBeenCalledTimes(1);
  run.pr_diff = { head_sha, files: 2, additions: 2, deletions: 0 };
  expect(await reads.metadata([run], "owner")).toEqual(new Map());
  expect(gh).toHaveBeenCalledTimes(1);
});
