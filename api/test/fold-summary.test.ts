import { describe, expect, it } from "vitest";
import { emptySummary, fold, type Ev, type Summary } from "../src/runs/fold";
import { descriptionFor } from "../src/runs/publication";
import { createTranscript } from "../../web/src/features/run/transcript";

const text = (value: string, agent_id = "main"): Ev => ({ type: "text.delta", agent_id, text: value });
const start = (call_id: string, agent_id = "main"): Ev => ({
  type: "tool.start", agent_id, call_id, name: "read", input: { path: "src/app.ts" }, title: "src/app.ts",
});
const end = (call_id: string, agent_id = "main"): Ev => ({
  type: "tool.end", agent_id, call_id, ok: true, summary: "Read file", output: "contents",
});
const turnEnd = (stop_reason: string, agent_id = "main"): Ev => ({ type: "turn.end", agent_id, stop_reason });
const foldAll = (events: Ev[], initial: Summary = emptySummary()): Summary => events.reduce(fold, initial);

describe("run summary final reply", () => {
  it("rolls back a partial attempt and publishes only the post-tool retry reply once on clean end_turn", () => {
    const partial = "Partial attempt 🛠";
    let summary = foldAll([
      { type: "turn.start", agent_id: "main" },
      text(partial),
      { type: "stream.reset", agent_id: "main", text_length: partial.length, reasoning_length: 0 },
    ]);
    expect(summary.text).toBe("");

    summary = foldAll([text("Retry commentary"), { type: "tool.call", agent_id: "main", call_id: "plan", name: "list_plan" }], summary);
    expect(summary.text).toBe("");
    summary = foldAll([text("Final reply. "), text("Checks passed.")], summary);
    const run = () => ({ summary, title: "Safe run title", status: "ready" as const });
    expect(descriptionFor(run())).toBe("Safe run title");

    summary = fold(summary, turnEnd("end_turn"));
    expect(summary.final_reply).toBe(true);
    expect(summary.text).toBe("Final reply. Checks passed.");
    expect(descriptionFor(run())).toBe("Final reply. Checks passed.");
  });

  it("excludes an overflowing reply after compaction while keeping its transcript and subsequent retry rollback", () => {
    const events: Ev[] = [
      { type: "turn.start", agent_id: "main" },
      text("Partial overflowing response"),
      { type: "compacted", agent_id: "helper", reason: "overflow", before: 1000, after: 300 },
      { type: "compacted", agent_id: "main", reason: "overflow", before: 1000, after: 300 },
      text("Abandoned retry"),
      { type: "stream.reset", agent_id: "main", text_length: "Abandoned retry".length, reasoning_length: 0 },
      text("Recovered final reply"),
      turnEnd("end_turn"),
    ];
    expect(foldAll(events.slice(0, 3)).text).toBe("Partial overflowing response");
    const compacted = foldAll(events.slice(0, 4));
    expect(compacted.text).toBe("");
    expect(descriptionFor({ summary: compacted, title: "Safe title", status: "working" })).toBe("Safe title");
    expect(descriptionFor({ summary: foldAll(events), title: "Safe title", status: "ready" })).toBe("Recovered final reply");
    const transcript = createTranscript()(events.map((ev, i) => ({ ...ev, seq: i + 1, ts: i + 1 })));
    expect(transcript.items.filter(item => item.kind === "text").map(item => item.text)).toEqual([
      "Partial overflowing response", "Recovered final reply",
    ]);
    expect(transcript.items.some(item => item.kind === "compacted")).toBe(true);
  });

  it("leaves streaming transcript text and visible activity unchanged by boundary markers", () => {
    const events = [text("Commentary"), { type: "tool.call", agent_id: "main", call_id: "r", name: "read" }, start("r"), end("r"), text("Final reply"), turnEnd("end_turn")]
      .map((ev, i) => ({ ...ev, seq: i + 1, ts: i + 1 }));
    const transcript = createTranscript()(events);
    expect(transcript).toEqual(createTranscript()(events.filter(ev => ev.type !== "tool.call")));
    expect(transcript.items.filter(item => item.kind === "text").map(item => item.text)).toEqual(["Commentary", "Final reply"]);
    expect(foldAll(events).text).toBe("Final reply");
  });
  it("keeps only text after the last main tool call, including text before a tool in the same response", () => {
    const summary = foldAll([
      { type: "turn.start", agent_id: "main" },
      text("I'll inspect the implementation."),
      start("read-1"),
      end("read-1"),
      text("I found the issue; checking the fix."),
      start("read-2"),
      end("read-2"),
      text("Fixed the issue.\n\n"),
      { type: "reasoning.delta", agent_id: "main", text: "Private reasoning" },
      text("Checks passed."),
      turnEnd("end_turn"),
    ]);
    expect(summary.text).toBe("Fixed the issue.\n\nChecks passed.");
    expect(summary.step).toBe("Reading src/app.ts");
  });

  it("clears text at every start in a parallel tool batch and leaves tool results out", () => {
    let summary = foldAll([text("Reading two files."), start("first"), start("second")]);
    expect(summary.text).toBe("");
    summary = foldAll([
      { type: "tool.output", agent_id: "main", call_id: "second", chunk: "not the final reply" },
      end("second"),
      end("first"),
      text("Both files are correct."),
      turnEnd("end_turn"),
    ], summary);
    expect(summary.text).toBe("Both files are correct.");
  });

  it("does not use pre-tool commentary when no reply follows the tools", () => {
    const summary = foldAll([text("I'll check this."), start("read"), end("read"), turnEnd("end_turn")]);
    expect(summary.text).toBe("");
  });

  it("does not include subagent text or let subagent tools and failures clear the main reply", () => {
    const summary = foldAll([
      text("Main reply. "),
      { type: "turn.start", agent_id: "explore-1" },
      text("Subagent commentary", "explore-1"),
      start("sub-read", "explore-1"),
      end("sub-read", "explore-1"),
      { type: "error", agent_id: "explore-1", message: "Subagent failed", retryable: false },
      turnEnd("error", "explore-1"),
      turnEnd("interrupted", "explore-2"),
      text("Subagent final reply", "explore-1"),
      text("Still the main reply."),
      turnEnd("end_turn"),
    ]);
    expect(summary.text).toBe("Main reply. Still the main reply.");
    expect(summary.error).toBeNull();
  });

  it.each(["interrupted", "error"])("clears a partial reply on a main %s ending", (reason) => {
    const summary = foldAll([
      text("Partial reply"),
      { type: "question", agent_id: "main", request_id: "q1", question: "Continue?", options: [] },
      turnEnd(reason),
    ]);
    expect(summary.text).toBe("");
    expect(summary.question).toBeNull();
  });

  it("clears a partial reply on a main error even without a turn.end event", () => {
    const summary = foldAll([
      text("Partial reply"),
      { type: "error", agent_id: "main", message: "Unable to continue", retryable: true },
    ]);
    expect(summary.text).toBe("");
    expect(summary.error).toBe("Unable to continue");
  });

  it("preserves all streamed text and whitespace when no tools are called", () => {
    const reply = "## Result\n\nAnswered directly.\n";
    const summary = foldAll([
      { type: "turn.start", agent_id: "main" },
      text("## Result\n"),
      text("\nAnswered directly."),
      text("\n"),
      turnEnd("end_turn"),
    ]);
    expect(summary.text).toBe(reply);
  });

  it("resets previous text and errors through the existing main turn.start path", () => {
    const previous = { ...emptySummary(), text: "Previous reply", error: "Previous error" };
    const reset = fold(previous, { type: "turn.start", agent_id: "main" });
    expect(reset.text).toBe("");
    expect(reset.error).toBeNull();
    expect(foldAll([text("Follow-up reply"), turnEnd("end_turn")], reset).text).toBe("Follow-up reply");
  });
});
