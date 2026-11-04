import { expect, it } from "vitest";
import { createTranscript, type StreamEvent } from "../../web/src/features/run/transcript";
import { activityLabel, groupLabel, presentTool } from "../../web/src/features/run/tool-presentation";
import { emptySummary, fold } from "../src/runs/fold";

it("shows teardown give-up once without changing the run status on replay", () => {
  const append = createTranscript();
  const events: StreamEvent[] = [
    { seq: 1, ts: 1, type: "run.status", status: "ready" },
    { seq: 2, ts: 2, type: "run.cleanup", state: "gave_up", attempts: 5 },
  ];
  const result = append(events);
  expect(result.status).toBe("ready");
  expect(result.items).toEqual([expect.objectContaining({ kind: "run-message", text: expect.stringContaining("Try Close workspace again") })]);
  expect(append(events)).toEqual(result);
});

it("preserves transcript snapshots across batches and deduplicates reconnect replay", () => {
  const event = (seq: number, type: string, fields = {}): StreamEvent => ({ seq, ts: seq * 100, type, ...fields });
  const initial = [
    event(1, "user", { text: "Fix this" }),
    event(2, "text.delta", { text: "Working" }),
    event(3, "tool.start", { call_id: "read", name: "read" }),
    event(4, "tool.start", { call_id: "edit", name: "edit" }),
    event(5, "todos", { items: [{ text: "Fix", status: "pending" }] }),
    event(6, "agent.spawn", { agent_id: "helper", kind: "explore", description: "Inspect" }),
  ];
  const updates = [
    event(7, "tool.output", { call_id: "read", chunk: "source" }),
    event(8, "tool.end", { call_id: "edit", ok: true, diff: "patch" }),
    event(9, "todos", { items: [{ text: "Fix", status: "done" }] }),
    event(10, "agent.status", { agent_id: "helper", activity: "Checking", tool_count: 2, elapsed_ms: 100 }),
    event(11, "agent.end", { agent_id: "helper", ok: true, summary: "Found it" }),
    event(12, "run.diff", { files: 1, additions: 1, deletions: 0 }),
    event(13, "run.status", { status: "ready" }),
  ];
  const append = createTranscript(), before = append(initial), frozen = structuredClone(before);
  const after = append(updates);
  expect(before).toEqual(frozen);
  expect(after.items[0]).toBe(before.items[0]);
  expect(after.items[2]).toMatchObject({ kind: "explore", tools: [{ output: "source" }] });
  expect(after.items[3]).toMatchObject({ kind: "edits", tools: [{ status: "done", diff: "patch" }] });
  expect(after.items[4]).toMatchObject({ kind: "plan", steps: [{ status: "done" }] });
  expect(after.items[5]).toMatchObject({ kind: "agents", agents: [{ status: "done", tools: 2, summary: "Found it" }] });
  expect(after).toMatchObject({ status: "ready", startedAt: 100, committed: 1, editDiffs: ["patch"] });
  expect(append([...initial, ...updates])).toEqual(after);
  expect(after).toEqual(createTranscript()([...initial, ...updates]));
});

it("keeps compaction markers ordered, replay-safe and independent of run completion", () => {
  const append = createTranscript();
  const events: StreamEvent[] = [
    { seq: 1, ts: 1, type: "run.status", status: "working" },
    { seq: 2, ts: 2, type: "text.delta", agent_id: "main", text: "Before" },
    { seq: 3, ts: 3, type: "compacted", agent_id: "main", reason: "auto-round", before: 10000, after: 2000 },
    { seq: 4, ts: 4, type: "text.delta", agent_id: "main", text: "After" },
    { seq: 5, ts: 5, type: "compacted", agent_id: "explore-1", reason: "overflow", before: 9000, after: 1000 },
    { seq: 6, ts: 6, type: "compacted" }, // Historical shape.
  ];
  const result = append(events);
  expect(result.status).toBe("working");
  expect(result.items).toMatchObject([
    { kind: "text", text: "Before" },
    { kind: "compacted", reason: "auto-round", before: 10000, after: 2000 },
    { kind: "text", text: "After" },
    { kind: "compacted" },
  ]);
  expect(result.items).toHaveLength(4);
  expect(append(events)).toEqual(result);
  expect(result).toEqual(createTranscript()(events));
});

