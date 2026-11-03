import { gh, validRepo } from "./github";

export type PullState = "open" | "closed" | "merged";
interface Pull { repo: string; pr_number: number | null; pr_state: string | null }
const key = (pull: Pull) => `${pull.repo}#${pull.pr_number}`;

/** Read metadata only for linked PRs being viewed; no scheduler or automation work. */
export class PullRequests {
  private cache = new Map<string, { until: number; state: Promise<PullState | undefined> }>();
  constructor(private credentials: (user: string) => NodeJS.ProcessEnv) {}
  async states(pulls: Pull[], user: string) {
    const cacheKey = (p: Pull) => `${user}:${key(p)}`;
    const now = Date.now();
    const eligible = pulls.filter(p => p.pr_state !== "merged" && validRepo(p.repo) && Number.isInteger(p.pr_number) && p.pr_number! > 0 && p.pr_number! <= 2147483647);
    const due = [...new Map(eligible.filter(p => !this.cache.has(cacheKey(p)) || this.cache.get(cacheKey(p))!.until <= now).map(p => [key(p), p])).values()];
    for (let start = 0; start < due.length; start += 25) {
      const batch = due.slice(start, start + 25);
      const work = this.fetch(batch, user);
      for (let i = 0; i < batch.length; i++) this.cache.set(cacheKey(batch[i]), { until: now + 30_000, state: work.then(states => states[i]) });
    }
    const results = await Promise.all(eligible.map(async p => [key(p), await this.cache.get(cacheKey(p))?.state] as const));
    while (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return new Map(results);
  }
  private async fetch(batch: Pull[], user: string): Promise<(PullState | undefined)[]> {
    const query = `{${batch.map((p, i) => {
      const [owner, name] = p.repo.split("/");
      return `p${i}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequest(number:${p.pr_number}){state}}`;
    }).join(" ")}}`;
    try {
      const result = await gh<{ data?: Record<string, { pullRequest?: { state?: string } | null } | null> }>(
        "graphql", "POST", { query }, this.credentials(user), { timeout: 5000, maxBuffer: 128 * 1024 },
      );
      return batch.map((_, i) => {
        const state = result.data?.[`p${i}`]?.pullRequest?.state?.toLowerCase();
        return state === "open" || state === "closed" || state === "merged" ? state : undefined;
      });
    } catch {
      // Keep the last known state if GitHub is unavailable or access was revoked.
      console.error("Couldn't refresh linked pull request states");
      return batch.map(() => undefined);
    }
  }
}
