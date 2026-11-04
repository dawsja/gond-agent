import { fetchDiffBase, git } from "../github";

export interface DiffTotals { files: number; additions: number; deletions: number }
export interface PullDiff extends DiffTotals { head_sha: string }

/** One comparison revision for text, totals and per-file folding. Never use the task's pinned base. */
export async function runDiff(cwd: string, base: string, head: string, env: NodeJS.ProcessEnv, lastBaseHead?: string, publishedHead?: string) {
  const ref = `refs/remotes/origin/${base}`;
  const resolveBase = async () => (await git(cwd, "rev-parse", "--verify", ref)).toString().trim();
  let baseHead = lastBaseHead;
  try { baseHead = await resolveBase(); } catch { /* A resumed single-branch clone may lack this ref. */ }
  const mergeBase = async () => baseHead ? (await git(cwd, "merge-base", head, baseHead)).toString().trim() : undefined;
  let comparison: string | undefined;
  // Bound both remote refresh and shallow ancestry repair. Missing ancestry is
  // unknown, not permission to substitute the original base or a two-dot diff.
  const deadline = Date.now() + 15_000;
  for (const depth of [64, 256, 1024]) {
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await fetchDiffBase(cwd, base, publishedHead ?? head, depth, env, remaining, depth !== 64 && !!publishedHead);
      baseHead = await resolveBase();
    } catch { break; /* Offline: use the last known base head below. */ }
    try { comparison = await mergeBase(); } catch { /* Deepen again, within the same budget. */ }
    if (comparison) break;
  }
  if (!comparison) try { comparison = await mergeBase(); } catch { /* Preserve last known diff on unavailable ancestry. */ }
  if (!comparison) return { baseHead };
  const diff = (await git(cwd, "diff", "--no-ext-diff", "--no-textconv", comparison, head, "--")).toString().slice(0, 2_000_000);
  const numstat = (await git(cwd, "diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", comparison, head, "--")).toString();
  const perFile: Record<string, { add: number; del: number }> = Object.create(null);
  const entries = numstat.split("\0");
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i]) continue;
    const [add, del, ...parts] = entries[i].split("\t");
    let path = parts.join("\t");
    // With -z a rename is counts + empty path, then old and new paths.
    if (!path) { path = entries[i + 2]; i += 2; }
    perFile[path] = { add: Number(add) || 0, del: Number(del) || 0 };
  }
  const counts = Object.values(perFile);
  return { baseHead, result: { diff, perFile, files: counts.length,
    additions: counts.reduce((sum, f) => sum + f.add, 0), deletions: counts.reduce((sum, f) => sum + f.del, 0) } };
}

/** Only numbers for this published head can override local counts (GitHub may lag a push). */
export function preferPullDiff<T extends DiffTotals & { head_sha: string | null; diff_head?: string; publication_head?: string; kept_commit?: string; pr_diff?: PullDiff }>(run: T, reported?: PullDiff) {
  if (reported && reported.head_sha === run.head_sha) run.pr_diff = reported;
  // A failed push may leave the saved comparison at an unpublished candidate.
  const comparisonHead = run.diff_head ?? run.kept_commit ?? run.publication_head;
  if (comparisonHead && comparisonHead !== run.head_sha) return;
  if (run.pr_diff?.head_sha === run.head_sha) {
    const { files, additions, deletions } = run.pr_diff;
    Object.assign(run, { files, additions, deletions });
  }
}
