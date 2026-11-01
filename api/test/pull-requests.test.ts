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
    const [a, b] = await Promise.all([reads.states(refs), reads.states(refs)]);
    expect(a).toEqual(b);
    expect([...a]).toEqual([["acme/app#1", "merged"], ["acme/app#2", "closed"], ["acme/private#3", undefined]]);
    expect(gh).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gh).mock.calls[0]).toMatchObject(["graphql", "POST", { query: expect.stringContaining("pullRequest(number:1){state}") }, { GH_TOKEN: "test-token" }, { timeout: 5000 }]);
    clock.mockReturnValue(130_001);
    vi.mocked(gh).mockResolvedValueOnce({ data: { p0: { pullRequest: { state: "OPEN" } } } });
    expect((await reads.states([refs[1]])).get("acme/app#2")).toBe("open");
    clock.mockReturnValue(160_002);
    vi.mocked(gh).mockRejectedValueOnce(new Error("Unavailable"));
    expect((await reads.states([refs[1]])).get("acme/app#2")).toBeUndefined();
    expect(await reads.states([{ repo: "injected\"repo", pr_number: 2, pr_state: "open" }, { ...refs[0], pr_state: "merged" }])).toEqual(new Map());
    expect(gh).toHaveBeenCalledTimes(3);
  } finally { clock.mockRestore(); }
});
