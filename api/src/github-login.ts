import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { getSetting, setSetting, type Store } from "./db";
import { seal, unseal } from "./auth";
import { ApiError } from "./wire";

export function githubEnv(db: Store, secret: string): NodeJS.ProcessEnv {
  const saved = getSetting<{ token: string }>(db, "github");
  const env: NodeJS.ProcessEnv = { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" };
  if (saved) {
    delete env.GITHUB_TOKEN;
    env.GH_TOKEN = unseal(secret, saved.token);
  }
  return env;
}

export interface LoginState {
  id?: string;
  status: "idle" | "starting" | "pending" | "connected" | "expired" | "cancelled" | "error" | "busy";
  code?: string;
  url?: string;
  expiresAt?: number;
  message?: string;
}
export interface LoginJob { token: Promise<string>; cancel: () => void }
export type LoginDriver = (root: string, code: (value: string) => void) => LoginJob;

// Use gh's own OAuth client/device flow, but never its shared config or a host keyring.
export const deviceLogin: LoginDriver = (root, onCode) => {
  let cancel = () => {};
  let cancelled = false;
  const token = (async () => {
    const dir = await mkdtemp(join(root, "flow-"));
    try {
      if (cancelled) throw new Error("Cancelled");
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, GH_CONFIG_DIR: dir, GH_HOST: "github.com", GH_BROWSER: "/usr/bin/true", BROWSER: "/usr/bin/true", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
      for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[key];
      // Debian's older gh stores files directly; newer gh must explicitly bypass keyrings.
      const { stdout: help } = await promisify(execFile)("gh", ["auth", "login", "--help"], { env, timeout: 10000, maxBuffer: 65536 });
      if (cancelled) throw new Error("Cancelled");
      const args = ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", "workflow"];
      if (help.includes("--insecure-storage")) args.push("--insecure-storage");
      await new Promise<void>((resolve, reject) => {
        const child = spawn("gh", args, { env, stdio: ["ignore", "pipe", "pipe"] });
        cancel = () => { child.kill("SIGKILL"); };
        let output = "", size = 0;
        const read = (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16384) { cancel(); return; }
          output += chunk.toString();
          const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(output)?.[1];
          if (code) onCode(code.toUpperCase());
        };
        child.stdout.on("data", read);
        child.stderr.on("data", read);
        child.once("error", reject);
        child.once("close", code => code === 0 ? resolve() : reject(new Error("GitHub authorization did not finish")));
      });
      if (cancelled) throw new Error("Cancelled");
      const { stdout } = await promisify(execFile)("gh", ["auth", "token", "--hostname", "github.com"], { env, timeout: 10000, maxBuffer: 16384 });
      const value = stdout.trim();
      if (!value || value.length > 4096 || /\s/.test(value)) throw new Error("Invalid credential");
      return value;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return { token, cancel: () => { cancelled = true; cancel(); } };
};

interface Flow { owner: string; state: LoginState; job: LoginJob; timer: ReturnType<typeof setTimeout>; done: Promise<void> }
export class GithubLogin {
  private flow?: Flow;
  private closed = false;
  private root: string;
  constructor(private db: Store, private secret: string, data: string, private driver: LoginDriver = deviceLogin) {
    this.root = join(data, "github-login");
    // Only this service's disposable authorization files; never the mounted host config.
    rmSync(this.root, { recursive: true, force: true });
    mkdirSync(this.root, { mode: 0o700 });
  }
  private owner(session: string) { return createHash("sha256").update(session).digest("hex"); }
  state(session: string): LoginState {
    if (!this.flow) return { status: "idle" };
    if (this.flow.owner !== this.owner(session)) return { status: this.pending() ? "busy" : "idle" };
    return { ...this.flow.state };
  }
  private pending() { return this.flow && ["starting", "pending"].includes(this.flow.state.status); }
  start(session: string, authorized: () => Promise<boolean> = async () => true) {
    if (this.closed) throw new ApiError(503, "github_closed", "The server is restarting. Try again in a moment.");
    if (this.pending()) {
      if (this.flow!.owner === this.owner(session)) return this.state(session);
      throw new ApiError(409, "github_busy", "Another administrator is connecting GitHub. Try again later.");
    }
    const state: LoginState = { id: randomBytes(16).toString("hex"), status: "starting", expiresAt: Date.now() + 10 * 60000 };
    const job = this.driver(this.root, code => {
      if (this.flow?.state === state && this.pending()) Object.assign(state, { status: "pending", code, url: "https://github.com/login/device" });
    });
    const flow: Flow = { owner: this.owner(session), state, job, timer: setTimeout(() => this.stop("expired"), 10 * 60000), done: Promise.resolve() };
    flow.timer.unref();
    this.flow = flow;
    flow.done = job.token.then(async token => {
      if (!await authorized()) { if (this.flow === flow) this.stop("cancelled"); return; }
      if (this.flow !== flow || !this.pending()) return;
      if (Date.now() >= state.expiresAt!) { this.stop("expired"); return; }
      setSetting(this.db, "github", { token: seal(this.secret, token) });
      flow.state = { id: state.id, status: "connected" };
    }).catch(() => {
      if (this.flow === flow && this.pending()) {
        console.warn("GitHub device authorization did not finish");
        flow.state = { id: state.id, status: "error", message: "GitHub sign-in didn't finish. Try again and approve the code on GitHub." };
      }
    }).finally(() => clearTimeout(flow.timer));
    return this.state(session);
  }
  private stop(status: "cancelled" | "expired") {
    const flow = this.flow;
    if (!flow || !this.pending()) return;
    flow.state = { id: flow.state.id, status };
    clearTimeout(flow.timer);
    flow.job.cancel();
  }
  cancel(session: string, id: string) {
    if (this.flow && (this.flow.owner !== this.owner(session) || this.flow.state.id !== id)) throw new ApiError(409, "github_flow", "This sign-in belongs to another session. Refresh and try again.");
    this.stop("cancelled");
    return this.state(session);
  }
  reset() {
    this.stop("cancelled");
    this.flow = undefined;
  }
  async close() {
    this.closed = true;
    this.stop("cancelled");
    await this.flow?.done;
  }
}
