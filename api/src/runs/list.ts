import type { Store } from "../db";
import { decimal, MAX_PAGE_SIZE, pagination } from "../../../shared/pagination";

export type RunTab = "all" | "working" | "ready" | "merged";
export interface RunListOptions { limit?: unknown; offset?: unknown; tab?: unknown; repo?: unknown }
export type RunCounts = Record<RunTab | "active" | "queued", number>;

/** Count in SQL and load only the selected page; never deserialize the history. */
export function listRunPage(db: Store, user: string, options: RunListOptions = {}) {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, decimal(options.limit, 100)));
  const requestedOffset = decimal(options.offset, 0);
  const tab: RunTab = ["working", "ready", "merged"].includes(String(options.tab)) ? options.tab as RunTab : "all";
  const repo = typeof options.repo === "string" && options.repo ? options.repo : null;
  const where = "user_id=? AND deleted_at IS NULL";
  const scoped = where + (repo ? " AND repo=?" : "");
  const args = repo ? [user, repo] : [user];
  const counts = db.prepare(`SELECT count(*) AS 'all',
    coalesce(sum(status IN ('working','queued')),0) AS working,
    coalesce(sum(status='working'),0) AS active,
    coalesce(sum(status='queued'),0) AS queued,
    coalesce(sum(status='ready'),0) AS ready,
    coalesce(sum(status='merged'),0) AS merged FROM runs WHERE ${scoped}`).get(...args) as RunCounts;
  const bounds = pagination(counts[tab], limit, requestedOffset);
  const filter = tab === "all" ? "" : tab === "working" ? " AND status IN ('working','queued')" : " AND status=?";
  const rows = db.prepare(`SELECT id, json_set(data,'$.pr_body',pr_body) AS data FROM runs WHERE ${scoped}${filter} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
    .all(...args, ...(tab === "ready" || tab === "merged" ? [tab] : []), limit, bounds.offset) as { id: string; data: string }[];
  const repositories = (db.prepare(`SELECT DISTINCT repo FROM runs WHERE ${where} ORDER BY repo`).all(user) as { repo: string }[]).map(r => r.repo);
  return { rows, ...bounds, counts, repositories };
}
