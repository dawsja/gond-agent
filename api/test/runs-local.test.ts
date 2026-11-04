import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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
    commitIdentity: vi.fn(async () => ({name:"fixture",email:"123+fixture@users.noreply.github.com"})),
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
let relay: (req: Request) => Promise<Response>;
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
});
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gond-agent-run-"));
  db = openStore(dir);
  await createAuthentication(db, cfg());
  db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run("u", "User", "user@example.test", 0, Date.now(), Date.now());
  db.prepare("INSERT INTO github_connections(user_id,token,connected_at) VALUES(?,?,?)").run("u", seal(cfg().secret, "test-managed-github-token"), Date.now());
  saveProviderSettings(db, cfg().secret, {
    connections: [{ id: "local", name: "Local", format: "openai", baseURL: "http://127.0.0.1:8000/v1", apiKey: "test-provider-key", discover: false, models: [{ id: "coder", name: "Coder", contextWindow: 128000, maxOutput: 8192, reasoning: "none", images: true }] }],
    defaultModel: "local:coder",
  });
  log = [];
  events = [];
  workerFailure = null;
  destroy = vi.fn(async () => {});
  runs = new Runs(db, cfg(), async (_id, handler) => {
    relay = handler;
    return {
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
    };
  });
});
afterEach(async () => {
  await runs.shutdown();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
describe("persistent local run lifecycle", () => {
  it.each([['runner', false], ['web', true], ['mcp', true], ['unknown', false]] as const)("starts %s runs with interactive=%s", async (source, interactive) => {
    const r = await runs.create("u", {repo:"acme/app", model:"auto", prompt:"Work", source});
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(log.find(call => call.method === "start")).toMatchObject({interactive, question_wait_minutes: 240});
  });
  it("enforces a durable run-wide search cap through the service relay without failing the run", async () => {
    vi.stubEnv("GOND_AGENT_WEB_SEARCH_LIMIT", "2");
    const r = await runs.create("u", {repo:"acme/app", model:"auto", prompt:"Work"});
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    const search = () => relay(new Request("http://worker/v1/search", {method:"POST", body:JSON.stringify({query:"fixture"})}));
    // No provider is configured: attempts still count, without external network calls.
    const stale = runs.get(r.id);
    const responses = await Promise.all([search(), search(), search()]);
    expect(await responses[2].json()).toEqual({error:"web search limit for this run reached"});
    expect(runs.get(r.id).web_search_calls).toBe(2);
    runs.save(stale); // A stale lifecycle snapshot cannot reset the search allowance.
    expect(runs.get(r.id).web_search_calls).toBe(2);
    await runs.closeSession(r.id, "u");
    runs.enqueue(r.id, "u", "Continue");
    await vi.waitFor(() => expect(log.filter(call => call.method === "start")).toHaveLength(2));
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(await (await search()).json()).toEqual({error:"web search limit for this run reached"});
    expect(JSON.parse((db.prepare("SELECT data FROM runs WHERE id=?").get(r.id) as {data:string}).data).web_search_calls).toBe(2);
    vi.stubEnv("GOND_AGENT_WEB_SEARCH_LIMIT", "0");
    expect(await (await search()).json()).not.toEqual({error:"web search limit for this run reached"});
    expect(runs.get(r.id).status).toBe("ready");
  });
  it("retains plans across follow-ups, workspace reopen and service recovery", async () => {
    const r = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Work"});
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    const plan = [{text:"Read",status:"done"}, {text:"Implement",status:"in_progress"}];
    events.push({type:"todos",agent_id:"main",items:plan});
    await vi.waitFor(() => expect(runs.get(r.id).summary.plan_steps).toEqual(plan));
    runs.enqueue(r.id, "u", "Continue");
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(runs.get(r.id).summary).toMatchObject({plan_steps:plan,plan_done:1,plan_total:2});
    await runs.close(r.id);
    await runs.recover();
    runs.enqueue(r.id, "u", "Reopen");
    await vi.waitFor(() => expect(log.filter(x => x.method === "start")).toHaveLength(2));
    expect(log.filter(x => x.method === "start")[1]).toMatchObject({plan});
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(runs.get(r.id).summary.plan_steps).toEqual(plan);
  });

  it("routes a pending question answer to the worker instead of queuing it", async () => {
    const r = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Explain it"});
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    const live = (runs as unknown as {live:Map<string,{busy:boolean}>}).live.get(r.id)!;
    live.busy = true;
    events.push({type:"question",agent_id:"main",request_id:"q1",question:"Which branch?"});
    await vi.waitFor(() => expect(runs.get(r.id).summary.question?.request_id).toBe("q1"));
    runs.enqueue(r.id, "u", "Use main");
    expect(log).toContainEqual({method:"send",input:{type:"question.reply",request_id:"q1",answer:"Use main"}});
    expect(runs.get(r.id).pending).toHaveLength(0);
    expect(runs.get(r.id).summary.question).toBeNull();
  });
  it("stop preserves uncommitted work and follow-ups reuse the workspace", async () => {
    const r = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Explain it"});
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    const path = join(dir, "uncommitted.txt");
    writeFileSync(path, "work in progress");
    destroy.mockImplementation(async () => { rmSync(path, {force:true}); });
    const live = (runs as unknown as {live:Map<string,{busy:boolean}>}).live.get(r.id)!;
    live.busy = true;
    await expect(runs.closeSession(r.id, "u")).rejects.toMatchObject({code:"workspace_busy"});
    await runs.stop(r.id, "u");
    await vi.waitFor(() => expect(live.busy).toBe(false));
    expect(destroy).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe("work in progress");
    const clones = vi.mocked(checkout).mock.calls.length;
    runs.enqueue(r.id, "u", "Continue");
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(checkout).toHaveBeenCalledTimes(clones);
    expect(readFileSync(path, "utf8")).toBe("work in progress");
  });
  it("safe close pushes before releasing capacity and preserves history", async () => {
    const first = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"First"});
    const second = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Second"});
    await vi.waitFor(() => expect(runs.get(second.id).status).toBe("ready"));
    await vi.waitFor(() => expect(runs.get(first.id).status).toBe("ready"));
    const third = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Third"});
    expect(third).toMatchObject({status:"queued",queue_position:1,queue_length:1});
    const history = runs.history(first.id, 0);
    vi.mocked(importBundle).mockRejectedValueOnce(new Error("push failed"));
    await expect(runs.closeSession(first.id, "u")).rejects.toThrow("push failed");
    expect(destroy).not.toHaveBeenCalled();
    await runs.closeSession(first.id, "u");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(runs.history(first.id, 0).slice(0, history.length)).toEqual(history);
    expect(runs.get(first.id).diff).toContain("src/app.ts");
    expect(runs.get(first.id).pushed).toBe(true);
    await vi.waitFor(() => expect(runs.get(third.id).status).toBe("ready"));
    await runs.closeSession(third.id, "u");
    runs.enqueue(first.id, "u", "Resume");
    await vi.waitFor(() => expect(runs.get(first.id).status).toBe("ready"));
    expect(vi.mocked(checkout).mock.calls.at(-1)?.[5]).toBe(true);
  });
  it("keeps an idle workspace across elapsed time until explicitly closed", async () => {
    const r = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Explain it"});
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 30 * 86400_000);
    try {
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(runs.get(r.id).status).toBe("ready");
      expect(destroy).not.toHaveBeenCalled();
      await runs.stop(r.id, "u");
      expect(destroy).not.toHaveBeenCalled();
      await runs.closeSession(r.id, "u");
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });
  it("queues a stopped closed workspace when all slots are occupied", async () => {
    const first=await runs.create("u",{repo:"acme/app",model:"local:coder",prompt:"First"});
    await vi.waitFor(()=>expect(runs.get(first.id).status).toBe("ready"));
    await runs.stop(first.id,"u");
    await runs.close(first.id);
    for(const prompt of ["Second","Third"]){
      const run=await runs.create("u",{repo:"acme/app",model:"local:coder",prompt});
      await vi.waitFor(()=>expect(runs.get(run.id).status).toBe("ready"));
    }
    const before=runs.history(first.id,0).length;
    runs.enqueue(first.id,"u","Continue");
    expect(runs.get(first.id)).toMatchObject({status:"queued",queue_position:1,queue_length:1});
    expect(runs.get(first.id).pending).toHaveLength(1);
    expect(runs.history(first.id,0).slice(before).map(event => event.type)).toEqual(["user","run.queued"]);
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
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(3);
    expect(runs.list("u")).toHaveLength(3);
    expect(runs.list("u").filter(run => run.status === "queued")).toEqual([expect.objectContaining({queue_position:1,queue_length:1})]);
    expect(checkout).toHaveBeenCalledTimes(2);
    vi.mocked(gh).mockImplementation(original);
  });
  it("answers a worker question through MCP and continues the session", async () => {
    const r = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Explain it"});
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    const live = (runs as unknown as {live:Map<string,{busy:boolean}>}).live.get(r.id)!;
    live.busy = true;
    const current = runs.get(r.id); current.status = "working";
    db.prepare("UPDATE runs SET status='working',data=? WHERE id=?").run(JSON.stringify(current), r.id);
    events.push({type:"turn.start",agent_id:"main"},{type:"question",agent_id:"main",request_id:"q-mcp",question:"Which branch?"});
    await vi.waitFor(() => expect(runs.get(r.id).summary.question?.request_id).toBe("q-mcp"));
    const token = createToken(db,"u","Question test"), mcp = createMcp(db,cfg(),runs);
    const client = new Client({name:"question",version:"1"});
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg().origin+"/mcp"), {
      requestInit:{headers:{Authorization:`Bearer ${token.token}`}},
      fetch:async(input,init)=>mcp.fetch(new Request(input,init)),
    }));
    const call = async(name:string,args:Record<string,unknown>) => {
      const result = await client.callTool({name,arguments:args});
      expect(result.isError).not.toBe(true);
      return JSON.parse((result.content as {text:string}[])[0].text);
    };
    try {
      expect(await call("get_session",{session_id:r.id})).toMatchObject({state:"waiting_for_input",done:false,question:"Which branch?"});
      events.push({type:"question.resolved",agent_id:"main",request_id:"q-mcp"});
      await vi.waitFor(() => expect(runs.get(r.id).summary.question).toBeNull());
      expect(await call("get_session",{session_id:r.id})).toMatchObject({state:"working",waiting_for_input:false});
      events.push({type:"question",agent_id:"main",request_id:"q-mcp",question:"Which branch?"});
      await vi.waitFor(() => expect(runs.get(r.id).summary.question?.request_id).toBe("q-mcp"));
      await call("send_session_message",{session_id:r.id,request_id:"answer",text:"Use main"});
      expect(log).toContainEqual({method:"send",input:{type:"question.reply",request_id:"q-mcp",answer:"Use main"}});
      events.push({type:"text.delta",agent_id:"main",text:"Continued after answer"},{type:"turn.end",agent_id:"main",stop_reason:"end_turn"});
      await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
      expect(await call("get_session",{session_id:r.id})).toMatchObject({state:"done",waiting_for_input:false});
    } finally { await client.close(); await mcp.close(); }
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
      expect((await call("close_session",{session_id:started.id})).closed).toBe(true);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect((await call("get_session",{session_id:started.id})).id).toBe(started.id);
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
  it("does not snapshot, push or open a PR when the model fails", async () => {
    workerFailure = "The model connection failed.";
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Implement it" });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("failed"));
    expect(runs.get(r.id).error).toBe("The model connection failed.");
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
  it("refreshes externally merged PRs once, preserves concurrent run updates and blocks follow-ups", async () => {
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Fix it" });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    let resolve!: (value: unknown) => void;
    vi.mocked(gh).mockImplementationOnce(() => new Promise(done => { resolve = done; }) as never);
    const a = runs.refreshPulls("u", r.id), b = runs.refreshPulls("u");
    const latest = runs.get(r.id); latest.title = "Updated title"; runs.save(latest);
    resolve({ data: { p0: { pullRequest: { state: "MERGED" } } } });
    await Promise.all([a, b]);
    expect(runs.get(r.id)).toMatchObject({ status: "merged", pr_state: "merged", title: "Updated title" });
    expect(vi.mocked(gh).mock.calls.filter(c => c[0] === "graphql")).toHaveLength(1);
    expect(vi.mocked(gh).mock.calls.find(c => c[0] === "graphql")?.[3]?.GH_TOKEN).toBe("test-managed-github-token");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(runs.history(r.id, 0).filter(e => e.type === "run.pr" && e.state === "merged")).toHaveLength(1);
    expect(() => runs.enqueue(r.id, "u", "Continue")).toThrow(/new run after merging/);
    await runs.refreshPulls("u", r.id);
    expect(vi.mocked(gh).mock.calls.filter(c => c[0] === "graphql")).toHaveLength(1);
    db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run("other", "Other", "other@example.test", 0, Date.now(), Date.now());
    await expect(runs.refreshPulls("other", r.id)).rejects.toThrow(/doesn't exist/);
    expect(vi.mocked(gh).mock.calls.filter(c => c[0] === "graphql")).toHaveLength(1);
  });
  it("records an external merge during a turn without interrupting its export", async () => {
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Fix it" });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    let release!: () => void;
    vi.mocked(importBundle).mockImplementationOnce(() => new Promise<void>(done => { release = done; }));
    runs.enqueue(r.id, "u", "Finish the changes");
    await vi.waitFor(() => expect(importBundle).toHaveBeenCalledTimes(2));
    vi.mocked(gh).mockResolvedValueOnce({ data: { p0: { pullRequest: { state: "MERGED" } } } });
    try {
      await runs.refreshPulls("u", r.id);
      expect(runs.get(r.id)).toMatchObject({ status: "working", pr_state: "merged" });
      expect(destroy).not.toHaveBeenCalled();
      expect(() => runs.enqueue(r.id, "u", "Another change")).toThrow(/new run after merging/);
    } finally { release(); }
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("merged"));
    expect(destroy).toHaveBeenCalledTimes(1);
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
