import { randomBytes } from "node:crypto";
import type { Store } from "./db";
import type { Runs } from "./runs/service";
import { ApiError } from "./wire";
import { validateEffort } from "./effort";
import { resolveModel } from "./models";
import { validRepo, validBranch } from "./github";
import { nextRunAt, validTimezone, type Schedule } from "./lib/schedule";
export function validateRunner(
  body: any,
): Schedule & {
  name: string;
  repo: string;
  base_branch: string | null;
  model_id: string;
  effort?: string;
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
  resolveSelection?: (user:string,id:string)=>Promise<{capabilities: import("./adapters/types").ModelRow["capabilities"]}>,
) {
  const input = validateRunner(body);
  input.effort = validateEffort(resolveSelection ? await resolveSelection(user,input.model_id) : await resolveModel(db, secret, input.model_id), input.effort);
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
              effort: r.effort,
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