it("rolls back partial text across compaction and a queued follow-up without mutating replay snapshots", () => {
  const event = (seq: number, type: string, fields = {}): StreamEvent => ({ seq, ts: seq, type, agent_id: "main", ...fields });
  const append = createTranscript();
  const initial = [
    event(1, "turn.start"),
    event(2, "text.delta", { text: "Completed earlier response. " }),
    event(3, "text.delta", { text: "Partial " }),
    event(4, "compacted", { reason: "auto-round", before: 10000, after: 2000 }),
    event(5, "text.delta", { text: "middle " }),
    event(6, "user", { text: "Queued follow-up", images: [] }),
    event(7, "text.delta", { text: "draft" }),
  ];
  const before = append(initial);
  const frozenBefore = structuredClone(before);
  const updates = [
    event(8, "stream.reset", { text_length: "Partial middle draft".length, reasoning_length: 0 }),
    event(9, "text.delta", { text: "Final reply" }),
  ];
  const after = append(updates);
  expect(after.items).toEqual([
    { kind: "text", key: "t2", text: "Completed earlier response. " },
    { kind: "compacted", key: "compact4", reason: "auto-round", before: 10000, after: 2000 },
    { kind: "user", key: "u6", text: "Queued follow-up", ts: 6, images: [] },
    { kind: "text", key: "t9", text: "Final reply" },
  ]);
  const frozenAfter = structuredClone(after);
  const all = [...initial, ...updates];
  expect(append(all)).toEqual(frozenAfter);
  expect(createTranscript()(all)).toEqual(frozenAfter);
  expect(before).toEqual(frozenBefore);
  expect(after).toEqual(frozenAfter);
  // Compaction is a publication boundary, not a transcript deletion.
  expect(all.reduce(fold, emptySummary()).text).toBe("Final reply");
});

it("groups API, Claude and Codex activity without exposing transport names or merging external tools", () => {
  const append = createTranscript();
  const starts = [
    { name: "read", title: "api/src/auth.ts", input: { path: "api/src/auth.ts" } },
    { name: "mcp__gond__read", title: "mcp__gond__read", input: { path: "web/src/auth.ts" } },
    { name: "mcpToolCall", title: "grep", input: { server: "gond", tool: "grep", arguments: JSON.stringify({ pattern: "redirect" }) } },
    { name: "Read", title: "Read", input: { file_path: "web/src/auth.ts" } },
    { name: "mcp__gond__edit", input: { path: "api/src/auth.ts" } },
    { name: "fileChange", input: { changes: [{ path: "api/test/auth.test.ts" }] } },
  ];
  const events = starts.flatMap((fields, i) => [
    { ...fields, seq: i * 2 + 1, ts: i * 100, type: "tool.start", call_id: String(i) },
    { seq: i * 2 + 2, ts: i * 100 + 50, type: "tool.end", call_id: String(i), ok: true },
  ]);
  const result = append(events);
  expect(result.items).toMatchObject([{ kind: "explore", tools: [{ name: "read" }, { name: "read", title: "web/src/auth.ts" }, { name: "grep", title: "redirect" }, { name: "read" }] }, { kind: "edits", tools: [{ name: "edit" }, { name: "apply_patch" }] }]);
  const reads = result.items[0], edits = result.items[1];
  if (reads.kind !== "explore" || edits.kind !== "edits") throw new Error("Expected grouped activity");
  expect(groupLabel(reads.tools)).toBe("Viewed 2 files and ran 1 search");
  expect(groupLabel(edits.tools, true)).toBe("Updated 2 files");
  expect(JSON.stringify(result.log)).not.toMatch(/mcp__|mcpToolCall|fileChange/);
  expect(presentTool("mcp__github__search_issues", "mcp__github__search_issues", { query: "bug" })).toMatchObject({ name: "external", label: "Search issues", source: "github", title: "bug" });
  expect(presentTool("mcpToolCall", "read", { server: "gond", tool: "read", arguments: "invalid JSON" })).toMatchObject({ name: "read", title: "" });
  const planned = append([
    { seq: 13, ts: 1000, type: "tool.start", call_id: "plan", name: "mcp__gond__update_plan", input: {} },
    { seq: 14, ts: 1001, type: "tool.end", call_id: "plan", ok: true },
  ]);
  expect(planned.items.at(-1)).toMatchObject({ kind: "tool", tool: { name: "update_plan", status: "done" } });
});

