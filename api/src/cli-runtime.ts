import { randomBytes } from "node:crypto";
import type { Config } from "./config";
import { command } from "./command";
import { getSetting, setSetting, type Store } from "./db";
import { ApiError } from "./wire";
export type CLI = "claude-code" | "codex";
export interface Runtime { backend: CLI; version: string; packageVersion: string; volume: string; package: string; installedAt: number }
const supportedVersions: Record<CLI,string> = {"claude-code":"0.3.314",codex:"0.166.0"};
const binaryVersions: Record<CLI,string> = {"claude-code":"2.1.314",codex:"0.166.0"};
const packages: Record<CLI, string> = { "claude-code": "@anthropic-ai/claude-agent-sdk", codex: "@openai/codex" };
export function cli(value: string): CLI {
  if (value !== "claude-code" && value !== "codex") throw new ApiError(400, "invalid_backend", "Choose Claude Code or Codex.");
  return value;
}
export class CLIRuntimes {
  private jobs = new Map<CLI, { status: string; message?: string }>();
  constructor(private db: Store, private cfg: Config) {}
  get(backend: CLI) { return getSetting<Runtime>(this.db, `runtime:${backend}`); }
  status() { return (Object.keys(packages) as CLI[]).map(backend => ({ backend, runtime: this.get(backend), availableVersion:binaryVersions[backend], operation: this.jobs.get(backend) })); }
  async install(backend: CLI) {
    if (this.jobs.get(backend)?.status === "working") throw new ApiError(409, "runtime_busy", "This installation is already being changed.");
    const installed=this.get(backend);
    if(installed?.packageVersion===supportedVersions[backend])return installed;
    this.jobs.set(backend, { status: "working" });
    try {
      // npm verifies registry integrity and installs an exact version into an immutable volume.
      const release = {version:supportedVersions[backend]};
      const volume = `gond-agent-cli-${randomBytes(16).toString("hex")}`;
      const identity=getSetting<string>(this.db,"runtime-instance") ?? randomBytes(12).toString("hex");
      setSetting(this.db,"runtime-instance",identity);
      setSetting(this.db,`runtime-staging:${backend}`,volume);
      await command(this.cfg.dockerBin, ["volume", "create", "--label", "io.gond-agent.runtime=true", "--label", `io.gond-agent.runtime-instance=${identity}`, volume]);
      try {
        await command(this.cfg.dockerBin, ["run", "--rm", "--name", `${volume}-install`, "--user", "1000:1000", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "1g", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=1777", "--mount", `type=volume,source=${volume},target=/home/gond-agent`, "--entrypoint", "npm", this.cfg.workerImage, "install", "--prefix", "/home/gond-agent/package", "--cache", "/tmp/npm", "--ignore-scripts", "--no-audit", "--no-fund", `${packages[backend]}@${release.version}`], { timeout: 180000 });
        const verify = `const fs=require('node:fs'),cp=require('node:child_process');const backend=process.argv[1];let binary='/opt/gond-runtime/package/node_modules/.bin/codex';if(backend==='claude-code'){const root='/opt/gond-runtime/package/node_modules/@anthropic-ai';const platform='claude-agent-sdk-linux-'+(process.arch==='arm64'?'arm64':'x64');if(!fs.readdirSync(root).includes(platform))throw Error('Unsupported platform');binary=root+'/'+platform+'/claude';}const version=cp.execFileSync(binary,['--version'],{encoding:'utf8',env:{...process.env,HOME:'/tmp',CODEX_HOME:'/tmp'}});if(!version.includes(process.argv[2]))throw Error('Unexpected runtime version');`;
        await command(this.cfg.dockerBin,["run","--rm","--user","1000:1000","--read-only","--cap-drop","ALL","--security-opt","no-new-privileges","--pids-limit","128","--memory","512m","--network","none","--tmpfs","/tmp:rw,nosuid,nodev,size=64m,mode=1777","--mount",`type=volume,source=${volume},target=/opt/gond-runtime,readonly`,"--entrypoint","node",this.cfg.workerImage,"-e",verify,backend,binaryVersions[backend]],{timeout:30000});
        const runtime = { backend, version: binaryVersions[backend], packageVersion:release.version, volume, package: packages[backend], installedAt: Date.now() };
        const previous=getSetting<string[]>(this.db,`runtime-history:${backend}`) ?? [];
        if(installed)previous.push(installed.volume);
        // Activating a release and clearing staging must survive a crash atomically.
        this.db.transaction(()=>{
          setSetting(this.db,`runtime-history:${backend}`,previous);
          setSetting(this.db, `runtime:${backend}`, runtime);
          this.db.prepare("DELETE FROM settings WHERE key=?").run(`runtime-staging:${backend}`);
        })();
        this.jobs.set(backend, { status: "ready" });
        return runtime;
      } catch (error) {
        await command(this.cfg.dockerBin, ["volume", "rm", volume]).catch(() => {});
        this.db.prepare("DELETE FROM settings WHERE key=?").run(`runtime-staging:${backend}`);
        throw error;
      }
    } catch {
      this.jobs.set(backend, { status: "error", message: "Installation failed. Check the server logs and retry." });
      throw new ApiError(502, "runtime_install", "Couldn't install this runtime. The previous version is still available.");
    }
  }
  async recover(){
    for(const backend of ["claude-code","codex"] as CLI[]){
      const volume=getSetting<string>(this.db,`runtime-staging:${backend}`);
      if(!volume)continue;
      await command(this.cfg.dockerBin,["rm","--force",`${volume}-install`]).catch(()=>{});
      await command(this.cfg.dockerBin,["volume","rm",volume]).catch(()=>{});
      this.db.prepare("DELETE FROM settings WHERE key=?").run(`runtime-staging:${backend}`);
    }
  }
  async uninstall(backend: CLI) {
    if (this.jobs.get(backend)?.status === "working") throw new ApiError(409, "runtime_busy", "Wait for installation to finish.");
    if (this.db.prepare("SELECT 1 FROM runs WHERE json_extract(data,'$.backend')=? AND json_extract(data,'$.phase')!='idle' AND deleted_at IS NULL LIMIT 1").get(backend))
      throw new ApiError(409, "runtime_in_use", "Close this runtime’s workspaces before uninstalling it.");
    this.jobs.set(backend,{status:"working"});
    try {
    const runtime = this.get(backend);
    const volumes=[...new Set([...(getSetting<string[]>(this.db,`runtime-history:${backend}`) ?? []),...(runtime?[runtime.volume]:[])])];
    const existing=new Set((await command(this.cfg.dockerBin,["volume","ls","--quiet"])).toString().trim().split(/\s+/));
    for(const volume of volumes)if(existing.has(volume))await command(this.cfg.dockerBin,["volume","rm",volume]);
    this.db.prepare("DELETE FROM settings WHERE key=?").run(`runtime-history:${backend}`);
    this.db.prepare("DELETE FROM settings WHERE key=?").run(`runtime:${backend}`);
    this.db.prepare("DELETE FROM cli_accounts WHERE backend=?").run(backend);
    this.jobs.delete(backend);
    return { ok: true };
    }catch{
      this.jobs.set(backend,{status:"error",message:"Could not uninstall. Close idle workspaces and finish any sign-in, then retry."});
      throw new ApiError(409,"runtime_in_use","Could not uninstall. Close idle workspaces and finish any sign-in, then retry.");
    }
  }
}
