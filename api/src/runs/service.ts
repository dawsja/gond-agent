import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { Config } from "../config";
import type { Store } from "../db";
import type { Workspace, WorkspaceFactory } from "../containers";
import {
  checkout,
  gh,
  git,
  importBundle,
  validRepo,
  validBranch,
} from "../github";
import { resolveModel, loadModelCatalog } from "../models";
import { githubEnv } from "../github-login";
import { modelResponse } from "../responses";
import {
  emptySummary,
  fold,
  slug,
  titleFrom,
  totals,
  type Summary,
} from "./fold";
import { recordCLIUsage } from "../cli-usage";
import { CLIRuntimes, type CLI } from "../cli-runtime";
import { CLIAccounts, type CLIState } from "../cli-accounts";
import { seal, unseal } from "../auth";
import { validateEffort } from "../effort";
import { ApiError } from "../wire";

export interface Run {
  id: string;
  user_id: string;
  repo: string;
  base_branch: string;
  branch: string;
  model_id: string;
  effort?: string;
  backend?: CLI;
  runtime_volume?: string;
  runtime_version?: string;
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
  files: number;
  additions: number;
  deletions: number;
  plan_done: number;
  plan_total: number;
  source: string;
  phase: string;
  pushed: boolean;
  diff: string;
  summary: Summary;
  pending: { text: string; images: string[]; effort?:string; model?:string }[];
  base_sha: string | null;
  idle_since: number;
  auto_pr: boolean;
}
interface Live {
  workspace: Workspace;
  cwd: string;
  cursor: number;
  closed: boolean;
  busy: boolean;
  turnAt: number;
}
export class Runs {
  events = new EventEmitter();
  readonly runtimes: CLIRuntimes;
  readonly cliAccounts: CLIAccounts;
  private cliLeases = new Map<string,string>();
  private live = new Map<string, Live>();
  private booting = new Set<string>();
  private launches = new Map<string, Promise<void>>();
  private shuttingDown = false;
  private deletingAccounts = new Set<string>();
  constructor(
    private db: Store,
    private cfg: Config,
    private workspaceFactory: WorkspaceFactory,
  ) { this.runtimes = new CLIRuntimes(db,cfg); this.cliAccounts = new CLIAccounts(db,cfg.secret,workspaceFactory,this.runtimes); }
  async catalog(user: string, refresh = false) {
    const catalog = await loadModelCatalog(this.db,this.cfg.secret,refresh);
    await Promise.all((["claude-code","codex"] as CLI[]).map(backend=>this.cliAccounts.refresh(user,backend,refresh)));
    const own = this.cliAccounts.models(user).map(m => ({id:`cli-${m.backend}:${encodeURIComponent(m.id)}`,provider:m.backend === "codex" ? "openai" : "anthropic",display_name:`${m.name} · ${m.backend === "codex" ? "Codex" : "Claude Code"}`,connection_id:`cli-${m.backend}`,connection_name:m.backend === "codex" ? "Codex subscription" : "Claude subscription",context_window:200000,max_output:8192,capabilities:{images:true,reasoning:"effort" as const},efforts:m.efforts,backend:m.backend}));
    return {...catalog,models:[...catalog.models,...own]};
  }
  async resolveSelection(user:string,id:string) {
    if(!id.startsWith("cli-"))return {...await resolveModel(this.db,this.cfg.secret,id),backend:undefined};
    const model=this.cliAccounts.models(user).find(m=>`cli-${m.backend}:${encodeURIComponent(m.id)}`===id);
    if(!model)throw new ApiError(404,"unknown_model","Sign in and choose an available subscription model in Settings.");
    return {id,upstream_id:model.id,backend:model.backend,capabilities:{reasoning:"effort" as const,images:true,efforts:model.efforts}};
  }
  private async captureCLI(r:Run,workspace:Workspace) {
    if(!r.backend)return;
    const state=await workspace.rpc<CLIState>("cli_state");
    this.db.prepare("UPDATE cli_accounts SET credentials=? WHERE user_id=? AND backend=?").run(seal(this.cfg.secret,JSON.stringify(state.credentials)),r.user_id,r.backend);
    this.db.prepare("INSERT INTO cli_sessions(run_id,state) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET state=excluded.state").run(r.id,seal(this.cfg.secret,JSON.stringify({...state,credentials:{}})));
  }
  private releaseCLI(r:Run){if(r.backend && this.cliLeases.get(`${r.user_id}:${r.backend}`)===r.id)this.cliLeases.delete(`${r.user_id}:${r.backend}`);}
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
        await this.cliAccounts.remove(user);
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
    return JSON.parse(r.data);
  }
  list(user: string): Run[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM runs WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100",
        )
        .all(user) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  save(r: Run) {
    r.updated_at = Date.now();
    this.db
      .prepare("UPDATE runs SET status=?,updated_at=?,data=? WHERE id=?")
      .run(r.status, r.updated_at, JSON.stringify(r), r.id);
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
    await this.runtimes.recover();
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
    },
  ) {
    this.assertAccount(user);
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
    const selectedModel = await this.resolveSelection(user,input.model);
    if (new Set([...this.live.keys(), ...this.booting]).size >= this.cfg.maxRuns)
      throw new ApiError(
        429,
        "run_limit",
        "All workspaces are busy. Wait for a run to finish.",
      );
    const info = await gh<{ default_branch: string }>(`repos/${input.repo}`, "GET", undefined, githubEnv(this.db, this.cfg.secret)),
      base = input.base_branch || info.default_branch;
    if (!validBranch(base))
      throw new ApiError(
        400,
        "invalid_branch",
        "That branch name isn't valid.",
      );
    const id = `run_${randomBytes(12).toString("hex")}`,
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
      ...(selectedModel.backend ? {backend:selectedModel.backend,runtime_volume:this.runtimes.get(selectedModel.backend)!.volume,runtime_version:this.runtimes.get(selectedModel.backend)!.version} : {}),
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
      phase: "idle",
      pushed: false,
      diff: "",
      summary: emptySummary(),
      pending: [],
      base_sha: null,
      idle_since: now,
      auto_pr: !!profile.auto_pr,
    };
    this.validateImages(user, input.images ?? []);
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO runs(id,user_id,repo,status,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?)",
        )
        .run(id, user, r.repo, r.status, now, now, JSON.stringify(r));
    })();
    this.enqueue(
      id,
      user,
      r.prompt,
      input.images ?? [],
    );
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
    if (this.shuttingDown) throw new ApiError(503, "restarting", "The server is restarting. Try again in a moment.");
    if (r.status === "merged")
      throw new ApiError(409, "merged", "Start a new run after merging.");
    if (!text.trim() || text.length > 20000)
      throw new ApiError(
        400,
        "invalid_prompt",
        "Write a message of up to 20,000 characters.",
      );
    if (r.pending.length >= 20)
      throw new ApiError(
        429,
        "queue_full",
        "Wait for queued messages to finish.",
      );
    if (images.length) {
      this.validateImages(user, images);
      for (const image of images)
        this.db
          .prepare("UPDATE images SET run_id=? WHERE id=? AND user_id=?")
          .run(id, image, user);
    }
    if (!this.live.has(id) && r.status === "stopped") r.status = "queued";
    if(effort !== undefined){
      if(effort !== "default" && (typeof effort!=="string" || effort.length>20))throw new ApiError(400,"invalid_effort","Choose a supported effort.");
    }
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
      let r = this.get(id);
      r.phase = "booting";
      r.started_at ??= Date.now();
      this.status(r, "working", "Cloning repository");
      const checked = await checkout(
        this.cfg.data,
        id,
        r.repo,
        r.base_branch,
        r.branch,
        r.pushed,
        githubEnv(this.db, this.cfg.secret),
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
      workspace = await this.workspaceFactory(id, (req) =>
        new URL(req.url).pathname === "/v1/models"
          ? loadModelCatalog(this.db, this.cfg.secret).then(catalog => Response.json(catalog))
          : modelResponse(this.db, this.cfg.secret, r.user_id, id, req),
        r.runtime_volume,
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
      if(r.backend){
        const saved=this.db.prepare("SELECT state FROM cli_sessions WHERE run_id=?").get(id) as {state:string}|undefined;
        const state=saved?JSON.parse(unseal(this.cfg.secret,saved.state)):{};
        await workspace.rpc("cli_prepare",{state:{...state,credentials:this.cliAccounts.credentials(r.user_id,r.backend)},config:{backend:r.backend,model:decodeURIComponent(r.model_id.split(":").slice(1).join(":")),effort:r.effort ?? "default"}});
      }
      if(!r.backend)await workspace.rpc("start", { model: r.model_id, effort: r.effort ?? "high" });
      if (this.shuttingDown) return await workspace.destroy();
      const live: Live = {
        workspace,
        cwd: checked.cwd,
        cursor: 0,
        closed: false,
        busy: false,
        turnAt: 0,
      };
      this.live.set(id, live);
      r.base_sha ??= (
        await git(checked.cwd, "rev-parse", `origin/${r.base_branch}`)
      )
        .toString()
        .trim();
      r.phase = "agent";
      this.save(r);
      await this.next(id, live);
      void this.pump(id, live).catch((e) => this.fail(id, e));
    } catch (e) {
      await workspace?.destroy();
      throw e;
    } finally {
      this.booting.delete(id);
    }
  }
  private async next(id: string, live: Live) {
    const r = this.get(id);
    if(!r.pending.length || live.closed)return;
    const message=r.pending[0];
    if(message.model || message.effort !== undefined){
      const selected=await this.resolveSelection(r.user_id,message.model ?? r.model_id);
      if(selected.backend!==r.backend)throw new ApiError(400,"invalid_backend","Start a new run to change coding agents.");
      r.model_id=selected.id;r.effort=validateEffort(selected,message.effort ?? "default");this.save(r);
    }
    if(r.backend){
      const key=`${r.user_id}:${r.backend}`;
      if(this.cliAccounts.busy(r.user_id,r.backend) || this.cliLeases.has(key) && this.cliLeases.get(key)!==id){this.status(r,"queued","Waiting for your subscription agent");return;}
      this.cliLeases.set(key,id);
      const state=await live.workspace.rpc<CLIState>("cli_state");
      await live.workspace.rpc("cli_stop");
      await live.workspace.rpc("cli_prepare",{state:{...state,credentials:this.cliAccounts.credentials(r.user_id,r.backend)},config:{backend:r.backend,model:decodeURIComponent(r.model_id.split(":").slice(1).join(":")),effort:r.effort??"default"}});
      await live.workspace.rpc("start",{backend:r.backend,model:r.model_id,effort:r.effort??"default"});
    }
    r.pending.shift();
    if (live.closed) return;
    r.summary = emptySummary();
    r.phase = "agent";
    this.status(r, "working", "Thinking");
    if(message.effort !== undefined){
      const selected=await this.resolveSelection(r.user_id,r.model_id);
      r.effort=validateEffort(selected,message.effort);this.save(r);
    }
    live.busy = true;
    live.turnAt = Date.now();
    if(!r.backend){
      const selected=await resolveModel(this.db,this.cfg.secret,r.model_id);
      await live.workspace.rpc("send",{input:{type:"model",model:r.model_id,context_window:selected.context_window}});
      await live.workspace.rpc("send", {input:{type:"effort",effort:r.effort ?? "high"}});
    }
    await live.workspace.rpc("send", {
      input: {
        type: "user",
        text: message.text,
        effort: message.effort ?? r.effort ?? "high",
        images: message.images.map((id) => {
          if(!r.backend)return {id};
          const image=this.db.prepare("SELECT media_type,bytes FROM images WHERE id=? AND run_id=? AND user_id=?").get(id,r.id,r.user_id) as {media_type:string;bytes:Buffer};
          return {media_type:image.media_type,data:image.bytes.toString("base64")};
        }),
      },
    });
  }
  private async pump(id: string, live: Live) {
    while (!live.closed) {
      const batch = await live.workspace.rpc<{
        events: Record<string, any>[];
        alive: boolean;
      }>("events", { after: live.cursor });
      live.cursor += batch.events.length;
      for (const event of batch.events) {
        if (live.closed) return;
        if(event.type === "cli.usage"){
          const owner=this.get(id);
          const u=recordCLIUsage(this.db,owner.user_id,id,{...event,model:`cli-${owner.backend}:${encodeURIComponent(event.model)}`} as any);
          if(u)this.append(id,{type:"usage",input:u.input_uncached,output:u.output,cache_read:u.cache_read,context_used:0,context_window:200000});
          continue;
        }
        if(event.type === "cli.catalog" || event.type === "cli.account")continue;
        this.append(id, event);
        const r = this.get(id);
        r.summary = fold(r.summary, event as any);
        Object.assign(r, totals(r.summary), {
          plan_done: r.summary.plan_done,
          plan_total: r.summary.plan_total,
          step: r.summary.step,
        });
        this.save(r);
        if (event.type === "error" && event.agent_id === "main") {
          await this.captureCLI(r,live.workspace);this.releaseCLI(r);
          live.busy = false;
          r.idle_since = Date.now();
          this.status(r, "failed", null, String(event.message));
        }
        if (event.type === "turn.end" && event.agent_id === "main") {
          await this.captureCLI(r,live.workspace);this.releaseCLI(r);
          if (event.stop_reason === "error") continue;
          if (event.stop_reason === "interrupted") {
            live.busy = false;
            r.idle_since = Date.now();
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
      if (live.busy && Date.now() - live.turnAt > this.cfg.turnMs)
        await this.stop(id, r.user_id);
      if (!live.busy && Date.now() - r.idle_since > this.cfg.idleMs) {
        await this.close(id);
        return;
      }
      await delay(batch.events.length ? 50 : 300);
    }
  }
  private async finish(id: string, live: Live) {
    let r = this.get(id);
    r.phase = "finishing";
    this.status(r, "working", "Pushing changes");
    const snapshot = await live.workspace.rpc<{ bundle: string; head: string }>(
      "snapshot",
      { title: r.title },
    );
    await importBundle(
      live.cwd,
      Buffer.from(snapshot.bundle, "base64"),
      r.branch,
      githubEnv(this.db, this.cfg.secret),
    );
    r = this.get(id);
    r.pushed = true;
    r.head_sha = snapshot.head;
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
    this.save(r);
    this.append(id, {
      type: "run.diff",
      files: r.files,
      additions: r.additions,
      deletions: r.deletions,
    });
    if (r.auto_pr && r.files) await this.openPull(id, r.user_id);
    r = this.get(id);
    live.busy = false;
    r.phase = "agent";
    r.idle_since = Date.now();
    r.finished_at = Date.now();
    this.status(r, "ready");
  }
  async openPull(id: string, user: string) {
    const r = this.get(id, user);
    if (!r.pushed)
      throw new ApiError(
        409,
        "not_pushed",
        "Wait until the changes have been pushed.",
      );
    const body =
      (r.summary.text || r.prompt) +
      `\n\nOpened by [Gond Agent](${this.cfg.origin}/agents/runs/${id}).`;
    if (r.pr_number)
      await gh(`repos/${r.repo}/pulls/${r.pr_number}`, "PATCH", { body }, githubEnv(this.db, this.cfg.secret));
    else {
      const existing = await gh<{ number: number; html_url: string }[]>(
        `repos/${r.repo}/pulls?head=${encodeURIComponent(r.repo.split("/")[0] + ":" + r.branch)}&state=open`,
        "GET", undefined, githubEnv(this.db, this.cfg.secret),
      );
      const pr =
        existing[0] ??
        (await gh<{ number: number; html_url: string }>(
          `repos/${r.repo}/pulls`,
          "POST",
          { head: r.branch, base: r.base_branch, title: r.title, body },
          githubEnv(this.db, this.cfg.secret),
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
    }, githubEnv(this.db, this.cfg.secret));
    r.pr_state = "merged";
    r.phase = "idle";
    this.status(r, "merged");
    await this.close(id);
  }
  async stop(id: string, user: string) {
    const r = this.get(id, user);
    r.pending = [];
    r.idle_since = Date.now();
    this.status(r, "stopped");
    const live = this.live.get(id);
    if (live && live.busy) await live.workspace.rpc("send", { input: { type: "interrupt" } });
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
  async close(id: string) {
    const live = this.live.get(id);
    if (live) {
      live.closed = true;
      this.live.delete(id);
      const closingRun=this.get(id);
      if(closingRun.backend && this.cliLeases.get(`${closingRun.user_id}:${closingRun.backend}`)===id)await this.captureCLI(closingRun,live.workspace).catch(()=>{});
      this.releaseCLI(this.get(id));
      await live.workspace.destroy();
    }
    try {
      const r = this.get(id);
      r.phase = "idle";
      this.save(r);
    } catch {}
  }
  async closeCLIRuntime(backend:CLI,user?:string){
    const rows=this.db.prepare("SELECT data FROM runs WHERE json_extract(data,'$.backend')=? AND deleted_at IS NULL"+(user?" AND user_id=?":"")).all(...(user?[backend,user]:[backend])) as {data:string}[];
    const runs=rows.map(r=>JSON.parse(r.data) as Run);
    if(runs.some(r=>["queued","working"].includes(r.status)||this.live.get(r.id)?.busy||this.booting.has(r.id)))throw new ApiError(409,"cli_in_use","Stop active subscription runs before closing workspaces.");
    for(const r of runs)await this.close(r.id);
    return {ok:true};
  }
  async shutdown() {
    this.shuttingDown = true;
    await this.cliAccounts.close();
    await Promise.allSettled([...this.launches.values()]);
    await Promise.allSettled([...this.live.keys()].map((id) => this.close(id)));
  }
  private async fail(id: string, error: unknown) {
    console.error("run failed", id, error);
    try {
      const r = this.get(id);
      r.phase = "idle";
      r.pending = [];
      this.status(
        r,
        "failed",
        null,
        error instanceof ApiError ? error.message : "The run couldn't continue. Check the host logs, then send a follow-up to retry.",
      );
    } catch {}
    await this.close(id);
  }
}
