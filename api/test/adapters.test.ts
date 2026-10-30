import { describe, expect, it, vi } from "vitest";
import { anthropic } from "../src/adapters/anthropic";
import { chatAdapter } from "../src/adapters/chat";
import { responsesAdapter } from "../src/adapters/responses";
import type { ModelRow } from "../src/adapters/types";
import type { Message, StreamEvent } from "../src/wire";

const base: Omit<ModelRow, "provider" | "upstream_id" | "capabilities"> = {
  id: "m",
  display_name: "M",
  context_window: 400_000,
  max_output: 64_000,
  input_micros: 1,
  output_micros: 1,
  cache_read_micros: 0,
  cache_write_micros: 0,
};
const gpt: ModelRow = { ...base, provider: "openai", upstream_id: "gpt-5.5", capabilities: { reasoning: "effort" } };
const grok: ModelRow = { ...base, provider: "xai", upstream_id: "grok-4.7", capabilities: { reasoning: "effort", off: "low" } };

const run = (p: { push: (e: string | undefined, d: string) => StreamEvent[] }, events: object[]) => events.flatMap((e) => p.push(undefined, JSON.stringify(e)));

describe("responses adapter (OpenAI)", () => {
  const reasoningItem = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAA" };
  const history: Message[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        // Native model identity is retained for replay.
        { type: "reasoning", text: "", opaque: { provider: "openai", model: "gpt-5.5", data: reasoningItem } },
        { type: "reasoning", text: "x", opaque: { provider: "anthropic", model: "c", data: {} } },
        { type: "tool_call", id: "call_1", name: "read", input: { path: "a" } },
      ],
    },
    { role: "tool", content: [{ type: "tool_result", call_id: "call_1", name: "read", content: [{ type: "text", text: "code" }] }] },
  ];

  it("builds stateless input with replayed reasoning items", () => {
    const up = responsesAdapter.build({ model: "m", messages: history, system: "sys", metadata: { session_id: "s" } }, gpt);
    const b = up.body as any;
    expect(up.path).toBe("v1/responses");
    expect(b.model).toBe("gpt-5.5");
    expect(b.store).toBe(false);
    expect(b.instructions).toBe("sys");
    expect(b.prompt_cache_key).toBe("s");
    expect(b.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      reasoningItem,
      { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
      { type: "function_call_output", call_id: "call_1", output: "code" },
    ]);
    // "off" is each model's lowest setting.
    const off = (caps: ModelRow["capabilities"]) =>
      (responsesAdapter.build({ model: "m", messages: history, reasoning: { effort: "off" } }, { ...gpt, capabilities: caps }).body as any).reasoning.effort;
    expect(off({ reasoning: "effort", off: "low" })).toBe("low");
    expect(off({ reasoning: "effort", off: "none" })).toBe("none");
    expect(off({ reasoning: "effort" })).toBe("minimal");
    const other = responsesAdapter.build({ model: "m", messages: history }, { ...gpt, upstream_id: "gpt-6-luna" });
    expect((other.body as any).input).toHaveLength(3); // another model's reasoning item isn't replayed
  });

  it("parses the stream", () => {
    const p = responsesAdapter.parser(gpt);
    const out = run(p, [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
      { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Thinking" },
      { type: "response.output_item.done", output_index: 0, item: reasoningItem },
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "call_9", name: "grep" } },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"pattern":' },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: '"x"}' },
      { type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "call_9", name: "grep", arguments: '{"pattern":"x"}' } },
      { type: "response.completed", response: { usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 30 } } } },
    ]);
    expect(out.map((e) => e.event)).toEqual(["response.start", "block.start", "block.delta", "block.end", "block.start", "block.delta", "block.delta", "block.end"]);
    expect(out[3]!.data).toMatchObject({ index: 0, opaque: { provider: "openai", data: reasoningItem } });
    expect(out[7]!.data).toMatchObject({ index: 1, input: { pattern: "x" } });
    expect(p.result()).toEqual({ stop_reason: "tool_use", usage: { input_uncached: 100, cache_read: 600, cache_write: 300, output: 50, reasoning: 30 } });
  });
});

