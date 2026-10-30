import { randomBytes } from "node:crypto";
import type { Store } from "./db";
import type { Runs } from "./runs/service";
import { ApiError } from "./wire";
import { resolveModel } from "./models";
import { validRepo, validBranch, gh } from "./github";
import { githubEnv } from "./github-login";
import { nextRunAt, validTimezone, type Schedule } from "./lib/schedule";
export function validateRunner(
  body: any,
): Schedule & {
  name: string;
  repo: string;
  base_branch: string | null;
  model_id: string;
  prompt: string;
  enabled: boolean;
} {
  if (
    !body ||
    typeof body.name !== "string" ||
    !body.name.trim() ||
    body.name.length > 100 ||
    !validRepo(body.repo ?? "") ||
    typeof body.prompt !== "string" ||
    !body.prompt.trim() ||
    body.prompt.length > 20000 ||
    !["daily", "weekly"].includes(body.frequency) ||
    !Number.isInteger(body.minute) ||
    body.minute < 0 ||
    body.minute >= 1440 ||
    !validTimezone(body.timezone) ||
    !Array.isArray(body.weekdays) ||
    body.weekdays.some(
      (d: unknown) => !Number.isInteger(d) || Number(d) < 0 || Number(d) > 6,
    ) ||
    (body.frequency === "weekly" && !body.weekdays.length) ||
    (body.base_branch && !validBranch(body.base_branch))
  )
    throw new ApiError(
      400,
      "invalid_runner",
      "Check the name, repository, task and schedule.",
    );
  return {
    ...body,
    name: body.name.trim(),
    prompt: body.prompt.trim(),
    base_branch: body.base_branch || null,
    enabled: body.enabled !== false,
    weekdays: [...new Set(body.weekdays)],
  };
}
export function listRunners(db: Store, user: string) {
  return (
    db
      .prepare("SELECT data FROM runners WHERE user_id=? ORDER BY id")
      .all(user) as { data: string }[]
  ).map((r) => JSON.parse(r.data));
}
export async function saveRunner(
  db: Store,
  secret: string,
  user: string,
  body: unknown,
  id?: string,
) {
  const input = validateRunner(body);
  await resolveModel(db, secret, input.model_id);
  const old = id
    ? (db
        .prepare("SELECT data FROM runners WHERE id=? AND user_id=?")
        .get(id, user) as { data: string } | undefined)
    : undefined;
  if (id && !old)
    throw new ApiError(404, "not_found", "That schedule doesn't exist.");
  const previous = old ? JSON.parse(old.data) : null;
  const now = Date.now(),
    rid = id ?? `runner_${randomBytes(12).toString("hex")}`;
  const row = {
    ...input,
    id: rid,
    next_run_at: input.enabled ? nextRunAt(input, now) : null,
    last: previous?.last ?? null,
    created_at: previous?.created_at ?? now,
    updated_at: now,
  };
  db.prepare(
    "INSERT INTO runners(id,user_id,enabled,next_run_at,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,next_run_at=excluded.next_run_at,data=excluded.data",
  ).run(
    rid,
    user,
    Number(input.enabled),
    row.next_run_at ?? 0,
    JSON.stringify(row),
  );
  return row;
}
export class Scheduler {
  private busy = false;
  constructor(
    private db: Store,
    private runs: Runs,
    private secret: string,
  ) {}
  private claim(key: string) {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO occurrences(key,created_at) VALUES(?,?)",
        )
        .run(key, Date.now()).changes === 1
    );
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      for (const raw of this.db
        .prepare("SELECT * FROM runners WHERE enabled=1 AND next_run_at<=?")
        .all(now) as {
        id: string;
        user_id: string;
        next_run_at: number;
        data: string;
      }[]) {
        const r = JSON.parse(raw.data),
          key = `schedule:${raw.id}:${raw.next_run_at}`;
        r.next_run_at = nextRunAt(r, now);
        r.last = {
          at: raw.next_run_at,
          status: "claimed",
          reason: null,
          run_id: null,
        };
        this.db
          .prepare("UPDATE runners SET next_run_at=?,data=? WHERE id=?")
          .run(r.next_run_at, JSON.stringify(r), raw.id);
        if (!this.claim(key)) continue;
        try {
          const active = this.runs
            .list(raw.user_id)
            .some(
              (x) =>
                ["queued", "working"].includes(x.status) && x.repo === r.repo,
            );
          if (active) {
            r.last.status = "skipped";
            r.last.reason = "A run is already working on this repository.";
          } else {
            const run = await this.runs.create(raw.user_id, {
              repo: r.repo,
              base_branch: r.base_branch ?? undefined,
              model: r.model_id,
              prompt: r.prompt,
              source: "runner",
            });
            r.last.status = "started";
            r.last.run_id = run.id;
          }
        } catch (e) {
          r.last.status = "failed";
          r.last.reason = "Couldn't start this run. Check the host logs.";
          console.error("scheduled run", e);
        }
        this.db
          .prepare("UPDATE runners SET data=? WHERE id=?")
          .run(JSON.stringify(r), raw.id);
      }
      // gh polling replaces externally hosted webhooks. Only explicitly configured repos are watched.
      const repos = (process.env.GOND_AGENT_REPOSITORIES ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(validRepo);
      const admin = this.db
        .prepare("SELECT user_id FROM administrators LIMIT 1")
        .get() as { user_id: string } | undefined;
      if (admin) {
        const p = this.runs.profile(admin.user_id);
        if (p.issue_runs)
          for (const repo of repos) {
            const issues = await gh<any[]>(
              `repos/${repo}/issues?labels=gond-agent&state=open&per_page=100`,
              "GET", undefined, githubEnv(this.db, this.secret),
            );
            for (const issue of issues.filter((x) => !x.pull_request)) {
              const key = `issue:${repo}:${issue.number}`;
              if (
                this.db
                  .prepare("SELECT 1 FROM occurrences WHERE key=?")
                  .get(key)
              )
                continue;
              const run = await this.runs.create(admin.user_id, {
                repo,
                model: "auto",
                prompt: `Resolve GitHub issue #${issue.number}: ${issue.title}\n\n${issue.body ?? ""}\n\nInclude Fixes #${issue.number} in the pull request.`,
                source: "issue",
                issue: { number: issue.number, url: issue.html_url },
              });
              this.claim(key);
              await gh(
                `repos/${repo}/issues/${issue.number}/comments`,
                "POST",
                { body: `Gond Agent started work: /agents/runs/${run.id}` },
                githubEnv(this.db, this.secret),
              );
            }
          }
        for (const r of this.runs
          .list(admin.user_id)
          .filter((r) => r.pr_number && r.pr_state === "open")) {
          const pr = await gh<any>(`repos/${r.repo}/pulls/${r.pr_number}`, "GET", undefined, githubEnv(this.db, this.secret));
          if (pr.merged) {
            r.pr_state = "merged";
            this.runs.status(r, "merged");
            await this.runs.close(r.id);
            continue;
          }
          if (pr.state === "closed") {
            r.pr_state = "closed";
            this.runs.save(r);
            continue;
          }
          const checks = await gh<any>(
            `repos/${r.repo}/commits/${pr.head.sha}/check-runs`,
            "GET", undefined, githubEnv(this.db, this.secret),
          );
          const pending = checks.check_runs.some(
            (c: any) => c.status !== "completed",
          );
          const failed = checks.check_runs.filter((c: any) =>
            ["failure", "timed_out", "action_required", "cancelled"].includes(
              c.conclusion,
            ),
          );
          r.checks = pending
            ? "pending"
            : failed.length
              ? "failure"
              : "success";
          this.runs.save(r);
          if (
            p.fix_checks &&
            !pending &&
            failed.length &&
            r.last_check_sha !== pr.head.sha &&
            r.check_fixes < 2 &&
            r.status !== "working"
          ) {
            this.runs.enqueue(
              r.id,
              r.user_id,
              `Fix these failing checks on ${pr.head.sha}:\n` +
                failed
                  .map(
                    (c: any) =>
                      `${c.name}: ${c.output?.title ?? ""}\n${c.output?.summary ?? ""}\n${c.details_url ?? ""}`,
                  )
                  .join("\n"),
              [],
              { kind: "checks", sha: pr.head.sha },
            );
            const latest = this.runs.get(r.id);
            latest.last_check_sha = pr.head.sha;
            latest.check_fixes++;
            this.runs.save(latest);
          }
        }
      }
      this.db
        .prepare(
          "DELETE FROM runs WHERE deleted_at IS NOT NULL AND deleted_at<?",
        )
        .run(now - 30 * 86400000);
      this.db
        .prepare("DELETE FROM images WHERE run_id IS NULL AND created_at<?")
        .run(now - 86400000);
    } catch (e) {
      console.error("scheduler tick failed", e);
    } finally {
      this.busy = false;
    }
  }
}
