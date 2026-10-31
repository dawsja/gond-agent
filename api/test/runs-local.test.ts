import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/db";
import { setSetting } from "../src/db";
import { createAuthentication, seal } from "../src/auth";
import { ApiError } from "../src/wire";
import { saveProviderSettings } from "../src/providers";
import { Runs } from "../src/runs/service";
import type { Config } from "../src/config";
import { gh, checkout, importBundle } from "../src/github";
import { createMcp, createToken } from "../src/mcp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
vi.mock("../src/github", async (original) => {
  const actual = await original<typeof import("../src/github")>();
  return {
    ...actual,
    gh: vi.fn(async (endpoint: string, method: string) =>
      method === "POST"
        ? { number: 42, html_url: "https://github.com/acme/app/pull/42" }
        : endpoint.includes("/pulls?")
          ? []
          : { default_branch: "main" },
    ),
    checkout: vi.fn(async () => ({
      cwd: "/fake",
      archive: Buffer.from("repo"),
    })),
    importBundle: vi.fn(async () => {}),
    git: vi.fn(async (_cwd: string, ...args: string[]) =>
      Buffer.from(
        args[0] === "rev-parse"
          ? "a".repeat(40)
          : args.includes("--numstat")
            ? "2\t1\tsrc/app.ts\n"
            : "diff --git a/src/app.ts b/src/app.ts\n",
      ),
    ),
  };
});
let dir: string,
  db: ReturnType<typeof openStore>,
  runs: Runs,
  log: Record<string, unknown>[],
  events: Record<string, unknown>[],
  destroy: ReturnType<typeof vi.fn<() => Promise<void>>>;
let workerFailure: string | null;
const cfg = (): Config => ({
  data: dir,
  origin: "http://localhost:8787",
  secret: "a".repeat(40),
  signup: true,
  port: 8787,
  dockerBin: "docker",
  workerImage: "gond-agent-worker:test",
  maxRuns: 2,
  runCPUs: 2,
  runMemoryMB: 2048,
  idleMs: 60000,
  turnMs: 60000,
});
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gond-agent-run-"));
  db = openStore(dir);
  await createAuthentication(db, cfg());
  db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run("u", "User", "user@example.test", 0, Date.now(), Date.now());
  saveProviderSettings(db, cfg().secret, {
    connections: [{ id: "local", name: "Local", format: "openai", baseURL: "http://127.0.0.1:8000/v1", apiKey: "test-provider-key", discover: false, models: [{ id: "coder", name: "Coder", contextWindow: 128000, maxOutput: 8192, reasoning: "none", images: true }] }],
    defaultModel: "local:coder",
  });
  log = [];
  events = [];
  workerFailure = null;
  destroy = vi.fn(async () => {});
  runs = new Runs(db, cfg(), async () => ({
    destroy,
    rpc: async (method, args) => {
      log.push({ method, ...args });
      if (method === "send") {
        const input = args?.input as any;
        if (input.type === "interrupt")
          events.push({
            type: "turn.end",
            agent_id: "main",
            stop_reason: "interrupted",
          });
        else if (input.type !== "user") return true as any;
        else if (workerFailure)
          events.push(
            { type: "turn.start", agent_id: "main" },
            { type: "turn.end", agent_id: "main", stop_reason: "error" },
            { type: "error", agent_id: "main", message: workerFailure, retryable: false },
          );
        else
          events.push(
            { type: "turn.start", agent_id: "main" },
            {
              type: "text.delta",
              agent_id: "main",
              text: "Fixed it and tested it.",
            },
            { type: "turn.end", agent_id: "main", stop_reason: "end_turn" },
          );
      }
      if (method === "events") {
        const batch = events.splice(0);
        return { events: batch, alive: true } as any;
      }
      if (method === "snapshot")
        return {
          bundle: Buffer.from("bundle").toString("base64"),
          head: "b".repeat(40),
        } as any;
      return true as any;
    },
  }));
});
afterEach(async () => {
  await runs.shutdown();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});
