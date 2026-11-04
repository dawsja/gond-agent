import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { command } from "./command";
import type { Config } from "./config";
import { CheckpointCaptureError, isCheckpointFailureReason } from "./checkpoint-failures";

export interface WorkspaceCheckpointOptions {
  owner_id: string;
  base_sha: string;
  /** Known upstream checkout/published commit; omit to use the worker's actual HEAD. */
  head_sha?: string;
  identity: { name: string; email: string };
}
export interface WorkspaceCheckpoint {
  boundary_id: string;
  fingerprint?: string;
  bundle: string; // base64; opaque bytes, never unpack on the API host
  base_sha: string;
  head_sha: string;
  checkpoint_sha: string;
  state: { runner_state_version: string; [key: string]: unknown };
}

export interface Workspace {
  rpc<T = any>(method: string, args?: Record<string, unknown>): Promise<T>;
  destroy(): Promise<void>;
  /** Local transport liveness; do not send advisory RPCs after disconnect/teardown. */
  isAlive?(): boolean;
  /** Call after start/import and before sending work. Save runs while the runner is held.
   * Optional for alternate WorkspaceFactory implementations without checkpoint support. */
  enableCheckpoints?(options: WorkspaceCheckpointOptions,
    save: (checkpoint: WorkspaceCheckpoint) => void | Promise<void>, onError?: (error: unknown) => void): Promise<void>;
  /** Await any in-flight boundary capture, persistence and release; rejects on failure. */
  flushCheckpoints?(): Promise<void>;
  /** After turn.end and publication, hold the idle worker and save its current tree/history once.
   * Optionally update the restore baseline for this and subsequent captures.
   * Requires enableCheckpoints; await before closing. Do not concurrently send new work. */
  captureCheckpoint?(options?: { head_sha: string }): Promise<void>;
}
export type WorkspaceFactory = (id: string, modelHandler: (req: Request) => Promise<Response>) => Promise<Workspace>;
const MANAGED = "io.gond-agent.managed=true";
const MAX_FRAME = 256 * 1024 * 1024;
export const CHECKPOINT_MIN_INTERVAL_MS = 30_000;

/** No host paths, credentials, devices, published ports or Docker socket enter a workspace. */
export function containerArguments(cfg: Config, name: string, instance: string, run: string) {
  return [
    "create", "--name", name, "--interactive", "--init",
    "--label", MANAGED, "--label", `io.gond-agent.instance=${instance}`, "--label", `io.gond-agent.run=${run}`,
    "--user", "1000:1000", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges=true", "--pids-limit", "512",
    "--cpus", String(cfg.runCPUs), "--memory", `${cfg.runMemoryMB}m`, "--memory-swap", `${cfg.runMemoryMB}m`,
    "--shm-size", "256m", "--ulimit", "nofile=4096:4096",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=1g,uid=1000,gid=1000,mode=1777",
    "--tmpfs", "/home/gond-agent:rw,nosuid,nodev,noexec,size=256m,uid=1000,gid=1000",
    "--mount", `type=volume,source=${name}-work,target=/workspace/repo`,
    "--mount", `type=volume,source=${name}-tools,target=/opt/gond-tools`,
    "--network", `${name}-net`, "--log-driver", "none", cfg.workerImage,
  ];
}

export class ContainerPool {
  private active = new Set<string>();
  private identity?: Promise<string>;
  constructor(private cfg: Config) {}