describe("chat completions adapter (xAI)", () => {
  it("builds an OpenAI-compatible request for the configured endpoint", () => {
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "what's this?" }, { type: "image", media_type: "image/png", data: "iVBO" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "hmm" },
          { type: "text", text: "Let me look." },
          { type: "tool_call", id: "call_1", name: "read", input: { path: "a" } },
        ],
      },
      { role: "tool", content: [{ type: "tool_result", call_id: "call_1", name: "read", content: [{ type: "text", text: "code" }], is_error: true }] },
    ];
    const up = chatAdapter.build(
      { model: "m", system: "sys", messages: history, reasoning: { effort: "off" }, metadata: { session_id: "s" }, tools: [{ name: "read", description: "Read", input_schema: { type: "object" } }] },
      grok,
    );
    const b = up.body as any;
    expect(up.path).toBe("v1/chat/completions");
    expect(b.model).toBe("grok-4.7");
    expect(b.stream).toBe(true);
    expect(b.reasoning_effort).toBe("low");
    expect(b.prompt_cache_key).toBeUndefined();
    expect(b.stream_options).toEqual({ include_usage: true });
    expect(b.tools[0]).toEqual({ type: "function", function: { name: "read", description: "Read", parameters: { type: "object" } } });
    expect(b.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "what's this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBO" } }] },
      { role: "assistant", content: "Let me look.", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "[error] code" },
    ]);
  });

  it("names open models by their exact API ID and maps their effort levels", () => {
    const user: Message[] = [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", media_type: "image/png", data: "iVBO" }] }];
    const textOnly: ModelRow = { ...base, provider: "moonshot", upstream_id: "kimi-k3", capabilities: { reasoning: "none", images: false } };
    const d = chatAdapter.build({ model: "m", messages: user, reasoning: { effort: "high" } }, textOnly);
    expect(d.path).toBe("v1/chat/completions");
    expect((d.body as any).model).toBe("kimi-k3");
    expect((d.body as any).reasoning_effort).toBeUndefined();
    // A model that can't read images gets a note instead of the image.
    expect((d.body as any).messages[0].content[1]).toEqual({ type: "text", text: "[An image was attached, but this model can't read images.]" });

    const glm: ModelRow = {
      ...base,
      provider: "zai",
      upstream_id: "zai/glm-5.3-flash",
      capabilities: { reasoning: "effort", levels: { off: "low", low: "low", medium: "high", high: "max" }, images: true },
    };
    const effort = (e: "off" | "low" | "medium" | "high") => (chatAdapter.build({ model: "m", messages: user, reasoning: { effort: e } }, glm).body as any).reasoning_effort;
    expect([effort("off"), effort("low"), effort("medium"), effort("high")]).toEqual(["low", "low", "high", "max"]);
    expect((chatAdapter.build({ model: "m", messages: user }, glm).body as any).messages[0].content[1].type).toBe("image_url");
  });

  it("parses Grok's stream (from its compatible API)", () => {
    const p = chatAdapter.parser(grok);
    const chunk = (delta: object, finish?: string) => ({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] });
    const out = run(p, [
      chunk({ role: "assistant", reasoning_content: "Need the file." }),
      chunk({ content: "Reading it." }),
      chunk({ tool_calls: [{ id: "call-8a6", function: { name: "read", arguments: '{"path":' }, index: 0, type: "function" }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }),
      chunk({}, "tool_calls"),
      {
        id: "c1",
        choices: [],
        usage: { prompt_tokens: 1332, completion_tokens: 10, total_tokens: 1363, prompt_tokens_details: { cached_tokens: 1152 }, completion_tokens_details: { reasoning_tokens: 21 } },
      },
    ]);
    expect(p.push(undefined, "[DONE]")).toEqual([]);
    expect(out).toEqual([
      { event: "response.start", data: { id: "c1", model: "m" } },
      { event: "block.start", data: { index: 0, type: "reasoning" } },
      { event: "block.delta", data: { index: 0, text: "Need the file." } },
      { event: "block.end", data: { index: 0 } },
      { event: "block.start", data: { index: 1, type: "text" } },
      { event: "block.delta", data: { index: 1, text: "Reading it." } },
      { event: "block.end", data: { index: 1 } },
      { event: "block.start", data: { index: 2, type: "tool_call", id: "call-8a6", name: "read" } },
      { event: "block.delta", data: { index: 2, partial_json: '{"path":' } },
      { event: "block.delta", data: { index: 2, partial_json: '"README.md"}' } },
      { event: "block.end", data: { index: 2, input: { path: "README.md" } } },
    ]);
    // Reasoning tokens are reported apart from completion tokens (1332 + 10 + 21 = 1363) and billed as output.
    expect(p.result()).toEqual({ stop_reason: "tool_use", usage: { input_uncached: 180, cache_read: 1152, cache_write: 0, output: 31, reasoning: 21 } });
  });
});

