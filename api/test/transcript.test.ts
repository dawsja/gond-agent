import { expect, it } from "vitest";
import { createTranscript, type StreamEvent } from "../../web/src/features/run/transcript";

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
  expect(after.items[3]).toMatchObject({ kind: "tool", tool: { status: "done", diff: "patch" } });
  expect(after.items[4]).toMatchObject({ kind: "plan", steps: [{ status: "done" }] });
  expect(after.items[5]).toMatchObject({ kind: "agents", agents: [{ status: "done", tools: 2, summary: "Found it" }] });
  expect(after).toMatchObject({ status: "ready", startedAt: 100, committed: 1, editDiffs: ["patch"] });
  expect(append([...initial, ...updates])).toEqual(after);
  expect(after).toEqual(createTranscript()([...initial, ...updates]));
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