it("keeps running and failed work distinct in activity summaries", () => {
  const command = { ...presentTool("mcpToolCall", "bash", { server: "gond", tool: "bash", arguments: { command: "npm run typecheck" } }), status: "running" as const };
  expect(activityLabel(command)).toBe("Running typecheck");
  expect(activityLabel({ ...command, status: "failed" })).toBe("Typecheck failed");
  const append = createTranscript();
  const running = append([{ seq: 1, ts: 1, type: "tool.start", call_id: "read", name: "mcp__gond__read", input: { path: "missing.ts" } }]);
  const failed = append([{ seq: 2, ts: 2, type: "tool.end", call_id: "read", ok: false, output: "File not found" }]);
  if (running.items[0].kind !== "explore" || failed.items[0].kind !== "explore") throw new Error("Expected grouped reads");
  expect(groupLabel(running.items[0].tools)).toBe("Reading missing.ts");
  expect(groupLabel(failed.items[0].tools)).toBe("Couldn't finish reviewing context");
  expect(failed.items[0].tools[0]).toMatchObject({ status: "failed", output: "File not found" });
});

it("processes streamed text once and leaves previous text snapshots intact", () => {
  const append = createTranscript();
  const before = append([{ seq: 1, ts: 1, type: "text.delta", text: "Start" }]);
  let reads = 0;
  for (let seq = 2; seq <= 5001; seq++) {
    append([{ seq, ts: seq, type: "text.delta", get text() { reads++; return "."; } }]);
  }
  expect(reads).toBe(5000);
  expect(before.items).toEqual([{ kind: "text", key: "t1", text: "Start" }]);
  expect(append([]).items[0]).toMatchObject({ text: "Start" + ".".repeat(5000) });
});

it("updates the PR presentation after external merges without duplicating the opened card", () => {
  const append = createTranscript();
  const opened = append([{ seq: 1, ts: 1, type: "run.pr", number: 42, url: "https://github.com/acme/app/pull/42" }]);
  const merged = append([{ seq: 2, ts: 2, type: "run.pr", number: 42, url: "https://github.com/acme/app/pull/42", state: "merged" }]);
  expect(opened.items).toMatchObject([{ kind: "pr", state: "open" }]);
  expect(merged.items).toHaveLength(1);
  expect(merged.items[0]).toMatchObject({ kind: "pr", state: "merged", number: 42 });
  expect(merged.log.at(-1)?.text).toBe("merged pull request #42");
});

it("refreshes queue metadata on position changes and dequeue without duplicating replay", () => {
  const append = createTranscript();
  const queued = {seq:1, ts:1, type:"run.queued", position:2, length:3};
  const before = append([queued]);
  expect(append([queued]).queueRevision).toBe(before.queueRevision);
  const after = append([
    {seq:2, ts:2, type:"run.queued", position:1, length:2},
    {seq:3, ts:3, type:"run.dequeued"},
  ]);
  expect(after.queueRevision).toBe(before.queueRevision + 2);
  expect(after.items).toEqual([]);
});

