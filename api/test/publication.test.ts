import { expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertBranchAvailable, branchSchema, descriptionFor, publicationFields } from "../src/runs/publication";
import { emptySummary, fold } from "../src/runs/fold";
import { openStore } from "../src/db";
import { unverifiedDescription } from "./fixtures/evidence";

it("chooses explicit descriptions, then clean final text, then the plain title, never the prompt", () => {
  let summary = emptySummary();
  const run = () => ({ summary, title: "Safe run title", prompt: "Original task with sensitive pasted text", status: "ready" as const });
  expect(descriptionFor(run())).toBe(unverifiedDescription("Safe run title"));
  summary = fold(summary, { type: "text.delta", agent_id: "main", text: "Commentary" });
  summary = fold(summary, { type: "tool.call", agent_id: "main", name: "list_plan" });
  expect(summary.text).toBe("");
  summary = fold(summary, { type: "text.delta", agent_id: "main", text: "Final reply" });
  expect(descriptionFor(run())).toBe(unverifiedDescription("Safe run title")); // Streaming text is not yet a final reply.
  summary = fold(summary, { type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
  expect(descriptionFor(run())).toBe(unverifiedDescription("Final reply"));
  expect(descriptionFor({ ...run(), pr_body: "Override" })).toBe(unverifiedDescription("Override"));
  expect(descriptionFor({ ...run(), pr_body: "" })).toBe(unverifiedDescription(""));
  for (const status of ["failed", "stopped"] as const) {
    expect(descriptionFor({ ...run(), status })).toBe(unverifiedDescription("Safe run title"));
    expect(descriptionFor({ ...run(), status, pr_body: "Override" })).toBe(unverifiedDescription("Override"));
    expect(descriptionFor({ ...run(), status, pr_body: "" })).toBe(unverifiedDescription(""));
  }
  summary = fold(summary, { type: "tool.call", agent_id: "main", name: "list_plan" });
  summary = fold(summary, { type: "turn.end", agent_id: "main", stop_reason: "end_turn" });
  expect(summary.final_reply).toBe(true);
  expect(descriptionFor(run())).toBe(unverifiedDescription("Safe run title"));
  // Historical summaries without a success marker cannot publish their accumulated text.
  expect(descriptionFor({ ...run(), summary: { ...summary, text: "Old commentary", final_reply: undefined } })).toBe(unverifiedDescription("Safe run title"));
});

it.each(["max_tokens", "unknown_stop", "refusal", "content_filter", "context_exceeded", "tool_use", "compacted", "interrupted", "error"])("uses the title rather than a reply ending with %s", stop_reason => {
  const summary = [
    { type: "text.delta", agent_id: "main", text: "Incomplete or unsafe reply" },
    { type: "turn.end", agent_id: "main", stop_reason },
  ].reduce(fold, emptySummary());
  expect(summary.final_reply).toBe(false);
  expect(descriptionFor({ summary, title: "Safe run title", status: "ready" })).toBe(unverifiedDescription("Safe run title"));
});

it.each(["main", "master", "HEAD", "release", "release/next", "v1", "v1/next", "feat/../escape", "fix/foo..bar", "docs/ok/", "chore/file.lock", "feat/file.lock/child", "feat/.hidden", "feat/trailing.", "feat/UPPER", "other/name", "fix/", "fix/a/b/c/d/e", `feat/${"a".repeat(82)}`])("refuses unsafe branch %s", branch => {
  expect(() => publicationFields({ branch })).toThrow(expect.objectContaining({ status: 400 }));
});
it.each(["gond-agent/task-1", "feat/new_feature", "fix/a.b/c-d", "chore/deps/npm", "docs/readme", `gond-agent/${"a".repeat(81)}/${"b".repeat(80)}/${"c".repeat(80)}/${"d".repeat(80)}`])("accepts branch %s", branch => {
  expect(branchSchema.parse(branch)).toBe(branch);
});
it("validates title and description without trimming explicit empty bodies", () => {
  expect(publicationFields({ title: "A title", pr_body: "" })).toEqual({ title: "A title", pr_body: "" });
  expect(publicationFields({ title: "a".repeat(120), pr_body: "b".repeat(20000) }).title).toHaveLength(120);
  for (const title of ["", "  ", "two\nlines", "two\rlines", "two\u2028lines", "null\0", "a".repeat(121), 42, null])
    expect(() => publicationFields({ title })).toThrow(expect.objectContaining({ status: 400 }));
  for (const pr_body of ["b".repeat(20001), "null\0", 42, null])
    expect(() => publicationFields({ pr_body })).toThrow(expect.objectContaining({ status: 400 }));
});
it("refuses an existing remote branch unless it is this run's own branch", async () => {
  const checker = vi.fn(async () => true);
  await expect(assertBranchAvailable("acme/app", "fix/taken", {}, undefined, checker)).rejects.toMatchObject({ status: 400, code: "branch_exists" });
  await expect(assertBranchAvailable("acme/app", "fix/taken", {}, "fix/taken", checker)).resolves.toBeUndefined();
  expect(checker).toHaveBeenCalledTimes(1);
  checker.mockResolvedValue(false);
  await expect(assertBranchAvailable("acme/app", "fix/new", {}, undefined, checker)).resolves.toBeUndefined();
});
it("adds description storage idempotently without rewriting history or replacing explicit bodies", () => {
  const dir = mkdtempSync(join(tmpdir(), "publication-migration-"));
  try {
    let db = openStore(dir);
    db.exec("ALTER TABLE runs DROP COLUMN pr_body");
    for (const [id, data] of [["old", { title: "Original", branch: "gond-agent/original", prompt: "Task" }], ["explicit", { pr_body: "" }]] as const)
      db.prepare("INSERT INTO runs(id,user_id,repo,status,created_at,updated_at,data) VALUES(?,'u','acme/app','ready',1,2,?)").run(id, JSON.stringify(data));
    db.close();
    db = openStore(dir);
    const rows = () => db.prepare("SELECT * FROM runs ORDER BY id").all();
    expect(db.prepare("SELECT pr_body FROM runs WHERE id='old'").get()).toEqual({ pr_body: null });
    db.prepare("UPDATE runs SET pr_body='' WHERE id='explicit'").run();
    const migrated = rows();
    expect(JSON.parse((db.prepare("SELECT data FROM runs WHERE id='old'").get() as {data:string}).data)).toEqual({ title: "Original", branch: "gond-agent/original", prompt: "Task" });
    expect(JSON.parse((db.prepare("SELECT data FROM runs WHERE id='explicit'").get() as {data:string}).data)).toEqual({ pr_body: "" });
    db.close();
    db = openStore(dir);
    expect(rows()).toEqual(migrated);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("keeps PR body selection out of every other API caller and the web transcript", () => {
  const root = join(import.meta.dirname, "../src");
  function scan(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? scan(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
  }
  for (const path of scan(root).filter(path => !path.endsWith("/publication.ts"))) {
    expect(readFileSync(path, "utf8"), path).not.toMatch(/summary\s*(?:\?\.|\.)\s*text|summary\s*\[\s*["']text["']\s*\]/);
  }
  const panel = readFileSync(join(import.meta.dirname, "../../web/src/features/run/side-panel.tsx"), "utf8");
  expect(panel).toContain('const summary = run.description ?? ""');
});
