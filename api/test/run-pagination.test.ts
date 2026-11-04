import { afterEach, beforeEach, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthentication } from "../src/auth";
import { createApp } from "../src/app";
import { openStore } from "../src/db";
import type { Config } from "../src/config";
import { Runs, type Run } from "../src/runs/service";
const { history } = createRequire(import.meta.url)("./fixtures/pagination.cjs") as { history: (owner: string) => Run[] };
let dir: string, db: ReturnType<typeof openStore>, runs: Runs, instance: ReturnType<typeof createApp>;
let owner: string, cookie: string, fixture: Run[];
const cfg: Config = { data: "", origin: "http://localhost:8787", secret: "pagination-test-secret-at-least-32-characters", signup: true, port: 8787, dockerBin: "docker", workerImage: "unused", maxRuns: 2, runCPUs: 1, runMemoryMB: 2048 };
function insert(run: Run, deleted: number | null = null) {
  db.prepare("INSERT INTO runs(id,user_id,repo,status,created_at,updated_at,deleted_at,data,queue_seq) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(run.id, run.user_id, run.repo, run.status, run.created_at, run.updated_at, deleted, JSON.stringify(run), run.status === "queued" ? Number(run.id.slice(-3)) + 1 : null);
}
async function get(query = "", auth = cookie) {
  const result = await instance.app.request(cfg.origin + "/api/v1/runs" + query, { headers: { cookie: auth } });
  expect(result.status).toBe(200);
  return result.json() as Promise<ReturnType<Runs["listPage"]>>;
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gond-pagination-")); cfg.data = dir;
  db = openStore(dir);
  const auth = await createAuthentication(db, cfg);
  runs = new Runs(db, cfg, async () => { throw new Error("No worker in list tests"); });
  instance = createApp(db, cfg, auth, runs);
  const response = await instance.app.request(cfg.origin + "/api/auth/sign-up/email", {
    method: "POST", headers: { origin: cfg.origin, "content-type": "application/json" },
    body: JSON.stringify({ name: "Pagination", email: "pagination@example.test", password: "correct horse battery staple" }),
  });
  expect(response.status).toBe(200);
  owner = (await response.json()).user.id;
  cookie = response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  fixture = history(owner);
  fixture.forEach(run => insert(run));
  insert({ ...fixture[0], id: "foreign", user_id: "another-account", repo: "private/other", status: "ready" });
  insert({ ...fixture[0], id: "deleted", status: "ready" }, 1);
});
afterEach(async () => {
  await instance.mcp.close(); await instance.githubLogin.close(); await runs.shutdown(); db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("paginates stable newest-first ties, reports full tab totals, and preserves queue fields", async () => {
  const redirect = await instance.app.request(cfg.origin + "/agents?page=3&size=25&tab=working");
  expect(redirect.headers.get("location")).toBe("/agents/?page=3&size=25&tab=working");
  const first = await get("?limit=25&offset=0");
  const second = await get("?limit=25&offset=25");
  const last = await get("?limit=25&offset=50");
  expect([...first.runs, ...second.runs, ...last.runs].map(r => r.id)).toEqual(fixture.map(r => r.id));
  expect(first.counts).toEqual({ all: 65, working: 26, active: 13, queued: 13, ready: 13, merged: 13 });
  expect(first.repositories).toEqual(["acme/app", "acme/web"]);
  expect(first).toMatchObject({ limit: 25, offset: 0, total: 65, start: 1, end: 25 });
  const queued = first.runs.find(r => r.status === "queued")!;
  expect(queued).toMatchObject({ queue_length: 13, capacity: { max: 2, queued_total_for_account: 13 } });
  expect(queued.queue_position).toBeGreaterThan(0);
  expect(queued.queue_reason).toBeTypeOf("string");
  expect(runs.get(queued.id, owner)).toMatchObject({ queue_position: queued.queue_position, capacity: queued.capacity });
  for (const [query, body] of [["limit=25&offset=0", first], ["limit=25&offset=25", second], ["limit=25&offset=50", last]] as const)
    console.log(JSON.stringify({ request: "/api/v1/runs?" + query, limit: body.limit, offset: body.offset, total: body.total, rows: body.runs.length, counts: body.counts, first: body.runs[0].id, last: body.runs.at(-1)!.id }));
});

it("combines repository and tab before paging, excludes deleted/foreign rows, clamps empty and last pages", async () => {
  for (const tab of ["all", "working", "ready", "merged"]) {
    const eligible = fixture.filter(r => r.repo === "acme/app");
    const matched = eligible.filter(r => tab === "all" || (tab === "working" ? ["working", "queued"].includes(r.status) : r.status === tab));
    const body = await get(`?limit=10&offset=10&tab=${tab}&repo=acme%2Fapp`);
    const offset = Math.min(10, Math.max(0, Math.ceil(matched.length / 10) - 1) * 10);
    expect(body.runs.map(r => r.id)).toEqual(matched.slice(offset, offset + 10).map(r => r.id));
    expect(body.total).toBe(matched.length);
    expect(body.counts.all).toBe(33);
    expect(body.counts.working).toBe(eligible.filter(r => ["working", "queued"].includes(r.status)).length);
  }
  expect(await get("?limit=25&offset=64")).toMatchObject({ offset: 64, start: 65, end: 65, runs: [expect.objectContaining({ id: "history-000" })] });
  expect(await get("?limit=25&offset=999999")).toMatchObject({ offset: 50, start: 51, end: 65 });
  expect(await get("?repo=missing&offset=500")).toMatchObject({ offset: 0, total: 0, runs: [] });
  expect(await get("?repo=private%2Fother")).toMatchObject({ total: 0, runs: [] });
  expect((await instance.app.request(cfg.origin + "/api/v1/runs")).status).toBe(401);
});

it("bounds old clients and invalid inputs without partial numeric parsing", async () => {
  // A history longer than the legacy default proves the bound, not just the metadata.
  for (let i = 0; i < 65; i++) insert({ ...fixture[i], id: `extra-${i}`, status: "ready" });
  expect(await get()).toMatchObject({ limit: 100, total: 130 });
  expect((await get()).runs).toHaveLength(100);
  expect((await get("?limit=99999")).runs).toHaveLength(100);
  expect(await get("?limit=0")).toMatchObject({ limit: 1 });
  for (const value of ["-1", "1.5", "abc", "25x", "Infinity", "9007199254740992", ""]) {
    expect(await get(`?limit=${value}&offset=${value}&tab=invalid`)).toMatchObject({ limit: 100, offset: 0, total: 130 });
  }
});

it("keeps the requested page during insertions and finishes; only shrinking history clamps", async () => {
  const before = await get("?limit=25&offset=25");
  insert({ ...fixture[0], id: "new-run", status: "working", created_at: fixture[0].created_at + 100 });
  const changed = fixture.find(r => r.status === "working")!;
  db.prepare("UPDATE runs SET status='ready',data=json_set(data,'$.status','ready') WHERE id=?").run(changed.id);
  const after = await get("?limit=25&offset=25");
  expect(after.offset).toBe(25);
  expect(after.runs[0].id).toBe(fixture[24].id);
  expect(after.runs.slice(1).map(r => r.id)).toEqual(before.runs.slice(0, 24).map(r => r.id));
  expect(after.counts).toMatchObject({ all: 66, working: 26, ready: 14 });
  db.prepare("UPDATE runs SET deleted_at=1 WHERE user_id=? AND id NOT IN (SELECT id FROM runs WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 10)").run(owner, owner);
  expect(await get("?limit=25&offset=25")).toMatchObject({ offset: 0, total: 10 });
});