it("discards aborted attempts and shows the successful reply once in transcript and summary", () => {
  const event = (seq: number, type: string, fields = {}): StreamEvent => ({ seq, ts: seq, type, agent_id: "main", ...fields });
  const append = createTranscript();
  let summary = emptySummary();
  const push = (events: StreamEvent[]) => {
    summary = events.reduce(fold, summary);
    return append(events);
  };
  const start = [
    event(1, "user", { text: "Fix this" }),
    event(2, "turn.start"),
    event(3, "text.delta", { text: "Completed earlier response. " }),
    event(4, "text.delta", { text: "🦀" }),
    event(5, "text.delta", { text: "draft" }),
    event(6, "reasoning.delta", { text: "🤔" }),
  ];
  const before = push(start);
  const frozen = structuredClone(before);
  const reset = event(7, "stream.reset", { text_length: 7, reasoning_length: 2 });
  expect(push([reset]).items.at(-1)).toMatchObject({ kind: "text", text: "Completed earlier response. " });
  expect(summary.text).toBe("Completed earlier response. ");
  expect(before).toEqual(frozen);

  const retry = [
    event(8, "tool.start", { call_id: "read", name: "read", input: { path: "file.ts" } }),
    event(9, "tool.end", { call_id: "read", ok: true, output: "kept output" }),
    event(10, "text.delta", { text: "second partial" }),
    event(11, "todos", { items: [{ text: "Fix", status: "done" }] }),
    event(12, "stream.reset", { text_length: "second partial".length, reasoning_length: 0 }),
    event(13, "text.delta", { text: "Final " }),
    event(14, "text.delta", { text: "reply" }),
    event(15, "turn.end", { stop_reason: "end_turn" }),
  ];
  const after = push(retry);
  expect(after.items.filter(item => item.kind === "text")).toEqual([
    { kind: "text", key: "t3", text: "Completed earlier response. " },
    { kind: "text", key: "t13", text: "Final reply" },
  ]);
  // The transcript above keeps pre-tool commentary; the publication summary does not.
  expect(summary.text).toBe("Final reply");
  expect(summary.final_reply).toBe(true);
  expect(after.items.find(item => item.kind === "explore")).toMatchObject({ tools: [{ status: "done", output: "kept output" }] });
  expect(after.items.find(item => item.kind === "plan")).toMatchObject({ steps: [{ text: "Fix", status: "done" }] });
  const all = [...start, reset, ...retry];
  expect(append(all)).toEqual(after); // Reconnect replay must not roll back twice.
  expect(createTranscript()(all)).toEqual(after);
  expect(all.reduce(fold, emptySummary())).toEqual(summary);
});

it("keeps other agents and reasoning-only resets from changing main text", () => {
  const events: StreamEvent[] = [
    { seq: 1, ts: 1, type: "turn.start", agent_id: "main" },
    { seq: 2, ts: 2, type: "text.delta", agent_id: "main", text: "Kept" },
    { seq: 3, ts: 3, type: "text.delta", agent_id: "helper", text: "draft" },
    { seq: 4, ts: 4, type: "stream.reset", agent_id: "helper", text_length: 5, reasoning_length: 0 },
    { seq: 5, ts: 5, type: "stream.reset", agent_id: "main", text_length: 0, reasoning_length: 2 },
  ];
  expect(createTranscript()(events).items).toEqual([{ kind: "text", key: "t2", text: "Kept" }]);
  expect(events.reduce(fold, emptySummary()).text).toBe("Kept");
});

it("rolls back an attempt even when a follow-up was queued between its deltas", () => {
  const events: StreamEvent[] = [
    { seq: 1, ts: 1, type: "turn.start", agent_id: "main" },
    { seq: 2, ts: 2, type: "text.delta", agent_id: "main", text: "Partial " },
    { seq: 3, ts: 3, type: "user", text: "Queued follow-up", images: [] },
    { seq: 4, ts: 4, type: "text.delta", agent_id: "main", text: "draft" },
    { seq: 5, ts: 5, type: "stream.reset", agent_id: "main", text_length: 13, reasoning_length: 0 },
    { seq: 6, ts: 6, type: "text.delta", agent_id: "main", text: "Final reply" },
  ];
  const transcript = createTranscript()(events);
  expect(transcript.items.filter(item => item.kind === "text")).toEqual([{ kind: "text", key: "t6", text: "Final reply" }]);
  expect(transcript.items.find(item => item.kind === "user")).toMatchObject({ text: "Queued follow-up" });
  expect(events.reduce(fold, emptySummary()).text).toBe("Final reply");
});
