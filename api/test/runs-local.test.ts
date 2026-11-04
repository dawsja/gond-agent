import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/db";
import { setSetting } from "../src/db";
import { createAuthentication, seal } from "../src/auth";
import { ApiError } from "../src/wire";
import { saveProviderSettings } from "../src/providers";
import { Runs } from "../src/runs/service";
import type { Config } from "../src/config";
import { gh, git, checkout, importBundle, pushBranch } from "../src/github";
import { RetryError } from "../src/retry";
import { command } from "../src/command";
import * as publication from "../src/runs/publication";
import { evidenceSigningKey, evidenceState, signedRecord, unverifiedDescription as emptyUnverifiedDescription } from "./fixtures/evidence";
import { createMcp, createToken, sessionState } from "../src/mcp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const unverifiedDescription = (body: string) => emptyUnverifiedDescription(body)
  .replace("review status unavailable.", "Separate-container review backend unavailable.")
  .replace("```text\nNo fresh successful check", "```text\nVerification policy status unavailable.\nNo fresh successful check");
vi.mock("../src/github", async (original) => {
  const actual = await original<typeof import("../src/github")>();
  return {
    ...actual,
    gh: vi.fn(async (endpoint: string, method: string) =>
      method === "POST"
        ? { number: 42, html_url: "https://github.com/acme/app/pull/42" }
        : endpoint.includes("/pulls?") || endpoint.includes("/git/matching-refs/")
          ? []
          : { default_branch: "main" },
    ),
    commitIdentity: vi.fn(async () => ({name:"fixture",email:"123+fixture@users.noreply.github.com"})),
    checkout: vi.fn(async () => ({
      cwd: "/fake",
      archive: Buffer.from("repo"),
    })),
    importBundle: vi.fn(async () => {}),
    pushBranch: vi.fn(async () => {}),
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
type WorkerTurn = Record<string, unknown>[] | ((runId: string, key: Buffer) => Record<string, unknown>[]);
let workerTurns: WorkerTurn[];
let workerEvidenceReply: unknown;
let workerInitialize: () => Promise<void>;
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
  // This suite covers retained live workspaces; enabled CI release/reopen is in ci-service.test.ts.
  vi.stubEnv("GOND_AGENT_CI_FIX_ROUNDS", "0");
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
  workerTurns = [];
  workerEvidenceReply = true;
  workerInitialize = async () => {};
  destroy = vi.fn(async () => {});
  runs = new Runs(db, cfg(), async (_id, handler) => {
    relay = handler;
    let serviceKey: Buffer;
    return {
      destroy,
      rpc: async (method, args) => {
        log.push({ method, ...args });
        if (method === "init_evidence") {
          serviceKey = Buffer.from(args?.key as string, "hex");
          await workerInitialize();
        }
        if (method === "send") {
          const input = args?.input as any;
          if (input.type === "interrupt")
            events.push({
              type: "turn.end",
              agent_id: "main",
              stop_reason: "interrupted",
            });
          else if (input.type !== "user") return true as any;
          else if (workerTurns.length) {
            const turn = workerTurns.shift()!;
            events.push(...(typeof turn === "function" ? turn(_id, serviceKey) : turn));
          }
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
        if (method === "export_state") {
          // A conforming worker exports the service-installed key. Deliberate
          // changed-key and legacy replies stay untouched.
          const reply = workerEvidenceReply as ReturnType<typeof evidenceState>;
          if (reply?.state?.evidence?.key === evidenceSigningKey.toString("hex")) {
            return { state: { evidence: { ...reply.state.evidence, key: serviceKey.toString("hex") } } } as any;
          }
          return workerEvidenceReply as any;
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
  it("installs a service key before work, authenticates events across follow-ups and derives freshness on the service", async () => {
    workerEvidenceReply = evidenceState("f".repeat(64)); // Initial export cannot choose the service key.
    let record!: ReturnType<typeof signedRecord>;
    let key!: Buffer;
    workerTurns.push((runId, serviceKey) => {
      workerEvidenceReply = evidenceState(); // Finish metadata reports the installed key.
      key = serviceKey;
      record = signedRecord({ run_id: runId }, key);
      return [
        { type: "evidence.recorded", record },
        { type: "evidence.recorded", record }, // replay
        { type: "evidence.recorded", record: { ...record, command: "forged" } },
        { type: "evidence.recorded", record: signedRecord({ run_id: runId, seq: 3 }, key), extra: "not allowed" },
        { type: "turn.end", agent_id: "main", stop_reason: "end_turn" },
      ];
    });
    const guardedImport = async (cwd: string, _bundle: Buffer, branch: string, _env?: NodeJS.ProcessEnv, _retry?: unknown, options?: import("../src/github").PushOptions) => {
      await options?.beforePush?.({ cwd, branch, head: "b".repeat(40) });
    };
    vi.mocked(importBundle).mockImplementationOnce(guardedImport);
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Work" });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    const initIndex = log.findIndex(call => call.method === "init_evidence");
    expect(initIndex).toBeGreaterThan(log.findIndex(call => call.method === "start"));
    expect(initIndex).toBeLessThan(log.findIndex(call => call.method === "export_state"));
    expect(log[initIndex]).toEqual({ method: "init_evidence", run_id: r.id, owner_id: "u", key: key.toString("hex") });
    expect(key).toHaveLength(32);
    expect(log.findIndex(call => call.method === "export_state")).toBeLessThan(log.findIndex(call => call.method === "send"));
    expect(log.filter(call => call.method === "export_state")).toEqual([
      { method: "export_state", run_id: r.id, owner_id: "u" }, { method: "export_state", run_id: r.id, owner_id: "u" },
    ]);
    expect(runs.get(r.id).evidence).toMatchObject({ records: [record], last_seq: 1, publication_tree: "a".repeat(40), policy: { enabled: true } });
    expect(publication.descriptionFor(runs.get(r.id))).toContain("1 fresh successful check(s)");
    expect(git).toHaveBeenCalledWith("/fake", "rev-parse", `${"b".repeat(40)}^{tree}`);
    const stored = db.prepare("SELECT data FROM runs WHERE id=?").get(r.id) as { data: string };
    expect(stored.data).not.toContain(key.toString("hex"));
    expect(JSON.stringify(runs.history(r.id, 0))).not.toContain(key.toString("hex"));
    // Child/stdout-shaped forgeries and even valid MACs for another run are dropped.
    runs.append(r.id, { type: "state.evidence_initialized", key: key.toString("hex") });
    runs.append(r.id, { type: "evidence.recorded", record: signedRecord({ run_id: r.id, seq: 2, id: "00000000-0000-4000-8000-000000000002" }, Buffer.alloc(32, 255)) });
    runs.append(r.id, { type: "evidence.recorded", record: signedRecord({ run_id: "other-run", seq: 2, id: "00000000-0000-4000-8000-000000000003" }, key) });
    expect(runs.get(r.id).evidence?.last_seq).toBe(1);
    expect(JSON.stringify(runs.history(r.id, 0))).not.toContain(key.toString("hex"));
    expect(runs.history(r.id, 0).filter(e => e.type === "evidence.recorded")).toHaveLength(1);
    const stale = runs.get(r.id);
    // Finish-time key rotation cannot authorize a new signature, nor replace the original key.
    workerEvidenceReply = evidenceState("f".repeat(64));
    const next = signedRecord({ run_id: r.id, seq: 2, id: "00000000-0000-4000-8000-000000000002", tree_hash_after: "c".repeat(40) }, key);
    workerTurns.push([
      { type: "evidence.recorded", record: next },
      { type: "evidence.recorded", record: signedRecord({ run_id: r.id, seq: 3, id: "00000000-0000-4000-8000-000000000003" }, Buffer.alloc(32, 255)) },
      { type: "turn.end", agent_id: "main", stop_reason: "end_turn" },
    ]);
    vi.mocked(importBundle).mockImplementationOnce(guardedImport);
    runs.enqueue(r.id, "u", "Continue");
    await vi.waitFor(() => expect(runs.get(r.id).evidence?.last_seq).toBe(2));
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(runs.get(r.id).evidence?.policy).toBeUndefined();
    expect(publication.descriptionFor(runs.get(r.id))).toContain("Not verified.");
    runs.save(stale);
    expect(runs.get(r.id).evidence?.last_seq).toBe(2);
    expect(runs.get(r.id).evidence?.ids).toHaveLength(2);
  });
  it("waits for private initialization and generates a different service key for a reopened worker", async () => {
    let initialized!: () => void;
    workerInitialize = () => new Promise(resolve => { initialized = resolve; });
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Work" });
    await vi.waitFor(() => expect(log.some(call => call.method === "init_evidence")).toBe(true));
    expect(log.some(call => call.method === "send" || call.method === "export_state")).toBe(false);
    const firstKey = log.find(call => call.method === "init_evidence")!.key;
    expect(JSON.stringify(log.filter(call => call.method !== "init_evidence"))).not.toContain(firstKey);
    expect(JSON.stringify(runs.get(r.id))).not.toContain(firstKey);
    initialized();
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    await runs.closeSession(r.id, "u");
    workerInitialize = async () => {};
    runs.enqueue(r.id, "u", "Reopen");
    await vi.waitFor(() => expect(log.filter(call => call.method === "init_evidence")).toHaveLength(2));
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    const secondKey = log.filter(call => call.method === "init_evidence")[1].key;
    expect(secondKey).toMatch(/^[a-f0-9]{64}$/);
    expect(secondKey).not.toBe(firstKey);
    expect(JSON.stringify(runs.get(r.id))).not.toContain(secondKey);
    expect(JSON.stringify(runs.history(r.id, 0))).not.toContain(secondKey);
  });
  it("never delivers a task if private evidence initialization fails", async () => {
    workerInitialize = async () => { throw new Error("Initialization failed"); };
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Work" });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("failed"));
    expect(log.some(call => call.method === "send")).toBe(false);
    expect(destroy).toHaveBeenCalled();
    expect(JSON.stringify(runs.history(r.id, 0))).not.toContain(log.find(call => call.method === "init_evidence")!.key);
  });
  it.each([false, true])("preserves run-wide evidence budgets through reopen and stale saves (records=%s)", async withRecord => {
    const reply = evidenceState();
    reply.state.evidence.gate_rounds = 6;
    workerEvidenceReply = reply;
    workerTurns.push((runId, key) => [
      ...(withRecord ? [{ type: "evidence.recorded", record: signedRecord({ run_id: runId, seq: 8 }, key) }] : []),
      { type: "turn.end", agent_id: "main", stop_reason: "end_turn" },
    ]);
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Work" });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(log.find(call => call.method === "start")).toMatchObject({ evidence_seq: 0, evidence_gate_rounds: 0, evidence_resumes: 0 });
    expect(runs.get(r.id).evidence).toMatchObject({ gate_rounds: 6, resumes: 0, last_seq: withRecord ? 8 : 0 });
    const stale = runs.get(r.id);
    await runs.closeSession(r.id, "u");
    // A fresh worker's lower counters cannot reset the durable global budget.
    workerEvidenceReply = evidenceState();
    runs.enqueue(r.id, "u", "Reopen");
    await vi.waitFor(() => expect(log.filter(call => call.method === "start")).toHaveLength(2));
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(log.filter(call => call.method === "start")[1]).toMatchObject({ evidence_seq: withRecord ? 8 : 0, evidence_gate_rounds: 6, evidence_resumes: 1 });
    runs.save(stale);
    expect(runs.get(r.id).evidence).toMatchObject({ gate_rounds: 6, resumes: 1 });
    await runs.closeSession(r.id, "u");
    workerEvidenceReply = true; // No private finish metadata must not reset budgets either.
    runs.enqueue(r.id, "u", "Reopen again");
    await vi.waitFor(() => expect(log.filter(call => call.method === "start")).toHaveLength(3));
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(log.filter(call => call.method === "start")[2]).toMatchObject({ evidence_gate_rounds: 6, evidence_resumes: 2 });
    expect(runs.get(r.id).evidence).toMatchObject({ gate_rounds: 6, resumes: 2 });
  });
  it("charges a crash-safe gate reservation before work even when no finish metadata exists", async () => {
    // No turn.end means there is no safe finish-state export at all.
    workerTurns.push([{ type: "error", agent_id: "main", message: "The worker connection failed.", retryable: false }]);
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Work" });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("failed"));
    expect(runs.get(r.id).evidence).toMatchObject({ gate_budget: 2, records: [] });
    expect(log.filter(call => call.method === "export_state")).toHaveLength(1);
    await runs.closeSession(r.id, "u");
    workerFailure = null;
    runs.enqueue(r.id, "u", "Reopen after failure");
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(log.filter(call => call.method === "start")[1]).toMatchObject({ evidence_gate_rounds: 2 });
    // Recovery replays the failed active task before the queued follow-up; each
    // delivered task reserves two rounds, even without private finish metadata.
    const users = log.filter(call => call.method === "send").map(call => call.input as { type: string; text?: string }).filter(input => input.type === "user");
    expect(users.map(input => input.text)).toEqual(["Work", "Work", "Reopen after failure"]);
    expect(runs.get(r.id).evidence).toMatchObject({ gate_budget: 6 });
  });
  it("never adopts exported keys or unsolicited state frames even without initial policy metadata", async () => {
    workerTurns.push(runId => [{ type: "evidence.recorded", record: signedRecord({ run_id: runId }) }, { type: "turn.end", agent_id: "main", stop_reason: "end_turn" }]);
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Work" });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    workerEvidenceReply = evidenceState();
    workerTurns.push([
      { type: "state.exported", ...evidenceState() }, { type: "evidence.recorded", record: signedRecord({ run_id: r.id }) },
      { type: "turn.end", agent_id: "main", stop_reason: "end_turn" },
    ]);
    runs.enqueue(r.id, "u", "Continue");
    await vi.waitFor(() => expect(log.filter(call => call.method === "export_state")).toHaveLength(3));
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(runs.get(r.id).evidence?.records).toEqual([]);
    expect(runs.history(r.id, 0).some(e => e.type === "evidence.recorded" || e.type === "state.exported")).toBe(false);
    expect(publication.descriptionFor(runs.get(r.id))).toContain("Not verified.");
    expect(JSON.stringify(runs.get(r.id))).not.toContain(evidenceSigningKey.toString("hex"));
  });
  it("does not publish if Stop arrives during the private finish-state export", async () => {
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Work" });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    const snapshots = log.filter(call => call.method === "snapshot").length;
    let release!: (reply: unknown) => void;
    workerEvidenceReply = new Promise(resolve => { release = resolve; });
    runs.enqueue(r.id, "u", "Continue");
    await vi.waitFor(() => expect(log.filter(call => call.method === "export_state")).toHaveLength(3));
    await runs.stop(r.id, "u");
    release(true);
    await vi.waitFor(() => expect((runs as any).live.get(r.id).busy).toBe(false));
    expect(runs.get(r.id).status).toBe("stopped");
    expect(log.filter(call => call.method === "snapshot")).toHaveLength(snapshots);
  });
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
    expect(runs.get(r.id)).toMatchObject({step:"clone", last_error:{step:"clone", attempts:1}, work_kept:false});
    expect(runs.get(r.id).error).toContain("Cloning the repository failed");
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
    expect(runs.get(r.id)).toMatchObject({step:"model", phase:"idle", work_kept:true});
    expect(runs.get(r.id).error).toContain("The model connection failed after 1 attempt");
    expect(log.some((x) => x.method === "snapshot")).toBe(false);
    expect(importBundle).not.toHaveBeenCalled();
    expect(vi.mocked(gh).mock.calls.some((c) => c[1] === "POST")).toBe(false);
  });
  it("keeps a failed publication and pushes the kept commit before sending a follow-up", async () => {
    const captured = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(importBundle).mockRejectedValueOnce(new RetryError("push", {class:"server",retryable:true,reason:"GitHub returned 500"}, 5));
      const r = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Keep this work"});
      await vi.waitFor(() => expect(runs.get(r.id).status).toBe("failed"));
      expect(runs.get(r.id)).toMatchObject({phase:"idle",work_kept:true,last_error:{step:"push",class:"server",attempts:5}});
      expect(runs.get(r.id).error).toBe("Pushing the branch failed after 5 attempts (GitHub returned 500). Your changes are kept; send a follow-up to try again.");
      expect(sessionState(runs.get(r.id))).toMatchObject({state:"failed",done:true,work_kept:true,last_error_details:{step:"push",class:"server",attempts:5},last_error:expect.stringContaining("Pushing the branch")});
      expect(runs.get(r.id).diff).toContain("src/app.ts");
      expect(runs.history(r.id,0)).toContainEqual(expect.objectContaining({type:"run.error",step:"push",class:"server",attempts:5}));
      expect(destroy).not.toHaveBeenCalled();
      const snapshots = log.filter(x => x.method === "snapshot").length;
      let release!: () => void;
      vi.mocked(pushBranch).mockImplementationOnce(() => new Promise<void>(done => {release=done;}));
      runs.enqueue(r.id,"u","Continue");
      await vi.waitFor(() => expect(pushBranch).toHaveBeenCalledTimes(1));
      expect(log.filter(x => x.method === "snapshot")).toHaveLength(snapshots);
      expect(log.filter(x => x.method === "send" && (x.input as any)?.type === "user")).toHaveLength(1);
      release();
      await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
      expect(checkout).toHaveBeenCalledTimes(1);
      expect(runs.get(r.id).head_sha).toBe("b".repeat(40));
      expect(runs.get(r.id).work_kept).toBe(false);
      expect(destroy).not.toHaveBeenCalled();
      expect(JSON.stringify(captured.mock.calls)).not.toMatch(/test-managed-github-token|https:\/\//);
    } finally { captured.mockRestore(); }
  });
  it.each(["retained", "capacity-reclaimed"] as const)("preserves first-publication options on a %s retry without a stale branch preflight", async path => {
    const branch = "fix/ambiguous-publication", endpoint = `repos/acme/app/git/matching-refs/heads/${branch}`;
    const original = vi.mocked(gh).getMockImplementation()!;
    let remoteExists = false;
    vi.mocked(gh).mockImplementation(async (...args) => {
      if (args[0] === endpoint) return (remoteExists ? [{ ref: `refs/heads/${branch}` }] : []) as never;
      return original(...args);
    });
    const captured = vi.spyOn(console, "error").mockImplementation(() => {});
    let release: (() => void) | undefined;
    try {
      // Import succeeded locally; publication may also have succeeded before its response was lost.
      vi.mocked(importBundle).mockRejectedValueOnce(new RetryError("push", {class:"network",retryable:true,reason:"Connection reset"}, 5));
      const r = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Publish this",branch});
      await vi.waitFor(() => expect(runs.get(r.id).status).toBe("failed"));
      // An imported candidate is not a confirmed remote head; retry metadata
      // retains its SHA until publication succeeds (including reconciliation).
      expect(runs.get(r.id)).toMatchObject({explicit_branch:true,pushed:false,work_kept:true,head_sha:null});
      expect(vi.mocked(importBundle).mock.calls[0]?.slice(2)).toEqual([
        branch, expect.objectContaining({GH_TOKEN:"test-managed-github-token"}), undefined,
        {lease:"create-only",beforePush:expect.any(Function)},
      ]);
      const preflights = () => vi.mocked(gh).mock.calls.filter(call => call[0] === endpoint);
      expect(preflights()).toHaveLength(2); // Creation and the fresh snapshot only.
      remoteExists = true; // A repeated availability check would incorrectly block reconciliation.

      if (path === "capacity-reclaimed") {
        const healthy = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Healthy"});
        await vi.waitFor(() => expect(runs.get(healthy.id).status).toBe("ready"));
        const replacement = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Reclaim failed workspace"});
        await vi.waitFor(() => expect(runs.get(replacement.id).status).toBe("ready"));
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(runs.get(r.id)).toMatchObject({work_kept:false,kept_commit:"b".repeat(40),pushed:false});
        await runs.close(replacement.id); // Leave room to boot the reclaimed run.
      }
      const clones = vi.mocked(checkout).mock.calls.length;
      const snapshots = log.filter(call => call.method === "snapshot").length;
      const sends = log.filter(call => call.method === "send" && (call.input as any)?.type === "user").length;
      vi.mocked(pushBranch).mockImplementationOnce(() => new Promise<void>(done => { release = done; }));
      runs.enqueue(r.id, "u", "Reconcile and continue");
      await vi.waitFor(() => expect(pushBranch).toHaveBeenCalledTimes(1));
      expect(vi.mocked(pushBranch).mock.calls[0]).toEqual([
        path === "retained" ? "/fake" : join(dir, "checkouts", r.id), branch,
        expect.objectContaining({GH_TOKEN:"test-managed-github-token"}), undefined,
        {lease:"create-only",beforePush:expect.any(Function)},
      ]);
      expect(preflights()).toHaveLength(2);
      expect(checkout).toHaveBeenCalledTimes(clones);
      expect(log.filter(call => call.method === "snapshot")).toHaveLength(snapshots);
      expect(log.filter(call => call.method === "send" && (call.input as any)?.type === "user")).toHaveLength(sends);
      release!(); release = undefined;
      await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
      expect(runs.get(r.id)).toMatchObject({pushed:true,work_kept:false,head_sha:"b".repeat(40)});
      expect(runs.get(r.id).kept_commit).toBeUndefined();
      expect(preflights()).toHaveLength(2);
      expect(checkout).toHaveBeenCalledTimes(clones + (path === "retained" ? 0 : 1));
      if (path === "capacity-reclaimed") expect(vi.mocked(checkout).mock.calls.at(-1)?.[5]).toBe(true);
      const imports = vi.mocked(importBundle).mock.calls.filter(call => call[2] === branch);
      expect(imports).toHaveLength(2); // No re-import of the kept commit; only the completed follow-up.
      expect(imports[1]?.slice(4)).toEqual([undefined, {lease:undefined,beforePush:expect.any(Function)}]);
    } finally {
      release?.();
      vi.mocked(gh).mockImplementation(original);
      captured.mockRestore();
    }
  });
  it("keeps boot publication create-only and pushed false when someone else creates the explicit branch", async () => {
    const captured = vi.spyOn(console, "error").mockImplementation(() => {});
    const optionsFor = publication.publicationPushOptions;
    let optionsSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      vi.mocked(importBundle).mockRejectedValueOnce(new RetryError("push", {class:"network",retryable:true,reason:"Connection reset"}, 5));
      const branch = "fix/kept-commit-race", ref = `refs/heads/${branch}`;
      const r = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Keep my unpublished work",branch});
      await vi.waitFor(() => expect(runs.get(r.id).status).toBe("failed"));
      await runs.close(r.id, true); // Reclaim the worker, retaining its imported commit for boot().
      expect(runs.get(r.id)).toMatchObject({explicit_branch:true,pushed:false,kept_commit:"b".repeat(40),work_kept:false});

      // Replace the mocked imported commit with a real API clone and local bare remote.
      const cwd = join(dir, "checkouts", r.id), remote = join(dir, "remote.git");
      mkdirSync(cwd, {recursive:true});
      mkdirSync(remote);
      const git = async (folder: string, ...args: string[]) => (await command("git", args, {cwd:folder})).toString().trim();
      await git(remote, "init", "--bare", "-b", "main");
      await git(cwd, "init", "-b", branch);
      await git(cwd, "config", "user.name", "Fixture");
      await git(cwd, "config", "user.email", "fixture@example.test");
      writeFileSync(join(cwd, "work.txt"), "base\n");
      await git(cwd, "add", ".");
      await git(cwd, "commit", "-m", "base");
      const base = await git(cwd, "rev-parse", "HEAD");
      await git(cwd, "remote", "add", "origin", remote);
      await git(cwd, "push", "origin", "HEAD:refs/heads/main");
      writeFileSync(join(cwd, "work.txt"), "kept work\n");
      await git(cwd, "commit", "-am", "kept work");
      const head = await git(cwd, "rev-parse", "HEAD");
      runs.save({...runs.get(r.id),kept_commit:head,head_sha:head});
      // Someone else creates an ancestor ref after reclamation; a plain push would fast-forward it.
      await git(remote, "update-ref", ref, base);
      await git(cwd, "merge-base", "--is-ancestor", base, head);

      const guard = vi.fn(async (context: {cwd:string;branch:string;head:string}) => {
        expect(context).toEqual({cwd,branch,head});
        expect(runs.get(r.id).pushed).toBe(false);
      });
      optionsSpy = vi.spyOn(publication, "publicationPushOptions").mockImplementation(run => optionsFor(run, guard));
      const actual = await vi.importActual<typeof import("../src/github")>("../src/github");
      const clones = vi.mocked(checkout).mock.calls.length, activity = log.length;
      for (let attempt = 1; attempt <= 2; attempt++) {
        vi.mocked(pushBranch).mockImplementationOnce(async (...args) => {
          expect(args).toEqual([cwd,branch,expect.objectContaining({GH_TOKEN:"test-managed-github-token"}),undefined,{lease:"create-only",beforePush:guard}]);
          expect(runs.get(r.id)).toMatchObject({pushed:false,kept_commit:head});
          await actual.pushBranch(...args); // Real Git must reject instead of fast-forwarding the competing ref.
        });
        runs.enqueue(r.id, "u", "Retry the kept publication");
        await vi.waitFor(() => expect(pushBranch).toHaveBeenCalledTimes(attempt));
        await vi.waitFor(() => expect(runs.get(r.id).status).toBe("failed"));
        expect(runs.get(r.id)).toMatchObject({pushed:false,kept_commit:head,work_kept:false,last_error:{step:"push",class:"rejected",attempts:1}});
        const stored = JSON.parse((db.prepare("SELECT data FROM runs WHERE id=?").get(r.id) as {data:string}).data);
        expect(stored).toMatchObject({pushed:false,kept_commit:head});
        expect(await git(remote, "rev-parse", ref)).toBe(base);
        expect(await git(cwd, "rev-parse", "HEAD")).toBe(head);
      }
      expect(guard).toHaveBeenCalledTimes(2);
      expect(optionsSpy).toHaveBeenCalledTimes(2);
      expect(checkout).toHaveBeenCalledTimes(clones);
      expect(log).toHaveLength(activity); // No replacement worker or follow-up work starts after rejection.
    } finally {
      optionsSpy?.mockRestore();
      captured.mockRestore();
    }
  });
  it("reclaims the oldest kept failure at capacity and still releases failures on stop", async () => {
    workerFailure = "The model connection dropped 3 times";
    const first = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"First"});
    const second = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Second"});
    await vi.waitFor(() => expect(runs.get(first.id).status).toBe("failed"));
    await vi.waitFor(() => expect(runs.get(second.id).status).toBe("failed"));
    const third = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Third"});
    await vi.waitFor(() => expect(runs.get(third.id).status).toBe("failed"));
    expect(runs.get(first.id).work_kept).toBe(false);
    expect(runs.get(second.id).work_kept).toBe(true);
    await runs.stop(first.id,"u");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(runs.get(first.id).work_kept).toBe(false);
    await runs.closeSession(second.id,"u");
    expect(destroy).toHaveBeenCalledTimes(2);
  });
  it("does not reclaim failed work for invalid create or follow-up requests", async () => {
    const closed = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Closed"});
    await vi.waitFor(() => expect(runs.get(closed.id).status).toBe("ready"));
    await runs.close(closed.id);
    destroy.mockClear();
    workerFailure = "The model connection dropped 3 times";
    const first = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"First"});
    await vi.waitFor(() => expect(runs.get(first.id).status).toBe("failed"));
    const second = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Second"});
    await vi.waitFor(() => expect(runs.get(second.id).status).toBe("failed"));
    await expect(runs.create("u", {repo:"acme/app",model:"auto",prompt:"Invalid",images:["missing"]})).rejects.toMatchObject({code:"image_not_found"});
    await expect(runs.create("u", {repo:"acme/app",model:"auto",prompt:"Invalid",base_branch:".."})).rejects.toMatchObject({code:"invalid_branch"});
    vi.mocked(gh).mockRejectedValueOnce(new Error("Repository unavailable"));
    await expect(runs.create("u", {repo:"acme/missing",model:"auto",prompt:"Invalid"})).rejects.toThrow("Repository unavailable");
    expect(() => runs.enqueue(closed.id, "u", "Invalid", ["missing"])).toThrow("That image isn't available.");
    expect(() => runs.enqueue(closed.id, "u", "Invalid", [], "x".repeat(21))).toThrow("Choose a supported effort.");
    expect(destroy).not.toHaveBeenCalled();
    expect(runs.get(first.id).work_kept).toBe(true);
    expect(runs.get(second.id).work_kept).toBe(true);
  });
  it("reclaims a kept failure for a follow-up and republishes its imported commit before re-cloning", async () => {
    const stopped = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Stopped"});
    await vi.waitFor(() => expect(runs.get(stopped.id).status).toBe("ready"));
    await runs.close(stopped.id);
    destroy.mockClear();
    vi.mocked(importBundle).mockRejectedValueOnce(new RetryError("push", {class:"server",retryable:true,reason:"GitHub returned 500"}, 5));
    const kept = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Kept"});
    await vi.waitFor(() => expect(runs.get(kept.id).status).toBe("failed"));
    const healthy = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Healthy"});
    await vi.waitFor(() => expect(runs.get(healthy.id).status).toBe("ready"));
    const history = runs.history(kept.id, 0);
    const clone = join(dir, "checkouts", kept.id);
    mkdirSync(clone, { recursive: true });
    writeFileSync(join(clone, "saved-commit"), "b".repeat(40));
    let destroyed!: () => void;
    destroy.mockImplementationOnce(() => new Promise<void>(done => { destroyed = done; }));
    runs.enqueue(stopped.id, "u", "Resume at capacity");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(checkout).toHaveBeenCalledTimes(3); // Replacement waits for resource release.
    destroyed();
    await vi.waitFor(() => expect(checkout).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(runs.get(stopped.id).status).toBe("ready"));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(runs.get(kept.id)).toMatchObject({work_kept:false, kept_commit:"b".repeat(40)});
    expect(runs.history(kept.id, 0)).toEqual(history);
    expect(runs.get(kept.id).diff).toContain("src/app.ts");
    expect(readFileSync(join(clone, "saved-commit"), "utf8")).toBe("b".repeat(40));
    await runs.close(stopped.id);
    vi.mocked(pushBranch).mockRejectedValueOnce(new RetryError("push", {class:"server",retryable:true,reason:"GitHub returned 500"}, 5));
    runs.enqueue(kept.id, "u", "Republish while offline");
    await vi.waitFor(() => expect(pushBranch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(runs.get(kept.id).status).toBe("failed"));
    expect(runs.get(kept.id).kept_commit).toBe("b".repeat(40));
    expect(runs.get(kept.id).error).toContain("Your saved commit is kept");
    expect(readFileSync(join(clone, "saved-commit"), "utf8")).toBe("b".repeat(40));
    vi.mocked(pushBranch).mockClear();
    let release!: () => void;
    vi.mocked(pushBranch).mockImplementationOnce(() => new Promise<void>(done => { release = done; }));
    const clones = vi.mocked(checkout).mock.calls.length;
    runs.enqueue(kept.id, "u", "Republish and continue");
    await vi.waitFor(() => expect(pushBranch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(pushBranch).mock.calls[0]?.[0]).toBe(join(dir, "checkouts", kept.id));
    expect(checkout).toHaveBeenCalledTimes(clones);
    runs.enqueue(kept.id, "u", "Queued during republish");
    release();
    await vi.waitFor(() => expect(log.some(call => call.method === "send" && (call.input as any)?.text === "Queued during republish")).toBe(true));
    await vi.waitFor(() => expect(runs.get(kept.id).status).toBe("ready"));
    expect(runs.get(kept.id).kept_commit).toBeUndefined();
    expect(vi.mocked(checkout).mock.calls.at(-1)?.[5]).toBe(true);
  });
  it("honors Stop while a reclaimed commit is being republished", async () => {
    const r = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Saved commit"});
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    await runs.close(r.id);
    const saved = runs.get(r.id);
    saved.kept_commit = "b".repeat(40);
    saved.pushed = false;
    saved.status = "failed";
    runs.save(saved);
    let release!: () => void;
    vi.mocked(pushBranch).mockImplementationOnce(() => new Promise<void>(done => { release = done; }));
    runs.enqueue(r.id, "u", "Resume");
    await vi.waitFor(() => expect(pushBranch).toHaveBeenCalledTimes(1));
    await runs.stop(r.id, "u");
    release();
    await vi.waitFor(() => expect(runs.get(r.id)).toMatchObject({status:"stopped",phase:"idle",pushed:true,pending:[]}));
    expect(runs.get(r.id).kept_commit).toBeUndefined();
    expect(checkout).toHaveBeenCalledTimes(1);
    expect(log.filter(call => call.method === "send" && (call.input as any)?.type === "user")).toHaveLength(1);
  });
  it("honors Stop while waiting for a reclaimed workspace to be destroyed", async () => {
    workerFailure = "The model connection dropped 3 times";
    const kept = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Kept"});
    await vi.waitFor(() => expect(runs.get(kept.id).status).toBe("failed"));
    workerFailure = null;
    const healthy = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Healthy"});
    await vi.waitFor(() => expect(runs.get(healthy.id).status).toBe("ready"));
    let release!: () => void;
    destroy.mockImplementationOnce(() => new Promise<void>(done => { release = done; }));
    const stopped = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Stop before startup"});
    await runs.stop(stopped.id, "u");
    release();
    await vi.waitFor(() => expect((runs as unknown as {booting:Set<string>}).booting.has(stopped.id)).toBe(false));
    await vi.waitFor(() => expect(runs.get(stopped.id)).toMatchObject({status:"stopped",phase:"idle",pending:[]}));
    expect(checkout).toHaveBeenCalledTimes(2);
    const next = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Free slot"});
    await vi.waitFor(() => expect(runs.get(next.id).status).toBe("ready"));
  });
  it("still prepares account deletion after a run was soft-deleted", async () => {
    const r = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Delete me"});
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    await runs.remove(r.id, "u");
    await expect(runs.withAccountDeletion("u", async prepare => { await prepare(); })).resolves.toBeUndefined();
    expect(() => runs.get(r.id)).toThrow("That run doesn't exist.");
  });
  it("drops failed import bundles during retention and re-snapshots before a follow-up", async () => {
    vi.mocked(importBundle).mockRejectedValueOnce(new RetryError("import", {class:"unknown",retryable:false,reason:"Import failed"}, 1));
    const r = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Import fails"});
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("failed"));
    const live = (runs as unknown as {live:Map<string,{publishPending?:{snapshot?:unknown}}>}).live.get(r.id)!;
    expect(live.publishPending?.snapshot).toBeUndefined();
    expect(runs.get(r.id).work_kept).toBe(true);
    expect(log.filter(call => call.method === "snapshot")).toHaveLength(1);
    runs.enqueue(r.id, "u", "Retry");
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    // Re-snapshot/import the kept turn, then snapshot the follow-up's completed turn.
    expect(log.filter(call => call.method === "snapshot")).toHaveLength(3);
    expect(importBundle).toHaveBeenCalledTimes(3);
    expect(checkout).toHaveBeenCalledTimes(1);
  });
  it("falls back to the pushed branch when persisted retention metadata has no live workspace", async () => {
    const r = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"First"});
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    await runs.close(r.id);
    const stale = runs.get(r.id);
    stale.status = "failed";
    stale.work_kept = true; // An abrupt restart can leave this persisted flag behind.
    runs.save(stale);
    expect(runs.get(r.id).work_kept).toBe(false);
    runs.enqueue(r.id,"u","Reopen after restart");
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(checkout).toHaveBeenCalledTimes(2);
    expect(vi.mocked(checkout).mock.calls.at(-1)?.[5]).toBe(true);
    expect(pushBranch).not.toHaveBeenCalled();
  });
  it("expires failed work with a fake timer and releases immediately when configured", async () => {
    vi.useFakeTimers();
    try {
      workerFailure = "The model connection dropped 3 times";
      const first = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"First"});
      await vi.waitFor(() => expect(runs.get(first.id).status).toBe("failed"));
      await vi.advanceTimersByTimeAsync(59 * 60_000);
      expect(destroy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(runs.get(first.id).work_kept).toBe(false);
      vi.stubEnv("GOND_AGENT_FAILED_KEEP_MINUTES","0");
      const second = await runs.create("u", {repo:"acme/app",model:"auto",prompt:"Second"});
      await vi.waitFor(() => expect(runs.get(second.id).status).toBe("failed"));
      expect(destroy).toHaveBeenCalledTimes(2);
      expect(runs.get(second.id).work_kept).toBe(false);
    } finally { vi.useRealTimers(); }
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
  it("uses an explicit title for commits and PRs and accepts an available custom branch", async () => {
    const title = "Fix session redirects", branch = "fix/session-redirects";
    const r = await runs.create("u", {
      repo: "acme/app", model: "auto", prompt: "Investigate the login flow", title, branch,
    });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(runs.get(r.id)).toMatchObject({ title, branch });
    expect(gh).toHaveBeenCalledWith(
      `repos/acme/app/git/matching-refs/heads/${branch}`, "GET", undefined,
      expect.objectContaining({ GH_TOKEN: "test-managed-github-token" }),
    );
    expect(vi.mocked(checkout).mock.calls[0]?.[4]).toBe(branch);
    expect(vi.mocked(importBundle).mock.calls[0]?.[2]).toBe(branch);
    expect(log.find(call => call.method === "snapshot")).toMatchObject({ title });
    expect(vi.mocked(gh).mock.calls.find(call => call[1] === "POST")?.[2]).toEqual({
      title, head: branch, base: "main", body: unverifiedDescription("Fixed it and tested it."),
    });
  });
  it("refuses an existing remote branch before reserving or starting a run", async () => {
    vi.mocked(gh).mockResolvedValueOnce({ default_branch: "main" }).mockResolvedValueOnce([{ ref: "refs/heads/fix/taken" }]);
    await expect(runs.create("u", { repo: "acme/app", model: "auto", prompt: "Fix it", branch: "fix/taken" })).rejects.toMatchObject({ status: 400, code: "branch_exists" });
    expect(runs.list("u")).toHaveLength(0);
    expect(checkout).not.toHaveBeenCalled();
  });
  it("rechecks explicit branches before the first publication", async () => {
    workerTurns.push([{ type: "turn.start", agent_id: "main" }]);
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Fix it", branch: "fix/raced" });
    await vi.waitFor(() => expect(log.some(call => call.method === "events")).toBe(true));
    vi.mocked(gh).mockResolvedValueOnce([{ ref: "refs/heads/fix/raced" }]);
    events.push({ type: "text.delta", agent_id: "main", text: "Done" }, { type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("failed"));
    expect(runs.get(r.id).summary.text).toBe("");
    expect(log.some(call => call.method === "snapshot")).toBe(false);
    expect(importBundle).not.toHaveBeenCalled();
  });
  it("keeps the prompt-derived title and generated branch when publication fields are omitted", async () => {
    const r = await runs.create("u", {
      repo: "acme/app", model: "auto", prompt: "  Fix   the login redirect\nKeep sessions intact.",
    });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    const title = "Fix the login redirect", branch = `gond-agent/fix-the-login-redirect-${r.id.slice(-6)}`;
    expect(runs.get(r.id)).toMatchObject({ title, branch });
    expect(log.find(call => call.method === "snapshot")).toMatchObject({ title });
    expect(vi.mocked(gh).mock.calls.find(call => call[1] === "POST")?.[2]).toMatchObject({ title, head: branch });
  });
  it.each(["Release notes supplied by the caller.\n\nKeep this description.", ""])("persists explicit PR body %j through follow-ups and later PATCH overrides", async body => {
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt: "Fix it", pr_body: body });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(vi.mocked(gh).mock.calls.find(call => call[1] === "POST")?.[2]).toMatchObject({ body: unverifiedDescription(body) });
    const patches = () => vi.mocked(gh).mock.calls.filter(call => call[0] === "repos/acme/app/pulls/42" && call[1] === "PATCH");
    runs.enqueue(r.id, "u", "Add a regression test");
    await vi.waitFor(() => expect(patches()).toHaveLength(1));
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(runs.get(r.id).pr_body).toBe(body);
    const stale = runs.get(r.id);
    const replacement = body === "" ? "Updated release notes." : "";
    runs.enqueue(r.id, "u", "Update the description", [], undefined, undefined, undefined, replacement);
    await vi.waitFor(() => expect(patches()).toHaveLength(2));
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    runs.enqueue(r.id, "u", "One more check");
    await vi.waitFor(() => expect(patches()).toHaveLength(3));
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(patches().map(call => call[2])).toEqual([{ body: unverifiedDescription(body) }, { body: unverifiedDescription(replacement) }, { body: unverifiedDescription(replacement) }]);
    runs.save(stale);
    expect(runs.get(r.id).pr_body).toBe(replacement);
    const stored = db.prepare("SELECT data FROM runs WHERE id=?").get(r.id) as { data: string };
    expect(JSON.parse(stored.data).pr_body).toBe(replacement);
  });
  it("publishes only the final main reply after parallel tools, retaining commentary in the transcript and resetting follow-ups", async () => {
    const fixture = [
      { type: "turn.start", agent_id: "main" },
      { type: "text.delta", agent_id: "main", text: "I'll inspect both files." },
      { type: "tool.call", agent_id: "main", call_id: "read-1", name: "read" },
      { type: "tool.start", agent_id: "main", call_id: "read-1", name: "read", title: "src/app.ts", input: { path: "src/app.ts" } },
      { type: "tool.call", agent_id: "main", call_id: "read-2", name: "read" },
      { type: "tool.start", agent_id: "main", call_id: "read-2", name: "read", title: "src/auth.ts", input: { path: "src/auth.ts" } },
      { type: "tool.output", agent_id: "main", call_id: "read-2", chunk: "File contents, not a description" },
      { type: "tool.end", agent_id: "main", call_id: "read-2", ok: true, summary: "Read auth", output: "Auth source" },
      { type: "tool.end", agent_id: "main", call_id: "read-1", ok: true, summary: "Read app", output: "App source" },
      { type: "text.delta", agent_id: "main", text: "I'll check the plan before replying." },
      { type: "tool.call", agent_id: "main", call_id: "plan-1", name: "list_plan" },
      { type: "text.delta", agent_id: "main", text: "## Result\n\nFixed the redirect. " },
      { type: "turn.start", agent_id: "explore-1" },
      { type: "text.delta", agent_id: "explore-1", text: "Subagent commentary" },
      { type: "tool.call", agent_id: "explore-1", call_id: "sub-read", name: "read" },
      { type: "tool.start", agent_id: "explore-1", call_id: "sub-read", name: "read", title: "src/app.ts", input: { path: "src/app.ts" } },
      { type: "tool.end", agent_id: "explore-1", call_id: "sub-read", ok: true, summary: "Read app", output: "App source" },
      { type: "text.delta", agent_id: "explore-1", text: "Subagent final reply" },
      { type: "turn.end", agent_id: "explore-1", stop_reason: "end_turn" },
      { type: "text.delta", agent_id: "main", text: "Checks passed.\n" },
      { type: "turn.end", agent_id: "main", stop_reason: "end_turn" },
    ];
    workerTurns.push(fixture);
    const prompt = "Fix the login flow", reply = "## Result\n\nFixed the redirect. Checks passed.\n";
    const title = "Fix login redirect";
    const r = await runs.create("u", { repo: "acme/app", model: "auto", prompt, title });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(runs.get(r.id).summary).toMatchObject({ text: reply, final_reply: true });
    expect(vi.mocked(gh).mock.calls.find(call => call[1] === "POST")?.[2]).toMatchObject({ body: unverifiedDescription(reply) });
    const types = new Set(fixture.map(event => event.type));
    expect(runs.history(r.id, 0).filter(event => types.has(event.type))).toMatchObject(fixture);

    // A successful tools-only follow-up must not publish its commentary or the previous reply.
    workerTurns.push([
      { type: "turn.start", agent_id: "main" },
      { type: "text.delta", agent_id: "main", text: "I'll inspect the plan." },
      { type: "tool.call", agent_id: "main", call_id: "plan-2", name: "list_plan" },
      { type: "turn.end", agent_id: "main", stop_reason: "end_turn" },
    ]);
    const patches = () => vi.mocked(gh).mock.calls.filter(call => call[1] === "PATCH");
    runs.enqueue(r.id, "u", "Inspect the plan without a final reply");
    await vi.waitFor(() => expect(patches()).toHaveLength(1));
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(runs.get(r.id).summary.text).toBe("");
    expect(patches()[0]?.[2]).toEqual({ body: unverifiedDescription(title) });
    runs.enqueue(r.id, "u", "Finish with a new reply");
    await vi.waitFor(() => expect(patches()).toHaveLength(2));
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(runs.get(r.id).summary).toMatchObject({ text: "Fixed it and tested it.", final_reply: true });
    expect(patches()[1]?.[2]).toEqual({ body: unverifiedDescription("Fixed it and tested it.") });
  });
  it.each(["max_tokens", "unknown_stop"])("publishes the title instead of text ending with %s without altering the transcript", async stop_reason => {
    const fixture = [
      { type: "turn.start", agent_id: "main" },
      { type: "text.delta", agent_id: "main", text: "Incomplete reply" },
      { type: "turn.end", agent_id: "main", stop_reason },
    ];
    workerTurns.push(fixture);
    const title = "Safe run title";
    const r = await runs.create("u", { repo: "acme/app", model: "auto", title, prompt: "Task with sensitive pasted text" });
    await vi.waitFor(() => expect(runs.get(r.id).status).toBe("ready"));
    expect(runs.get(r.id).summary.final_reply).toBe(false);
    expect(vi.mocked(gh).mock.calls.find(call => call[1] === "POST")?.[2]).toMatchObject({ body: unverifiedDescription(title) });
    expect(runs.history(r.id, 0).filter(event => fixture.some(item => item.type === event.type))).toMatchObject(fixture);
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
