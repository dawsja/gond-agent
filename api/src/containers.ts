import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { command } from "./command";
import type { Config } from "./config";

export interface Workspace {
  rpc<T = any>(method: string, args?: Record<string, unknown>): Promise<T>;
  destroy(): Promise<void>;
}
export type WorkspaceFactory = (id: string, modelHandler: (req: Request) => Promise<Response>, runtimeVolume?: string) => Promise<Workspace>;
const MANAGED = "io.gond-agent.managed=true";
const MAX_FRAME = 256 * 1024 * 1024;

/** No host paths, credentials, devices, published ports or Docker socket enter a workspace. */
export function containerArguments(cfg: Config, name: string, instance: string, run: string, runtimeVolume?: string) {
  return [
    "create", "--name", name, "--interactive", "--init",
    "--label", MANAGED, "--label", `io.gond-agent.instance=${instance}`, "--label", `io.gond-agent.run=${run}`,
    "--user", "1000:1000", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges=true", "--pids-limit", "512",
    "--cpus", String(cfg.runCPUs), "--memory", `${cfg.runMemoryMB}m`, "--memory-swap", `${cfg.runMemoryMB}m`,
    "--shm-size", "256m", "--ulimit", "nofile=4096:4096",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g,uid=1000,gid=1000,mode=1777",
    "--tmpfs", "/home/gond-agent:rw,nosuid,nodev,size=256m,uid=1000,gid=1000",
    "--mount", `type=volume,source=${name}-work,target=/workspace/repo`,
    ...(runtimeVolume ? ["--mount", `type=volume,source=${runtimeVolume},target=/opt/gond-runtime,readonly`] : []),
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

  async start(id: string, modelHandler: (req: Request) => Promise<Response>, runtimeVolume?: string): Promise<Workspace> {
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
      if (!child || disconnected || destroyed) return reject(new Error("Workspace disconnected"));
      child.stdin.write(JSON.stringify(frame) + "\n", (error) => error ? reject(error) : resolve());
    });
    const destroy = () => destruction ??= (async () => {
      destroyed = true;
      fail(new Error("Workspace stopped"));
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
      const timer = setTimeout(() => { pending.delete(key); reject(new Error("Workspace request timed out")); }, 180_000);
      pending.set(key, { resolve, reject, timer });
      void send({ id: key, method, ...args }).catch((error) => {
        clearTimeout(timer); pending.delete(key); reject(error);
      });
    });
    const model = async (frame: any) => {
      const key = frame.id;
      if (typeof key !== "string" || models.has(key) || models.size >= 16) throw new Error("Invalid model request");
      const controller = new AbortController();
      models.set(key, controller);
      try {
        if (!((frame.method === "GET" && frame.path === "/v1/models") || (frame.method === "POST" && frame.path === "/v1/responses"))) {
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
      await this.docker(["volume", "create", ...labels, `${name}-work`]);
      await this.docker(["network", "create", ...labels, "--driver", "bridge", "--opt", "com.docker.network.bridge.enable_icc=false", `${name}-net`]);
      await this.docker(containerArguments(this.cfg, name, instance, id, runtimeVolume));
      child = spawn(this.cfg.dockerBin, ["start", "--attach", "--interactive", name], { stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.on("error", (error) => fail(error));
      child.on("error", (error) => fail(error));
      child.on("exit", () => fail(new Error("Workspace exited")));
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
            const p = pending.get(frame.id);
            if (!p) continue;
            pending.delete(frame.id); clearTimeout(p.timer);
            if (typeof frame.error === "string") p.reject(new Error(frame.error)); else p.resolve(frame.result);
          } catch { fail(new Error("Invalid workspace response")); child?.kill(); }
        }
      });
      await rpc("ping");
      return { rpc, destroy };
    } catch (error) {
      await destroy().catch((cleanupError) => console.error("Workspace startup cleanup failed", id, cleanupError));
      throw error;
    }
  }
}
