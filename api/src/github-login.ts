import { hasServiceGithubCredentials } from "./github-credentials";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { getSetting, setSetting, type Store } from "./db";
import { seal, unseal } from "./auth";
import { githubStatus } from "./github";
import { ApiError } from "./wire";

export function githubEnvFor(db: Store, secret: string, userId: string): NodeJS.ProcessEnv {
  if (!userId) throw new ApiError(409, "github_required", "Connect your GitHub account in Settings > Connections");
  const own = db.prepare("SELECT token FROM github_connections WHERE user_id=?").get(userId) as { token: string } | undefined;
  const fallback = getSetting<boolean>(db, "github-shared-fallback");
  const saved = own ?? (fallback ? getSetting<{ token: string }>(db, "github") : null);
  const env: NodeJS.ProcessEnv = { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" };
  if (saved) {
    delete env.GITHUB_TOKEN;
    env.GH_TOKEN = unseal(secret, saved.token);
  } else if (!fallback || !hasServiceGithubCredentials(env)) {
    throw new ApiError(409, "github_required", "Connect your GitHub account in Settings > Connections");
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
  private flows = new Map<string, Flow>();
  private closed = false;
  private root: string;
  constructor(private db: Store, private secret: string, data: string, private driver: LoginDriver = deviceLogin) {
    this.root = join(data, "github-login");
    rmSync(this.root, { recursive: true, force: true });
    mkdirSync(this.root, { mode: 0o700 });
  }
  private owner(session: string) { return createHash("sha256").update(session).digest("hex"); }
  private pending(flow?: Flow) { return !!flow && ["starting", "pending"].includes(flow.state.status); }
  state(session: string, userId = "shared"): LoginState {
    const flow = this.flows.get(userId);
    if (!flow) return { status: "idle" };
    if (flow.owner !== this.owner(session)) return { status: this.pending(flow) ? "busy" : "idle" };
    return { ...flow.state };
  }
  start(session: string, authorized: () => Promise<boolean> = async () => true, userId = "shared") {
    if (this.closed) throw new ApiError(503, "github_closed", "The server is restarting. Try again in a moment.");
    for (const [key, flow] of this.flows) if (!this.pending(flow) && flow.state.expiresAt! <= Date.now()) this.flows.delete(key);
    const previous = this.flows.get(userId);
    if (this.pending(previous)) {
      if (previous!.owner === this.owner(session)) return this.state(session, userId);
      throw new ApiError(409, "github_busy", "Another session of this account is connecting GitHub. Try again later.");
    }
    if (!previous && this.flows.size >= 100) throw new ApiError(429, "github_busy", "Too many sign-ins. Try again later.");
    const state: LoginState = { id: randomBytes(16).toString("hex"), status: "starting", expiresAt: Date.now() + 10 * 60000 };
    const job = this.driver(this.root, code => {
      const flow = this.flows.get(userId);
      if (flow?.state === state && this.pending(flow)) Object.assign(state, { status: "pending", code, url: "https://github.com/login/device" });
    });
    const flow: Flow = { owner: this.owner(session), state, job, timer: setTimeout(() => this.stop(userId, "expired"), 10 * 60000), done: Promise.resolve() };
    flow.timer.unref();
    this.flows.set(userId, flow);
    const current = () => this.flows.get(userId) === flow && this.pending(flow);
    flow.done = job.token.then(async token => {
      if (!await authorized()) { if (current()) this.stop(userId, "cancelled"); return; }
      if (!current()) return;
      if (Date.now() >= state.expiresAt!) { this.stop(userId, "expired"); return; }
      const status = await githubStatus({ ...process.env, GH_TOKEN: token, GITHUB_TOKEN: undefined });
      if (!await authorized()) { if (current()) this.stop(userId, "cancelled"); return; }
      if (!current()) return;
      if (Date.now() >= state.expiresAt!) { this.stop(userId, "expired"); return; }
      if (userId === "shared") setSetting(this.db, "github", { token: seal(this.secret, token) });
      else this.db.prepare("INSERT INTO github_connections(user_id,token,login,connected_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET token=excluded.token,login=excluded.login,connected_at=excluded.connected_at").run(userId, seal(this.secret, token), status.login, Date.now());
      flow.state = { id: state.id, status: "connected", expiresAt: state.expiresAt };
    }).catch(() => {
      if (current()) {
        console.warn("GitHub device authorization did not finish");
        flow.state = { id: state.id, expiresAt: state.expiresAt, status: "error", message: "GitHub sign-in didn't finish. Try again and approve the code on GitHub." };
      }
    }).finally(() => clearTimeout(flow.timer));
    return this.state(session, userId);
  }
  private stop(userId: string, status: "cancelled" | "expired") {
    const flow = this.flows.get(userId);
    if (!flow || !this.pending(flow)) return;
    flow.state = { id: flow.state.id, expiresAt: flow.state.expiresAt, status };
    clearTimeout(flow.timer);
    flow.job.cancel();
  }
  cancel(session: string, id: string, userId = "shared") {
    const flow = this.flows.get(userId);
    if (flow && (flow.owner !== this.owner(session) || flow.state.id !== id)) throw new ApiError(409, "github_flow", "This sign-in belongs to another session. Refresh and try again.");
    this.stop(userId, "cancelled");
    return this.state(session, userId);
  }
  reset(userId?: string) {
    for (const key of userId ? [userId] : this.flows.keys()) { this.stop(key, "cancelled"); this.flows.delete(key); }
  }
  async close() {
    this.closed = true;
    const flows = [...this.flows.values()];
    for (const key of this.flows.keys()) this.stop(key, "cancelled");
    await Promise.all(flows.map(flow => flow.done));
  }
}
