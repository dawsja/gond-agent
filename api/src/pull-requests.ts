import { gh, validRepo } from "./github";
import type { PullDiff } from "./runs/diff";

export type PullState = "open" | "closed" | "merged";
interface Pull { repo: string; pr_number: number | null; pr_state: string | null; head_sha?: string | null; pr_diff?: PullDiff }
export type PullMetadata = { state: PullState } & (PullDiff | { files?: undefined; additions?: undefined; deletions?: undefined; head_sha?: undefined });
const key = (pull: Pull) => `${pull.repo}#${pull.pr_number}`;

/** Read metadata only for linked PRs being viewed; no scheduler or automation work. */
export class PullRequests {
  private cache = new Map<string, { until: number; value: Promise<PullMetadata | undefined> }>();
  constructor(private credentials: (user: string) => NodeJS.ProcessEnv) {}
  async states(pulls: Pull[], user: string) {
    return new Map([...await this.metadata(pulls, user)].map(([key, value]) => [key, value?.state]));
  }
  async metadata(pulls: Pull[], user: string, force = false) {
    const cacheKey = (p: Pull) => `${user}:${key(p)}`;
    const now = Date.now();
    const eligible = pulls.filter(p => (force || p.pr_state !== "merged" || !p.pr_diff || p.pr_diff.head_sha !== p.head_sha) && validRepo(p.repo) && Number.isInteger(p.pr_number) && p.pr_number! > 0 && p.pr_number! <= 2147483647);
    const due = [...new Map(eligible.filter(p => force || !this.cache.has(cacheKey(p)) || this.cache.get(cacheKey(p))!.until <= now).map(p => [key(p), p])).values()];
    for (let start = 0; start < due.length; start += 25) {
      const batch = due.slice(start, start + 25);
      const work = this.fetch(batch, user);
      for (let i = 0; i < batch.length; i++) this.cache.set(cacheKey(batch[i]), { until: now + 30_000, value: work.then(values => values[i]) });
    }
    const results = await Promise.all(eligible.map(async p => [key(p), await this.cache.get(cacheKey(p))?.value] as const));
    while (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return new Map(results);
  }
  private async fetch(batch: Pull[], user: string): Promise<(PullMetadata | undefined)[]> {
    const query = `{${batch.map((p, i) => {
      const [owner, name] = p.repo.split("/");
      return `p${i}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequest(number:${p.pr_number}){state additions deletions changedFiles headRefOid}}`;
    }).join(" ")}}`;
    try {
      const result = await gh<{ data?: Record<string, { pullRequest?: { state?: string; additions?: number; deletions?: number; changedFiles?: number; headRefOid?: string } | null } | null> }>(
        "graphql", "POST", { query }, this.credentials(user), { timeout: 5000, maxBuffer: 128 * 1024, retry: { maxAttempts: 2, totalTimeoutMs: 5000 } },
      );
      return batch.map((_, i) => {
        const pull = result.data?.[`p${i}`]?.pullRequest;
        const state = pull?.state?.toLowerCase();
        if (state !== "open" && state !== "closed" && state !== "merged") return undefined;
        const counts = [pull?.additions, pull?.deletions, pull?.changedFiles];
        const valid = counts.every(n => Number.isSafeInteger(n) && n! >= 0) && /^[a-f0-9]{40}$/.test(pull?.headRefOid ?? "");
        return valid ? { state, additions: pull!.additions!, deletions: pull!.deletions!, files: pull!.changedFiles!, head_sha: pull!.headRefOid! } : { state };
      });
    } catch {
      // Keep the last known state if GitHub is unavailable or access was revoked.
      console.error("Couldn't refresh linked pull request states");
      return batch.map(() => undefined);
    }
  }
}