  private instance() {
    return this.identity ??= (async () => {
      await mkdir(this.cfg.data, { recursive: true, mode: 0o700 });
      const path = join(this.cfg.data, "container-instance");
      try { await writeFile(path, randomBytes(12).toString("hex"), { flag: "wx", mode: 0o600 }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      const id = (await readFile(path, "utf8")).trim();
      if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid container instance identity");
      return id;
    })();
  }

  private docker(args: string[], input?: string) {
    return command(this.cfg.dockerBin, args, { input, timeout: 180_000 });
  }

  private async cleanup(run?: string) {
    const instance = await this.instance();
    const filters = ["--filter", `label=${MANAGED}`, "--filter", `label=io.gond-agent.instance=${instance}`];
    if (run) filters.push("--filter", `label=io.gond-agent.run=${run}`);
    // Remove containers first, then their volumes and networks. Never sweep unrelated resources.
    for (const [kind, list, remove] of [
      ["container", ["ps", "--all", "--quiet"], ["rm", "--force"]],
      ["volume", ["volume", "ls", "--quiet"], ["volume", "rm"]],
      ["network", ["network", "ls", "--quiet"], ["network", "rm"]],
    ] as const) {
      const ids = (await this.docker([...list, ...filters])).toString().trim().split(/\s+/).filter(Boolean);
      for (const id of ids) {
        try { await this.docker([...remove, id]); }
        catch (error) { console.error("Workspace cleanup failed", kind, id); throw error; }
      }
    }
  }

  async recover() { await this.cleanup(); }

  async start(id: string, modelHandler: (req: Request) => Promise<Response>): Promise<Workspace> {
    if (!/^run_[a-f0-9]{24}$/.test(id)) throw new Error("Invalid workspace id");
    if (this.active.has(id)) throw new Error("This workspace is already running");
    if (this.active.size >= this.cfg.maxRuns) throw new Error("All workspace slots are in use");
    this.active.add(id);
    let child: ChildProcessWithoutNullStreams | undefined;
    let destroyed = false;
    let destruction: Promise<void> | undefined;
    let sequence = 0;
    let disconnected = false;
    const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const models = new Map<string, AbortController>();
    const fail = (error: Error) => {
      disconnected = true;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
      pending.clear();
      for (const controller of models.values()) controller.abort();
      models.clear();
    };
    const send = (frame: unknown) => new Promise<void>((resolve, reject) => {
      if (!child || disconnected || destroyed) return reject(new CheckpointCaptureError("worker_unavailable", "Workspace disconnected"));
      child.stdin.write(JSON.stringify(frame) + "\n", (error) => error ? reject(error) : resolve());
    });
    const destroy = () => destruction ??= (async () => {
      destroyed = true;
      fail(new CheckpointCaptureError("worker_unavailable", "Workspace stopped"));
      child?.stdin.end();
      try { await this.cleanup(id); }
      finally {
        if (child && child.exitCode === null) {
          await Promise.race([new Promise<void>((r) => child!.once("exit", () => r())), delay(3000)]);
          if (child.exitCode === null) child.kill("SIGKILL");
        }
        this.active.delete(id);
      }
    })().catch((e) => { destruction = undefined; throw e; });
    const rpc = <T = any>(method: string, args: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
      const key = String(++sequence);
      const timer = setTimeout(() => { pending.delete(key); reject(new CheckpointCaptureError("timeout", "Workspace request timed out")); }, 180_000);
      pending.set(key, { resolve, reject, timer });
      void send({ id: key, method, ...args }).catch((error) => {
        clearTimeout(timer); pending.delete(key); reject(error);
      });
    });
    let checkpointHandler: { options: WorkspaceCheckpointOptions; save: (checkpoint: WorkspaceCheckpoint) => void | Promise<void>; onError?: (error: unknown) => void } | undefined;
    let checkpointBoundary: string | undefined;
    let checkpointTask: Promise<void> | undefined;
    let checkpointError: unknown;
    let checkpointGate: Promise<void> | undefined;
    let capturePending = false;
    let checkpointSequence = 0;
    let checkpointAttemptAt = -Infinity;
    let checkpointFingerprint: string | undefined;
    const checkpointReady = (boundary: unknown) => {
      if (typeof boundary !== "string" || !/^[a-f0-9]{32}$/.test(boundary) || checkpointBoundary) {
        fail(new Error("Invalid checkpoint boundary"));
        void destroy().catch(() => {});
        return;
      }
      checkpointSequence++;
      checkpointBoundary = boundary;
      startCheckpointTask();
    };
    const startCheckpointTask = () => {
      // At most one active save and one next held boundary (which can arrive
      // just before release's RPC reply). Never queue a save per transcript event.
      checkpointTask ??= (async () => {
        // An explicit hold emits ready before export_state returns. Do not send
        // the paired export until that controller state RPC has finished.
        if (checkpointGate) await checkpointGate;
        while (checkpointBoundary && !destroyed && !disconnected) {
          const boundary_id = checkpointBoundary;
          checkpointBoundary = undefined;
          try {
            if (checkpointHandler && (capturePending || Date.now() - checkpointAttemptAt >= CHECKPOINT_MIN_INTERVAL_MS)) {
              checkpointAttemptAt = Date.now();
              const capture = await rpc<WorkspaceCheckpoint | { unchanged: true }>("checkpoint", {
                ...checkpointHandler.options, run_id: id, boundary_id, previous_fingerprint: checkpointFingerprint,
              });
              if (!("unchanged" in capture)) {
                await checkpointHandler.save(capture);
                checkpointFingerprint = capture.fingerprint;
              }
              checkpointError = undefined;
            }
          } catch (error) {
            checkpointError = error ?? new Error("Workspace checkpoint save failed");
            console.error("Workspace checkpoint save failed", id);
            try { checkpointHandler?.onError?.(error); } catch { /* Never log private state. */ }
          } finally {
            if (!destroyed && !disconnected) await rpc("checkpoint.release", { boundary_id });
          }
        }
      })().catch(async (error) => {
        checkpointError = error ?? new Error("Workspace checkpoint release failed");
        // A failed release leaves execution position unknown. Never reuse it.
        console.error("Workspace checkpoint release failed", id);
        try { checkpointHandler?.onError?.(error); } catch { /* Never log private state. */ }
        await destroy().catch(() => {});
      }).finally(() => {
        checkpointTask = undefined;
        if (checkpointBoundary && !destroyed && !disconnected) startCheckpointTask();
      });
    };
    const flushCheckpoints = async () => {
      while (checkpointTask) await checkpointTask;
      if (checkpointError !== undefined) throw checkpointError;
      if (destroyed || disconnected) throw new CheckpointCaptureError("worker_unavailable", "Workspace disconnected");
    };
    const captureCheckpoint: NonNullable<Workspace["captureCheckpoint"]> = async (options) => {
      if (!checkpointHandler) throw new Error("Workspace checkpoints are not enabled");
      if (capturePending) throw new CheckpointCaptureError("busy", "Workspace checkpoint capture is already pending");
      capturePending = true;
      try {
        // A prior failed save must not prevent trying a new post-publication capture.
        try { await flushCheckpoints(); }
        catch { if (destroyed || disconnected) throw new CheckpointCaptureError("worker_unavailable", "Workspace disconnected"); }
        checkpointError = undefined;
        if (options) checkpointHandler.options.head_sha = options.head_sha;
        const before = checkpointSequence;
        let unblock!: () => void;
        checkpointGate = new Promise<void>((resolve) => { unblock = resolve; });
        try {
          await rpc("export_state", { run_id: id, owner_id: checkpointHandler.options.owner_id, quiescent: true, hold: true });
          if (checkpointSequence === before) throw new Error("Missing idle checkpoint boundary");
        } finally {
          checkpointGate = undefined;
          unblock();
          // Even failed/timed-out requests may already have emitted ready. Finish
          // their save/release rather than returning while a known hold is active.
          await flushCheckpoints();
        }
      } finally { capturePending = false; }
    };
    const enableCheckpoints: NonNullable<Workspace["enableCheckpoints"]> = async (options, save, onError) => {
      if (checkpointHandler) throw new Error("Workspace checkpoints are already enabled");
      checkpointHandler = { options: { ...options, identity: { ...options.identity } }, save, onError };
      try {
        // This initial idle export binds the runner and opts in; later ready
        // notifications are emitted once per completed main round, plus turn start.
        await rpc("export_state", { run_id: id, owner_id: options.owner_id, quiescent: true });
      } catch (error) { checkpointHandler = undefined; throw error; }
    };
    const model = async (frame: any) => {
      const key = frame.id;
      if (typeof key !== "string" || models.has(key) || models.size >= 16) throw new Error("Invalid model request");
      const controller = new AbortController();
      models.set(key, controller);
      try {
        if (!((frame.method === "GET" && frame.path === "/v1/models") || (frame.method === "POST" && ["/v1/responses", "/v1/search"].includes(frame.path)))) {
          await send({ model_id: key, status: 403, headers: { "content-type": "text/plain" } });
        } else {
          const req = new Request(`http://worker${frame.path}`, {
            method: frame.method, headers: { "content-type": "application/json" }, signal: controller.signal,
            ...(frame.method === "POST" ? { body: Buffer.from(frame.body ?? "", "base64") } : {}),
          });
          const response = await modelHandler(req);
          await send({ model_id: key, status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
          if (response.body) {
            const reader = response.body.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                await send({ model_id: key, chunk: Buffer.from(value).toString("base64") });
              }
            } finally { await reader.cancel().catch(() => {}); }
          }
        }
      } catch (e) {
        if (!controller.signal.aborted && !destroyed) {
          console.error("Workspace model request failed", id);
          await send({ model_id: key, status: 502, headers: { "content-type": "application/json" } }).catch(() => {});
        }
      } finally {
        models.delete(key);
        await send({ model_id: key, end: true }).catch(() => {});
      }
    };
    try {
      const instance = await this.instance();
      const name = `gond-agent-${instance}-${id.slice(4)}`;
      const labels = ["--label", MANAGED, "--label", `io.gond-agent.instance=${instance}`, "--label", `io.gond-agent.run=${id}`];
      // Never pull or run an arbitrary repository-provided image; operators build/pull this image.
      await this.docker(["image", "inspect", this.cfg.workerImage]);
      for (const suffix of ["work", "tools"]) {
        await this.docker(["volume", "create", ...labels, `${name}-${suffix}`]);
      }
      await this.docker(["network", "create", ...labels, "--driver", "bridge", "--opt", "com.docker.network.bridge.enable_icc=false", `${name}-net`]);
      await this.docker(containerArguments(this.cfg, name, instance, id));
      child = spawn(this.cfg.dockerBin, ["start", "--attach", "--interactive", name], { stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.on("error", (error) => fail(error));
      child.on("error", (error) => fail(error));
      child.on("exit", () => fail(new CheckpointCaptureError("worker_unavailable", "Workspace exited")));
      child.stderr.on("data", (data: Buffer) => console.error("workspace", id, data.toString().slice(-1000)));
      let buffer = "";
      child.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        if (buffer.length > MAX_FRAME) { fail(new Error("Workspace response too large")); child?.kill(); return; }
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const frame = JSON.parse(line);
            if (frame.model) { void model(frame.model).catch((error) => fail(error)); continue; }
            if (frame.model_cancel) { models.get(frame.model_cancel)?.abort(); continue; }
            if (frame.checkpoint) { checkpointReady(frame.checkpoint.boundary_id); continue; }
            const p = pending.get(frame.id);
            if (!p) continue;
            pending.delete(frame.id); clearTimeout(p.timer);
            if (typeof frame.error === "string") {
              p.reject("checkpoint_reason" in frame
                ? new CheckpointCaptureError(isCheckpointFailureReason(frame.checkpoint_reason) ? frame.checkpoint_reason : "unknown")
                : new Error(frame.error));
            } else p.resolve(frame.result);
          } catch { fail(new Error("Invalid workspace response")); child?.kill(); }
        }
      });
      await rpc("ping");
      return { rpc, destroy, isAlive: () => !destroyed && !disconnected && child?.exitCode === null,
        enableCheckpoints, flushCheckpoints, captureCheckpoint };
    } catch (error) {
      await destroy().catch((cleanupError) => console.error("Workspace startup cleanup failed", id, cleanupError));
      throw error;
    }
  }
}