describe("persistent local run lifecycle", () => {
  it("does not resume a stopped workspace when all slots are occupied", async () => {
    const first=await runs.create("u",{repo:"acme/app",model:"local:coder",prompt:"First"});
    await vi.waitFor(()=>expect(runs.get(first.id).status).toBe("ready"));
    await runs.stop(first.id,"u");
    await runs.close(first.id);
    for(const prompt of ["Second","Third"]){
      const run=await runs.create("u",{repo:"acme/app",model:"local:coder",prompt});
      await vi.waitFor(()=>expect(runs.get(run.id).status).toBe("ready"));
    }
    const before=runs.history(first.id,0).length;
    expect(()=>runs.enqueue(first.id,"u","Continue")).toThrow(/All workspaces are busy/);
    expect(runs.get(first.id).pending).toHaveLength(0);
    expect(runs.history(first.id,0)).toHaveLength(before);
  });
  it("enforces capacity when concurrent starts finish repository lookup together", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = vi.mocked(gh).getMockImplementation()!;
    vi.mocked(gh).mockImplementation(async (...args) => {
      if (args[0] === "repos/acme/app") await gate;
      return original(...args);
    });
    const outcomes = Promise.allSettled(Array.from({ length: 3 }, () => runs.create("u", { repo: "acme/app", model: "local:coder", prompt: "Fix it" })));
    await vi.waitFor(() => expect(vi.mocked(gh).mock.calls.filter(args => args[0] === "repos/acme/app")).toHaveLength(3));
    release();
    const results = await outcomes;
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.code).toBe("run_limit");
    expect(runs.list("u")).toHaveLength(2);
    vi.mocked(gh).mockImplementation(original);
  });
  it("starts through MCP with durable retry results and token attribution", async () => {
    const token=createToken(db,"u","Lifecycle test");
    let mcp=createMcp(db,cfg(),runs);
    const client=new Client({name:"lifecycle",version:"1"});
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg().origin+"/mcp"),{
      requestInit:{headers:{Authorization:`Bearer ${token.token}`}},
      fetch:async(input,init)=>mcp.fetch(new Request(input,init)),
    }));
    const call=async(name:string,args:Record<string,unknown>)=>{
      const result=await client.callTool({name,arguments:args});
      expect(result.isError).not.toBe(true);
      return JSON.parse((result.content as {text:string}[])[0].text);
    };
    try {
      const args={repo:"acme/app",prompt:"Fix it",model:"local:coder",request_id:"first"};
      const started=await call("start_session",args);
      await vi.waitFor(()=>expect(runs.get(started.id,"u").status).toBe("ready"));
      expect(runs.get(started.id,"u").mcp_token_id).toBe(token.id);
      expect(runs.get(started.id,"u").source).toBe("mcp");
      await mcp.close();mcp=createMcp(db,cfg(),runs);
      expect((await call("start_session",args)).id).toBe(started.id);
      expect(db.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({n:1});
      const message={session_id:started.id,text:"Continue",request_id:"followup"};
      await call("send_session_message",message);
      await call("send_session_message",message);
      expect(runs.history(started.id,0).filter(e=>e.type==="user" && e.text==="Continue")).toHaveLength(1);
      await vi.waitFor(()=>expect(runs.get(started.id,"u").status).toBe("ready"));
      expect((await call("open_session_pull_request",{session_id:started.id})).url).toContain("github.com");
      await call("stop_session",{session_id:started.id});
    } finally {await client.close();await mcp.close();}
  });
  it("closes an idle workspace before deleting its account records", async () => {
    const run = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Explain it" });
    await vi.waitFor(() => expect(runs.get(run.id).status).toBe("ready"));
    await runs.withAccountDeletion("u", async prepare => {
      await prepare();
      expect(destroy).toHaveBeenCalledTimes(1);
      db.prepare('DELETE FROM "user" WHERE id=?').run("u");
    });
    expect(db.prepare("SELECT 1 FROM runs WHERE id=?").get(run.id)).toBeUndefined();
    expect(() => runs.get(run.id)).toThrow("doesn't exist");
  });
  it("does not resurrect account data when an in-flight run creation finishes after deletion", async () => {
    let release!: (value: { default_branch: string }) => void;
    const pending = new Promise<{ default_branch: string }>(resolve => { release = resolve; });
    vi.mocked(gh).mockImplementationOnce(async () => await pending as any);
    const creating = runs.create("u", { repo: "acme/app", model: "auto", prompt: "Explain it" });
    await vi.waitFor(() => expect(gh).toHaveBeenCalled());
    await runs.withAccountDeletion("u", async prepare => {
      await prepare();
      db.prepare('DELETE FROM "user" WHERE id=?').run("u");
      release({ default_branch: "main" });
      await expect(creating).rejects.toThrow("being deleted");
    });
    expect(db.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT 1 FROM profiles WHERE user_id='u'").get()).toBeUndefined();
    expect(checkout).not.toHaveBeenCalled();
  });
  it("shows checkout progress before container startup and does not revive a stopped run", async () => {
    let release!: () => void, report!: (step: string) => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(checkout).mockImplementationOnce(async (...args) => {
      report = args[7]!; report("Downloading repository (25%)");
      await pending; report("Packing repository for the workspace");
      return { cwd: "/fake", archive: Buffer.from("repo") };
    });
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Explain it" });
    await vi.waitFor(() => expect(runs.get(r.id).step).toBe("Downloading repository (25%)"));
    expect(log).toEqual([]);
    await runs.stop(r.id, "u");
    report("Downloading repository (50%)");
    expect(runs.get(r.id).status).toBe("stopped");
    release(); await runs.shutdown();
    expect(log).toEqual([]);
    expect(runs.get(r.id).status).toBe("stopped");
  });
  it("shows checkout failures without pretending container startup was reached", async () => {
    vi.mocked(checkout).mockRejectedValueOnce(new ApiError(502, "checkout_failed", "Couldn't download the repository. Check GitHub access and retry."));
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Explain it" });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("failed"));
    expect(runs.get(r.id).error).toContain("Couldn't download the repository");
    expect(log).toEqual([]);
    expect(runs.history(r.id, 0).filter(event => event.type === "run.status").some(event => event.step === "Starting a workspace container")).toBe(false);
  });
  it("does not leave a workspace behind when shutdown races with checkout", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(checkout).mockImplementationOnce(async () => {
      await pending;
      return { cwd: "/fake", archive: Buffer.from("repo") };
    });
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Implement it" });
    const stopped = runs.shutdown();
    release();
    await stopped;
    expect(runs.get(r.id).status).toBe("stopped");
    expect(runs.get(r.id).pending).toEqual([]);
    expect(log.some((x) => x.method === "start")).toBe(false);
  });
  it("does not snapshot, push or open a PR when verification is blocked", async () => {
    workerFailure = "Verification and self-review are incomplete.";
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Implement it" });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("failed"));
    expect(runs.get(r.id).error).toContain("Verification");
    expect(log.some((x) => x.method === "snapshot")).toBe(false);
    expect(importBundle).not.toHaveBeenCalled();
    expect(vi.mocked(gh).mock.calls.some((c) => c[1] === "POST")).toBe(false);
  });
  it("stores tool screenshots with run ownership and broadcasts IDs, not image bytes", async () => {
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Test browser" });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    const data = Buffer.from("jpeg fixture").toString("base64");
    const event = runs.append(r.id, { type: "tool.images", agent_id: "main", call_id: "browser1", images: [
      { media_type: "image/jpeg", data },
      { media_type: "image/svg+xml", data },
      { media_type: "image/jpeg", data: "not base64" },
    ] });
    expect(JSON.stringify(event)).not.toContain(data);
    const images = (event as any).images;
    expect(images).toHaveLength(1);
    const row = db.prepare("SELECT user_id,run_id,bytes FROM images WHERE id=?").get(images[0].id) as any;
    expect(row.user_id).toBe("u");
    expect(row.run_id).toBe(r.id);
    expect(row.bytes.toString()).toBe("jpeg fixture");
    expect(runs.history(r.id, 0).find((e) => e.type === "tool.images").images).toEqual(images);
  });
  it("starts a container, streams, pushes and creates a PR without giving the worker credentials", async () => {
    setSetting(db, "github", { token: seal(cfg().secret, "test-managed-github-token") });
    const r = await runs.create("u", {
      repo: "acme/app",
      model: "auto",
      prompt: "Fix it",
    });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(checkout).toHaveBeenCalled();
    expect(vi.mocked(importBundle).mock.calls[0]?.slice(0, 3)).toEqual([
      "/fake",
      Buffer.from("bundle"),
      r.branch,
    ]);
    expect(runs.get(r.id).pr_number).toBe(42);
    expect(runs.get(r.id).files).toBe(1);
    expect(log.some((x) => x.method === "setup")).toBe(true);
    expect(JSON.stringify(log)).not.toMatch(
      /test-provider-key|test-managed-github-token|gh auth|BETTER_AUTH_SECRET/,
    );
    const replay = runs.history(r.id, 0);
    expect(replay.some((x) => x.type === "text.delta")).toBe(true);
    expect(replay.every((e, i) => !i || e.seq > replay[i - 1].seq)).toBe(true);
    await runs.merge(r.id, "u");
    expect(vi.mocked(gh).mock.calls.every(call => call[3]?.GH_TOKEN === "test-managed-github-token")).toBe(true);
    expect(vi.mocked(checkout).mock.calls[0]?.[6]?.GH_TOKEN === "test-managed-github-token").toBe(true);
    expect(vi.mocked(importBundle).mock.calls[0]?.[3]?.GH_TOKEN === "test-managed-github-token").toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(runs.get(r.id).status).toBe("merged");
  });
  it("attaches images exactly once and supports follow-ups on the same container", async () => {
    db.prepare(
      "INSERT INTO images(id,user_id,media_type,bytes,created_at) VALUES(?,?,?,?,?)",
    ).run("img_1", "u", "image/png", Buffer.from("png"), Date.now());
    const r = await runs.create("u", {
      repo: "acme/app",
      model: "auto",
      prompt: "Look at this",
      images: ["img_1"],
    });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    runs.enqueue(r.id, "u", "Add a test");
    await vi.waitFor(() =>
      expect(log.filter((x) => x.method === "send" && (x.input as {type?:string}|undefined)?.type === "user")).toHaveLength(2),
    );
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(log.filter((x) => x.method === "start")).toHaveLength(1);
    expect(
      (
        db.prepare("SELECT run_id FROM images WHERE id=?").get("img_1") as {
          run_id: string;
        }
      ).run_id,
    ).toBe(r.id);
  });
  it("marks interrupted work recoverable after a host restart and keeps history", async () => {
    const r = await runs.create("u", {
      repo: "acme/app",
      model: "auto",
      prompt: "Fix it",
    });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    await runs.shutdown();
    const row = runs.get(r.id);
    row.status = "working";
    row.phase = "agent";
    runs.save(row);
    await runs.recover();
    expect(runs.get(r.id).status).toBe("failed");
    expect(runs.get(r.id).pushed).toBe(true);
    expect(runs.history(r.id, 0).length).toBeGreaterThan(0);
    await runs.remove(r.id, "u");
    expect(() => runs.get(r.id)).toThrow();
  });
});
