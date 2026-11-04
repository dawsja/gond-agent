import { searchConfigured, searchResponse } from "../search";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { failedKeepMs, planSetting, webSearchLimit, questionWaitMinutes, type Config } from "../config";
import type { Store } from "../db";
import type { Workspace, WorkspaceFactory } from "../containers";
import {
  checkout,
  gh,
  git,
  importBundle,
  pushBranch,
  commitIdentity,
  validRepo,
  validBranch,
  type GitHubOptions,
} from "../github";
import { githubEnvFor } from "../github-login";
import { modelResponse } from "../responses";
import {
  emptySummary,
  planState,
  fold,
  slug,
  titleFrom,
  totals,
  type Summary,
} from "./fold";
import { validateEffort } from "../effort";
import { ApiError } from "../wire";
import { assertActive, assertBackend, BACKEND, type Backend } from "../backend";
import { ModelAccess } from "../access";
import { SubscriptionAccounts } from "../subscriptions/accounts";
import { ChatGPTProvider } from "../subscriptions/chatgpt";
import { PullRequests } from "../pull-requests";
import { RetryError, classifyRetryFailure, withRetry } from "../retry";

export interface Run {
  id: string;
  user_id: string;
  repo: string;
  base_branch: string;
  branch: string;
  model_id: string;
  effort?: string;
  backend: Backend;
  /** The removed coding agent that created this run. Its history stays readable; it takes no new work. */
  retired_backend?: string;
  title: string;
  prompt: string;
  status: string;
  step: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  head_sha: string | null;
  error: string | null;
  work_kept?: boolean;
  /** Imported commit awaiting publication after capacity reclaimed its workspace. */
  kept_commit?: string;
  last_error?: { step: string; class: string; attempts: number };
  files: number;
  additions: number;
  deletions: number;
  plan_done: number;
  plan_total: number;
  source: string;
  web_search_calls?: number;
  mcp_token_id?: string;
  phase: string;
  pushed: boolean;
  diff: string;
  summary: Summary;
  pending: { text: string; images: string[]; effort?:string; model?:string }[];
  base_sha: string | null;
  auto_pr: boolean;
}
/** Loads a stored run. Every loaded run names the built-in backend; retired agents are kept apart. */
export function parseRun(data: string): Run {
  const { backend, runtime_volume: _volume, runtime_version: _version, ...run } = JSON.parse(data) as Run & { runtime_volume?: unknown; runtime_version?: unknown };
  if (backend === undefined || backend === BACKEND) return { ...run, backend: BACKEND };
  return { ...run, backend: BACKEND, retired_backend: run.retired_backend ?? String(backend) };
}
interface Live {
  workspace: Workspace;
  cwd: string;
  cursor: number;
  closed: boolean;
  busy: boolean;
  closing?: boolean;
  keepTimer?: ReturnType<typeof setTimeout>;
  keptSince?: number;
  publishPending?: { snapshot?: { bundle: string; head: string }; imported?: boolean };
}
export class Runs {
  events = new EventEmitter();
  readonly access: ModelAccess;
  private live = new Map<string, Live>();
  private booting = new Set<string>();
  private launches = new Map<string, Promise<void>>();
  private releasing = new Set<Promise<void>>();
  private shuttingDown = false;
  private deletingAccounts = new Set<string>();
  private pullRequests: PullRequests;
  constructor(
    private db: Store,
    private cfg: Config,
    private workspaceFactory: WorkspaceFactory,
    subscriptions = new SubscriptionAccounts(db, cfg.secret, [new ChatGPTProvider()]),
  ) { this.access = new ModelAccess(db, cfg.secret, subscriptions); this.pullRequests = new PullRequests(user => githubEnvFor(db, cfg.secret, user)); }
  get subscriptions() { return this.access.subscriptions; }
  catalog(user: string, refresh = false) { return this.access.catalog(user, refresh); }
  resolveSelection(user: string, id: string) { return this.access.resolve(user, id); }
  assertAccount(user: string) {
    if (this.deletingAccounts.has(user)) throw new ApiError(409, "account_deleting", "Your account is being deleted.");
    if (!this.db.prepare('SELECT 1 FROM "user" WHERE id=?').get(user)) throw new ApiError(401, "unauthorized", "You're signed out. Sign in again.");
  }
  async withAccountDeletion<T>(user: string, action: (prepare: () => Promise<void>) => Promise<T>) {
    this.assertAccount(user);
    this.deletingAccounts.add(user);
    try {
      return await action(async () => {
        const rows = this.db.prepare("SELECT id,status FROM runs WHERE user_id=?").all(user) as { id: string; status: string }[];
        if (rows.some(r => ["queued", "working"].includes(r.status) || this.booting.has(r.id) || this.launches.has(r.id) || this.live.get(r.id)?.busy))
          throw new ApiError(409, "active_runs", "Stop your active runs and wait for them to finish before deleting your account.");
        await this.subscriptions.revokeAll(user);
        for (const row of rows) {
          const live = this.live.get(row.id);
          try { await this.close(row.id); }
          catch (error) { if (live) this.live.set(row.id, live); throw error; }
          await rm(join(this.cfg.data, "checkouts", row.id), { recursive: true, force: true });
        }
      });
    } finally { this.deletingAccounts.delete(user); }
  }
  get(id: string, user?: string): Run {
    const r = this.db
      .prepare(
        "SELECT data FROM runs WHERE id=? AND deleted_at IS NULL" +
          (user ? " AND user_id=?" : ""),
      )
      .get(...(user ? [id, user] : [id])) as { data: string } | undefined;
    if (!r) throw new ApiError(404, "not_found", "That run doesn't exist.");
    return this.restorePlan(parseRun(r.data));
  }
  list(user: string): Run[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM runs WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100",
        )
        .all(user) as { data: string }[]
    ).map((r) => this.restorePlan(parseRun(r.data)));
  }
  private restorePlan(r: Run): Run {
    // Retention describes this process's live workspace, never a restart guarantee.
    if (r.work_kept && !this.live.has(r.id)) {
      r.work_kept = false;
      r.error = r.error?.replace("Your changes are kept; send a follow-up to try again.", "The kept workspace was released; send a follow-up to retry from the last pushed branch.") ?? null;
      this.db.prepare("UPDATE runs SET data=? WHERE id=?").run(JSON.stringify(r), r.id);
    }
    if (r.retired_backend || Array.isArray(r.summary?.plan_steps)) return r;
    const latest = this.db.prepare("SELECT data FROM events WHERE run_id=? AND json_extract(data,'$.type')='todos' AND json_extract(data,'$.agent_id')='main' ORDER BY seq DESC LIMIT 1").get(r.id) as { data: string } | undefined;
    r.summary = { ...emptySummary(), ...r.summary, ...planState([]) };
    if (latest) r.summary = fold(r.summary, JSON.parse(latest.data));
    if (r.summary) {
      r.plan_done = r.summary.plan_done;
      r.plan_total = r.summary.plan_total;
    }
    this.db.prepare("UPDATE runs SET data=? WHERE id=?").run(JSON.stringify(r), r.id);
    return r;
  }
  save(r: Run) {
    assertBackend(r.backend);
    const stored = this.db.prepare("SELECT json_extract(data, '$.web_search_calls') AS calls FROM runs WHERE id=?").get(r.id) as {calls: number | null} | undefined;
    // Other lifecycle work may still hold a snapshot from before a search request.
    if (stored?.calls != null) r.web_search_calls = Math.max(r.web_search_calls ?? 0, stored.calls);
    r.updated_at = Date.now();
    this.db
      .prepare("UPDATE runs SET status=?,updated_at=?,data=? WHERE id=?")
      .run(r.status, r.updated_at, JSON.stringify(r), r.id);
  }
  async refreshPulls(user: string, id?: string) {
    this.assertAccount(user);
    const rows = id ? [this.get(id, user)] : this.list(user);
    const states = await this.pullRequests.states(rows, user);
    this.assertAccount(user);
    for (const original of rows) {
      let run: Run;
      try { run = this.get(original.id, user); } catch { continue; }
      if (run.repo !== original.repo || run.pr_number !== original.pr_number) continue;
      const state = run.pr_state === "merged" ? "merged" : states.get(`${run.repo}#${run.pr_number}`);
      if (!state) continue;
      if (run.pr_state !== state) {
        run.pr_state = state;
        this.save(run);
        this.append(run.id, { type: "run.pr", number: run.pr_number, url: run.pr_url, state });
      }
      // External merges must not interrupt active or already queued user work.
      if (state === "merged" && run.status !== "merged" && !["queued", "working"].includes(run.status) && !run.pending.length && !this.live.get(run.id)?.busy && !this.booting.has(run.id)) {
        run.phase = "idle";
        this.status(run, "merged");
        await this.close(run.id).catch(() => console.error("Couldn't close merged workspace", run.id));
      }
    }
  }
  append(id: string, event: Record<string, unknown>) {
    if (event.type === "tool.images") {
      const run = this.get(id);
      const images: { id: string; media_type: string }[] = [];
      for (const image of Array.isArray(event.images) ? event.images.slice(0, 8) : []) {
        if (!image || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.media_type) || typeof image.data !== "string" || image.data.length > 7_000_000) continue;
        const bytes = Buffer.from(image.data, "base64");
        if (!bytes.length || bytes.length > 5 * 1024 * 1024 || bytes.toString("base64") !== image.data) continue;
        const imageId = `img_${randomBytes(16).toString("hex")}`;
        this.db.prepare("INSERT INTO images(id,user_id,run_id,media_type,bytes,created_at) VALUES(?,?,?,?,?,?)")
          .run(imageId, run.user_id, id, image.media_type, bytes, Date.now());
        images.push({ id: imageId, media_type: image.media_type });
      }
      // Never persist inline data in transcript JSON or broadcast it on the live stream.
      event = { type: "tool.images", agent_id: event.agent_id, call_id: event.call_id, images };
    }
    const ev = { ...event, ts: Date.now() };
    const row = this.db
      .prepare("INSERT INTO events(run_id,data) VALUES(?,?)")
      .run(id, JSON.stringify(ev));
    const result = { ...ev, seq: Number(row.lastInsertRowid) };
    this.events.emit(id, result);
    return result;
  }
  history(id: string, after: number) {
    return (
      this.db
        .prepare(
          "SELECT seq,data FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 2000",
        )
        .all(id, after) as { seq: number; data: string }[]
    ).map((r) => ({ ...JSON.parse(r.data), seq: r.seq }));
  }
  status(
    r: Run,
    status: string,
    step: string | null = null,
    error: string | null = null,
  ) {
    r.status = status;
    r.step = step;
    r.error = error;
    this.save(r);
    this.append(r.id, { type: "run.status", status, step, error });
  }
  async recover() {
    for (const row of this.db
      .prepare("SELECT data FROM runs WHERE status IN ('queued','working')")
      .all() as { data: string }[]) {
      const r: Run = JSON.parse(row.data);
      r.phase = "idle";
      r.pending = [];
      this.status(
        r,
        "failed",
        null,
        "The host restarted. Send a follow-up to continue from the last pushed branch.",
      );
    }
  }
  private checkCapacity(reclaim = true) {
    if (new Set([...this.live.keys(), ...this.booting]).size < this.cfg.maxRuns) return;
    const oldest = [...this.live].filter(([id, live]) =>
      live.keptSince !== undefined && !live.busy && !live.closing && !this.booting.has(id) && this.get(id).work_kept,
    ).sort((a, b) => a[1].keptSince! - b[1].keptSince!)[0];
    if (!oldest)
      throw new ApiError(429, "run_limit", "All workspaces are busy. Close finished sessions with close_session or in the workspace to free capacity.");
    if (!reclaim) return;
    // Detach synchronously so enqueue can reserve the slot without yielding. Boot
    // waits for destruction before allocating a replacement container.
    const release = this.close(oldest[0], true);
    this.releasing.add(release);
    void release.catch(() => console.error("Couldn't release failed workspace", oldest[0]))
      .finally(() => this.releasing.delete(release));
  }
  async create(
    user: string,
    input: {
      repo: string;
      base_branch?: string;
      model: string;
      effort?: string;
      prompt: string;
      images?: string[];
      source?: string;
      backend?: unknown;
    },
    attribution?: { id: string; tokenId: string; authorize?: () => void },
  ) {
    this.assertAccount(user);
    const backend = assertBackend(input.backend);
    if (
      !validRepo(input.repo) ||
      !input.prompt?.trim() ||
      input.prompt.length > 20000
    )
      throw new ApiError(
        400,
        "invalid_request",
        "Choose a repository and describe the task.",
      );
    githubEnvFor(this.db, this.cfg.secret, user);
    const selectedModel = await this.resolveSelection(user,input.model);
    this.checkCapacity(false);
    const info = await gh<{ default_branch: string }>(`repos/${input.repo}`, "GET", undefined, githubEnvFor(this.db, this.cfg.secret, user)),
      base = input.base_branch || info.default_branch;
    if (!validBranch(base))
      throw new ApiError(
        400,
        "invalid_branch",
        "That branch name isn't valid.",
      );
    const id = attribution?.id ?? `run_${randomBytes(12).toString("hex")}`,
      title = titleFrom(input.prompt),
      now = Date.now();
    this.assertAccount(user);
    const profile = this.profile(user);
    const r: Run = {
      id,
      user_id: user,
      repo: input.repo,
      base_branch: base,
      branch: `gond-agent/${slug(title)}-${id.slice(-6)}`,
      model_id: selectedModel.id,
      backend,
      effort: validateEffort(selectedModel, input.effort),
      title,
      prompt: input.prompt.trim(),
      status: "queued",
      step: null,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
      pr_number: null,
      pr_url: null,
      pr_state: null,
      head_sha: null,
      error: null,
      ...totals(emptySummary()),
      plan_done: 0,
      plan_total: 0,
      source: input.source ?? "web",
      ...(attribution ? { mcp_token_id: attribution.tokenId } : {}),
      phase: "idle",
      pushed: false,
      diff: "",
      summary: emptySummary(),
      pending: [],
      base_sha: null,
      auto_pr: !!profile.auto_pr,
    };
    this.validateImages(user, input.images ?? []);
    attribution?.authorize?.();
    this.db.transaction(() => {
      // Repository/model lookups yield: simultaneous requests may have filled
      // the remaining slots before this run reserves one through enqueue.
      if (this.shuttingDown) throw new ApiError(503, "restarting", "The server is restarting. Try again in a moment.");
      this.checkCapacity();
      this.db
        .prepare(
          "INSERT INTO runs(id,user_id,repo,status,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?)",
        )
        .run(id, user, r.repo, r.status, now, now, JSON.stringify(r));
      this.enqueue(
        id,
        user,
        r.prompt,
        input.images ?? [],
      );
    })();
    return this.get(id, user);
  }
  profile(user: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO profiles(user_id) VALUES(?)")
      .run(user);
    return this.db
      .prepare("SELECT * FROM profiles WHERE user_id=?")
      .get(user) as {
      auto_pr: number;
    };
  }
  validateImages(user: string, images: string[]) {
    if (!Array.isArray(images) || images.length > 10)
      throw new ApiError(400, "invalid_images", "Attach up to ten images.");
    for (const id of images)
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM images WHERE id=? AND user_id=? AND run_id IS NULL",
          )
          .get(id, user)
      )
        throw new ApiError(
          404,
          "image_not_found",
          "That image isn't available.",
        );
  }
  async validateFollowUp(id: string, user: string, model?: string, effort?: unknown) {
    const run = this.get(id, user);
    assertActive(run);
    if (model !== undefined && typeof model !== "string")
      throw new ApiError(400, "invalid_model", "Choose an available model.");
    if (model !== undefined || effort !== undefined) {
      const selected = await this.resolveSelection(user, model ?? run.model_id);
      validateEffort(selected, effort ?? "default");
    }
    return run;
  }
  enqueue(
    id: string,
    user: string,
    text: string,
    images: string[] = [],
    effort?:string,
    model?:string,
  ) {
    this.assertAccount(user);
    const r = this.get(id, user);
    assertActive(r);
    if (this.shuttingDown) throw new ApiError(503, "restarting", "The server is restarting. Try again in a moment.");
    if (r.status === "merged" || r.pr_state === "merged")
      throw new ApiError(409, "merged", "Start a new run after merging.");
    if (!text.trim() || text.length > 20000)
      throw new ApiError(
        400,
        "invalid_prompt",
        "Write a message of up to 20,000 characters.",
      );
    if (this.live.get(id)?.closing) throw new ApiError(409, "workspace_closing", "Wait for the workspace to close before sending a follow-up.");
    const question = r.summary.question;
    const answering = this.live.get(id);
    if (question && answering?.busy) {
      r.summary.question = null;
      this.save(r);
      this.append(id, { type: "user", text, images: [] });
      void answering.workspace.rpc("send", { input: { type: "question.reply", request_id: question.request_id, answer: text } }).catch(e => this.fail(id, e));
      return;
    }
    if (r.pending.length >= 20)
      throw new ApiError(
        429,
        "queue_full",
        "Wait for queued messages to finish.",
      );
    if (images.length) this.validateImages(user, images);
    if(effort !== undefined){
      if(effort !== "default" && (typeof effort!=="string" || effort.length>20))throw new ApiError(400,"invalid_effort","Choose a supported effort.");
    }
    if (!this.live.has(id) && !this.booting.has(id)) this.checkCapacity();
    if (images.length) {
      for (const image of images)
        this.db
          .prepare("UPDATE images SET run_id=? WHERE id=? AND user_id=?")
          .run(id, image, user);
    }
    if (!this.live.has(id) && r.status === "stopped") r.status = "queued";
    r.pending.push({ text, images, effort, model });
    this.save(r);
    this.append(id, {
      type: "user",
      text,
      images: images.map((id) => ({ id })),
    });
    const live = this.live.get(id);
    if (live) {
      if (!live.busy) void this.next(id, live).catch((e) => this.fail(id, e));
    } else if (!this.booting.has(id)) {
      const launch = this.boot(id).catch((e) => this.fail(id, e)).finally(() => this.launches.delete(id));
      this.launches.set(id, launch);
    }
  }
  private async boot(id: string) {
    this.booting.add(id);
    let workspace: Workspace | undefined;
    try {
      if (this.releasing.size) await Promise.all(this.releasing);
      let r = this.get(id);
      assertActive(r);
      if (this.shuttingDown || r.status === "stopped") {
        r.phase = "idle";
        r.pending = [];
        this.status(r, "stopped");
        return;
      }
      r.phase = "booting";
      r.started_at ??= Date.now();
      if (r.kept_commit) {
        const head = r.kept_commit;
        this.status(r, "working", "Pushing kept changes");
        await pushBranch(join(this.cfg.data, "checkouts", id), r.branch, githubEnvFor(this.db, this.cfg.secret, r.user_id));
        r = this.get(id); // Stop and additional follow-ups may have arrived during publication.
        r.pushed = true;
        r.head_sha = head;
        delete r.kept_commit;
        this.save(r);
        if (this.shuttingDown || r.status === "stopped") {
          r.phase = "idle";
          r.pending = [];
          this.status(r, "stopped");
          return;
        }
      }
      this.status(r, "working", "Cloning repository");
      const checked = await checkout(
        this.cfg.data,
        id,
        r.repo,
        r.base_branch,
        r.branch,
        r.pushed,
        githubEnvFor(this.db, this.cfg.secret, r.user_id),
        step => {
          const current = this.get(id);
          if (!this.shuttingDown && current.status !== "stopped" && current.step !== step) this.status(current, "working", step);
        },
        r.base_sha ?? undefined,
      );
      r = this.get(id);
      if (this.shuttingDown || r.status === "stopped") {
        r = this.get(id); r.phase = "idle"; r.pending = []; this.status(r, "stopped"); return;
      }
      this.status(r, "working", "Starting a workspace container");
      const owner = r.user_id;
      workspace = await this.workspaceFactory(id, (req) =>
        new URL(req.url).pathname === "/v1/models"
          ? this.catalog(owner).then(catalog => Response.json({ ...catalog, web_search: searchConfigured(this.db) }))
          : new URL(req.url).pathname === "/v1/search" ? this.search(id, req)
          : modelResponse(this.db, this.cfg.secret, owner, id, req, this.access),
      );
      r = this.get(id);
      if (this.shuttingDown || r.status === "stopped") {
        r.phase = "idle";
        this.save(r);
        return await workspace.destroy();
      }
      this.status(r, "working", "Loading repository into the workspace");
      await workspace.rpc("setup", { archive: checked.archive.toString("base64") });
      r = this.get(id);
      if (this.shuttingDown || r.status === "stopped") return await workspace.destroy();
      this.status(r, "working", "Starting the agent");
      await workspace.rpc("start", {
        model: r.model_id, effort: r.effort ?? "high",
        interactive: r.source === "web" || r.source === "mcp",
        question_wait_minutes: questionWaitMinutes(),
        ...(r.summary.plan_steps?.length ? { plan: r.summary.plan_steps } : {}),
        ...(process.env.GOND_AGENT_PLAN_REMINDER_EVERY !== undefined ? { plan_reminder_every: planSetting("GOND_AGENT_PLAN_REMINDER_EVERY") } : {}),
        ...(process.env.GOND_AGENT_PLAN_NUDGE_LIMIT !== undefined ? { plan_nudge_limit: planSetting("GOND_AGENT_PLAN_NUDGE_LIMIT") } : {}),
      });
      if (this.shuttingDown) return await workspace.destroy();
      const live: Live = {
        workspace,
        cwd: checked.cwd,
        cursor: 0,
        closed: false,
        busy: false,
      };
      this.live.set(id, live);
      r.base_sha ??= (
        await git(checked.cwd, "rev-parse", `origin/${r.base_branch}`)
      )
        .toString()
        .trim();
      r.phase = "agent";
      this.save(r);
      try { await this.next(id, live); }
      finally { void this.pump(id, live).catch((e) => this.fail(id, e)); }
    } catch (e) {
      if (!this.live.has(id)) await workspace?.destroy();
      throw e;
    } finally {
      this.booting.delete(id);
    }
  }
  private async next(id: string, live: Live) {
    let r = this.get(id);
    if(!r.pending.length || live.closed)return;
    if (live.busy) return;
    live.busy = true;
    clearTimeout(live.keepTimer);
    live.keepTimer = undefined;
    live.keptSince = undefined;
    // Publication belongs to the previous turn. Never send more work until its
    // exact kept commit is pushed, even if a follow-up chooses another model.
    if (r.work_kept || live.publishPending) {
      r.work_kept = false;
      this.status(r, "working", "Saving kept changes");
      await this.publish(id, live);
      r = this.get(id);
      if (r.status === "stopped") { live.busy = false; return; }
    }
    if (live.closed || !r.pending.length) { live.busy = false; return; }
    const message=r.pending[0];
    assertActive(r);
    if(message.model || message.effort !== undefined){
      const selected=await this.resolveSelection(r.user_id,message.model ?? r.model_id);
      r.model_id=selected.id;r.effort=validateEffort(selected,message.effort ?? "default");this.save(r);
    }
    r.pending.shift();
    if (live.closed) return;
    r.summary = { ...emptySummary(), ...planState(r.summary.plan_steps) };
    r.work_kept = false;
    delete r.last_error;
    r.phase = "agent";
    this.status(r, "working", "Thinking");
    if(message.effort !== undefined){
      const selected=await this.resolveSelection(r.user_id,r.model_id);
      r.effort=validateEffort(selected,message.effort);this.save(r);
    }
    live.busy = true;
    const selected=await this.resolveSelection(r.user_id,r.model_id);
    await live.workspace.rpc("send",{input:{type:"model",model:r.model_id,context_window:selected.context_window}});
    await live.workspace.rpc("send", {input:{type:"effort",effort:r.effort ?? "high"}});
    await live.workspace.rpc("send", {
      input: {
        type: "user",
        text: message.text,
        effort: message.effort ?? r.effort ?? "high",
        images: message.images.map((id) => {
          const image = this.db.prepare("SELECT media_type,bytes FROM images WHERE id=? AND user_id=? AND run_id=?")
            .get(id, r.user_id, r.id) as { media_type: string; bytes: Buffer } | undefined;
          if (!image) throw new ApiError(404, "image_not_found", "That image isn't available.");
          return { media_type: image.media_type, data: image.bytes.toString("base64") };
        }),
      },
    });
  }
  private search(id: string, req: Request): Promise<Response> {
    const run = this.get(id);
    const used = run.web_search_calls ?? 0;
    const limit = webSearchLimit();
    if (limit !== 0 && used >= limit) {
      return Promise.resolve(Response.json({ error: "web search limit for this run reached" }, { status: 429 }));
    }
    // Persist before awaiting the provider so concurrent requests and reopened workers share the cap.
    run.web_search_calls = used + 1;
    this.save(run);
    return searchResponse(this.db, this.cfg.secret, req);
  }
  private async pump(id: string, live: Live) {
    while (!live.closed) {
      try { await this.poll(id, live); }
      catch (error) { await this.fail(id, error); }
      if (!live.closed) await delay(300);
    }
  }
  private async poll(id: string, live: Live) {
    while (!live.closed) {
      if (this.get(id).status === "failed") { await delay(300); continue; }
      const batch = await live.workspace.rpc<{
        events: Record<string, any>[];
        alive: boolean;
      }>("events", { after: live.cursor });
      live.cursor += batch.events.length;
      for (const event of batch.events) {
        if (live.closed) return;
        const modelDropped = event.type === "error" && event.message === "The model connection dropped 3 times";
        if (event.type === "error" && event.agent_id === "main")
          event.message = modelDropped ? "The model connection dropped 3 times" : "The model request failed.";
        this.append(id, event);
        const r = this.get(id);
        r.summary = fold(r.summary, event as any);
        Object.assign(r, totals(r.summary), {
          plan_done: r.summary.plan_done,
          plan_total: r.summary.plan_total,
          step: r.status === "failed" ? r.step : r.summary.step,
        });
        this.save(r);
        if (r.status === "failed") continue;
        if (event.type === "error" && event.agent_id === "main") {
          const dropped = modelDropped;
          await this.fail(id, new RetryError("model", {
            class: dropped ? "network" : "unknown", retryable: !!event.retryable,
            reason: dropped ? "The model connection dropped 3 times" : "The model request failed",
          }, dropped ? 3 : 1));
          continue;
        }
        if (event.type === "turn.end" && event.agent_id === "main") {
          if (event.stop_reason === "error") continue;
          if (event.stop_reason === "interrupted") {
            live.busy = false;
            r.phase = "agent";
            this.status(r, "stopped");
          } else if (event.stop_reason !== "compacted") {
            await this.finish(id, live);
          }
          if (this.get(id).pending.length) await this.next(id, live);
        }
      }
      const r = this.get(id);
      if(!live.busy && r.pending.length)await this.next(id,live);
      if (!batch.alive && live.busy) throw new Error("The workspace worker exited");
      await delay(batch.events.length ? 50 : 300);
    }
  }
  private async finish(id: string, live: Live) {
    let r = this.get(id);
    r.phase = "finishing";
    this.status(r, "working", "Pushing changes");
    await this.publish(id, live);
    r = this.get(id);
    if (r.auto_pr && r.files && r.pr_state !== "merged") await this.openPull(id, r.user_id, { backgroundPublication: true });
    r = this.get(id);
    live.busy = false;
    r.phase = "agent";
    r.finished_at = Date.now();
    const merged = r.pr_state === "merged" && !r.pending.length;
    this.status(r, merged ? "merged" : "ready");
    if (merged) await this.close(id);
  }
  private async publish(id: string, live: Live, options: Pick<GitHubOptions, "backgroundPublication"> = { backgroundPublication: true }) {
    const r = this.get(id);
    const pending = live.publishPending ??= {};
    const snapshot = pending.snapshot ??= await withRetry("snapshot", async () => live.workspace.rpc<{ bundle: string; head: string }>(
      "snapshot",
      options.backgroundPublication
        ? { title: r.title, identity: await commitIdentity(githubEnvFor(this.db, this.cfg.secret, r.user_id), options) }
        : { title: r.title, identity: await commitIdentity(githubEnvFor(this.db, this.cfg.secret, r.user_id)) },
    ), { maxAttempts: 1 });
    if (pending.imported) await pushBranch(live.cwd, r.branch, githubEnvFor(this.db, this.cfg.secret, r.user_id));
    else try { await importBundle(
      live.cwd,
      Buffer.from(snapshot.bundle, "base64"),
      r.branch,
      githubEnvFor(this.db, this.cfg.secret, r.user_id),
    ); pending.imported = true; }
    catch (error) {
      if (error instanceof RetryError && error.step === "push") {
        pending.imported = true;
        snapshot.bundle = ""; // The imported commit, not another in-memory bundle, is the retry source.
        await this.recordDiff(id, live, snapshot.head, false).catch(() => console.error("Couldn't read kept changes", id));
      }
      // Import failures can be re-snapshotted from the still-kept worker. Never
      // pin a potentially 128 MiB base64 bundle on the live retention record.
      snapshot.bundle = "";
      if (!pending.imported) pending.snapshot = undefined;
      throw error;
    }
    snapshot.bundle = "";
    await this.recordDiff(id, live, snapshot.head, true);
    live.publishPending = undefined;
  }
  private async recordDiff(id: string, live: Live, head: string, pushed: boolean) {
    let r = this.get(id);
    r.pushed ||= pushed;
    r.head_sha = head;
    r.diff = (
      await git(live.cwd, "diff", "--no-ext-diff", r.base_sha!, "HEAD", "--")
    )
      .toString()
      .slice(0, 2_000_000);
    const counts = (
      await git(live.cwd, "diff", "--numstat", r.base_sha!, "HEAD", "--")
    )
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    r.files = counts.length;
    r.additions = 0;
    r.deletions = 0;
    for (const line of counts) {
      const [a, d] = line.split("\t");
      r.additions += Number(a) || 0;
      r.deletions += Number(d) || 0;
    }
    r = { ...this.get(id), pushed: r.pushed, head_sha: r.head_sha, diff: r.diff, files: r.files, additions: r.additions, deletions: r.deletions };
    this.save(r);
    this.append(id, {
      type: "run.diff",
      files: r.files,
      additions: r.additions,
      deletions: r.deletions,
    });
  }
  async openPull(id: string, user: string, options: Pick<GitHubOptions, "backgroundPublication"> = {}) {
    const r = this.get(id, user);
    if (!r.pushed)
      throw new ApiError(
        409,
        "not_pushed",
        "Wait until the changes have been pushed.",
      );
    const body = r.summary.text || r.prompt;
    if (r.pr_number)
      await gh(`repos/${r.repo}/pulls/${r.pr_number}`, "PATCH", { body }, githubEnvFor(this.db, this.cfg.secret, r.user_id), options);
    else {
      const existing = await gh<{ number: number; html_url: string }[]>(
        `repos/${r.repo}/pulls?head=${encodeURIComponent(r.repo.split("/")[0] + ":" + r.branch)}&state=open`,
        "GET", undefined, githubEnvFor(this.db, this.cfg.secret, r.user_id), options,
      );
      const pr =
        existing[0] ??
        (await gh<{ number: number; html_url: string }>(
          `repos/${r.repo}/pulls`,
          "POST",
          { head: r.branch, base: r.base_branch, title: r.title, body },
          githubEnvFor(this.db, this.cfg.secret, r.user_id),
          options,
        ));
      r.pr_number = pr.number;
      r.pr_url = pr.html_url;
      r.pr_state = "open";
      this.save(r);
      this.append(id, { type: "run.pr", number: pr.number, url: pr.html_url });
    }
    return { ok: true };
  }
  async merge(id: string, user: string) {
    const r = this.get(id, user);
    if (!r.pr_number)
      throw new ApiError(409, "no_pull", "This run has no pull request.");
    await gh(`repos/${r.repo}/pulls/${r.pr_number}/merge`, "PUT", {
      merge_method: "squash",
      sha: r.head_sha,
    }, githubEnvFor(this.db, this.cfg.secret, r.user_id));
    r.pr_state = "merged";
    r.phase = "idle";
    this.append(id, { type: "run.pr", number: r.pr_number, url: r.pr_url, state: "merged" });
    this.status(r, "merged");
    await this.close(id);
  }
  async stop(id: string, user: string) {
    const r = this.get(id, user);
    const kept = r.work_kept;
    r.pending = [];
    this.status(r, "stopped");
    const live = this.live.get(id);
    if (kept) { await this.close(id); return; }
    if (live && live.busy) await live.workspace.rpc("send", { input: { type: "interrupt" } });
  }
  async closeSession(id: string, user: string) {
    const r = this.get(id, user);
    const live = this.live.get(id);
    if (this.booting.has(id) || live?.busy || live?.closing || r.pending.length || ["queued", "working"].includes(r.status))
      throw new ApiError(409, "workspace_busy", "Wait for the current turn to finish or stop it before closing the workspace.");
    if (!live) return { closed: true };
    if (r.work_kept) { await this.close(id); return { closed: true }; }
    live.closing = true;
    try {
      await this.publish(id, live, {});
      await this.close(id);
      return { closed: true };
    } catch (error) {
      await this.fail(id, error);
      throw error;
    } finally { live.closing = false; }
  }
  async remove(id: string, user: string) {
    this.get(id, user);
    await this.close(id);
    this.db
      .prepare("UPDATE runs SET deleted_at=? WHERE id=?")
      .run(Date.now(), id);
    await rm(join(this.cfg.data, "checkouts", id), {
      recursive: true,
      force: true,
    });
  }
  // Failed workspaces have a bounded grace period; successful idle work does not expire.
  async close(id: string, forCapacity = false) {
    const live = this.live.get(id);
    let r: Run | undefined;
    try { r = this.get(id); }
    catch (error) {
      // Account cleanup includes soft-deleted runs, which get() deliberately hides.
      if (!(error instanceof ApiError) || error.code !== "not_found") throw error;
    }
    if (r) {
      if (forCapacity && live?.publishPending?.imported)
        r.kept_commit = live.publishPending.snapshot?.head;
      r.phase = "idle";
      if (r.work_kept && r.error)
        r.error = r.error.replace("Your changes are kept; send a follow-up to try again.", r.kept_commit
          ? "The workspace was released; send a follow-up to publish the saved commit and continue."
          : "The kept workspace was released; send a follow-up to retry from the last pushed branch.");
      r.work_kept = false;
      this.save(r);
    }
    if (live) {
      clearTimeout(live.keepTimer);
      live.closed = true;
      live.publishPending = undefined;
      this.live.delete(id);
      await live.workspace.destroy();
    }
    // Only an imported commit survives capacity eviction, not the worker's
    // uncommitted edits or a bundle that could not be imported.
    if (!r?.kept_commit) await rm(join(this.cfg.data, "checkouts", id), { recursive: true, force: true });
  }
  async shutdown() {
    this.shuttingDown = true;
    this.subscriptions.close();
    await Promise.allSettled([...this.launches.values()]);
    await Promise.allSettled([...this.live.keys()].map((id) => this.close(id)));
    await Promise.allSettled(this.releasing);
  }
  private async fail(id: string, error: unknown) {
    const failure = error instanceof RetryError ? error : error instanceof ApiError && error.cause instanceof RetryError ? error.cause :
      new RetryError(error instanceof ApiError && error.code === "checkout_failed" ? "clone" : "turn", classifyRetryFailure(error), 1);
    console.error("run failed", id, failure.step, failure.class, failure.attempts);
    try {
      const r = this.get(id);
      const live = this.live.get(id);
      const keep = failedKeepMs();
      if (live) { live.busy = false; clearTimeout(live.keepTimer); }
      r.phase = "idle";
      r.pending = [];
      r.work_kept = !!live && keep > 0;
      r.last_error = { step: failure.step, class: failure.class, attempts: failure.attempts };
      const label = ({ push: "Pushing the branch", snapshot: "Saving workspace changes", import: "Importing workspace changes", clone: "Cloning the repository", fetch: "Fetching the repository", github_api: "The GitHub request", model: "The model connection", turn: "The turn" } as Record<string, string>)[failure.step] ?? "The operation";
      const message = `${label} failed after ${failure.attempts} attempt${failure.attempts === 1 ? "" : "s"} (${failure.reason}). ${r.work_kept ? "Your changes are kept; send a follow-up to try again." : r.kept_commit ? "Your saved commit is kept; send a follow-up to publish it and continue." : "Send a follow-up to retry from the last pushed branch."}`;
      this.append(id, { type: "run.error", ...r.last_error });
      this.status(
        r,
        "failed",
        failure.step,
        message,
      );
      if (r.work_kept && live) {
        live.keptSince = Date.now();
        live.keepTimer = setTimeout(() => {
          if (this.live.get(id) === live && this.get(id).work_kept && !live.busy)
            void this.close(id).catch(() => console.error("Couldn't release failed workspace", id));
        }, keep);
        live.keepTimer.unref();
        return;
      }
    } catch {}
    await this.close(id);
  }
}