describe("Gemini through Chat Completions", () => {
  const gem: ModelRow = {
    ...base,
    provider: "google",
    upstream_id: "gemini-3.8-flash",
    capabilities: { reasoning: "effort", levels: { off: "low", low: "low", medium: "high", high: "high" }, images: true },
  };

  it("sends the configured ID, OpenAI-style tools and its thinking level as an effort", () => {
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      // A thought signature stored by the old Gemini-native adapter is simply not sent.
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "read", input: { path: "a" }, opaque: { provider: "google", model: "gemini-3.8-flash", data: { thoughtSignature: "SIG" } } }] },
      { role: "tool", content: [{ type: "tool_result", call_id: "c1", name: "read", content: [{ type: "text", text: "A" }] }] },
    ];
    const build = (effort: "off" | "low" | "medium" | "high") =>
      chatAdapter.build({ model: "m", messages: history, reasoning: { effort }, tools: [{ name: "read", description: "d", input_schema: { type: "object" } }] }, gem);
    const up = build("medium");
    const b = up.body as any;
    expect(up.path).toBe("v1/chat/completions");
    expect(b.model).toBe("gemini-3.8-flash");
    expect(b.tools).toEqual([{ type: "function", function: { name: "read", description: "d", parameters: { type: "object" } } }]);
    expect(b.messages[1]).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] });
    expect(["off", "low", "medium", "high"].map((e) => (build(e as "low").body as any).reasoning_effort)).toEqual(["low", "low", "high", "high"]);
  });

  it("streams `reasoning` deltas as reasoning", () => {
    const p = chatAdapter.parser(gem);
    const out = run(p, [
      { id: "g1", choices: [{ index: 0, delta: { role: "assistant", reasoning: "Plan." } }] },
      { id: "g1", choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] },
    ]);
    expect(out.map((e) => [e.event, (e.data as { type?: string }).type])).toEqual([
      ["response.start", undefined],
      ["block.start", "reasoning"],
      ["block.delta", undefined],
      ["block.end", undefined],
      ["block.start", "text"],
      ["block.delta", undefined],
      ["block.end", undefined],
    ]);
  });
});

describe("MiniMax", () => {
  const minimax: ModelRow = { ...base, provider: "minimax", upstream_id: "minimax-m3", capabilities: { reasoning: "none", images: true } };

  it("is an ordinary Chat Completions request: its exact ID, tools and no effort", () => {
    const up = chatAdapter.build({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], reasoning: { effort: "high" }, metadata: { session_id: "s" } }, minimax);
    const b = up.body as Record<string, unknown>;
    expect(up.path).toBe("v1/chat/completions");
    expect(b).toMatchObject({ model: "minimax-m3", stream: true });
    expect(b.reasoning_effort).toBeUndefined();
  });

  it("bills reasoning inside completion tokens", () => {
    const p = chatAdapter.parser(minimax);
    run(p, [
      { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }] },
      { id: "c1", choices: [], usage: { total_tokens: 485, prompt_tokens: 197, completion_tokens: 288, completion_tokens_details: { reasoning_tokens: 47 }, prompt_tokens_details: { cached_tokens: 149 } } },
    ]);
    expect(p.result()).toEqual({ stop_reason: "end_turn", usage: { input_uncached: 48, cache_read: 149, cache_write: 0, output: 288, reasoning: 47 } });
  });
});

describe("custom provider capabilities and errors", () => {
  it("omits images for text-only models on every supported format", () => {
    for (const adapter of [anthropic, responsesAdapter, chatAdapter]) {
      const upstream = adapter.build({ model: "m", messages: [{ role: "user", content: [{ type: "image", media_type: "image/png", data: "sensitive-image-data" }] }] }, { ...gpt, capabilities: { images: false, reasoning: "none" } });
      expect(JSON.stringify(upstream.body)).not.toContain("sensitive-image-data");
    }
  });
  it("does not expose arbitrary provider error messages", () => {
    const error = { message: "private-provider-key", code: "bad_request", type: "invalid_request_error" };
    for (const adapter of [anthropic, responsesAdapter, chatAdapter]) {
      const parser = adapter.parser(gpt);
      const events = parser.push("error", JSON.stringify({ type: "error", error }));
      expect(JSON.stringify(events)).not.toContain(error.message);
    }
  });
});
