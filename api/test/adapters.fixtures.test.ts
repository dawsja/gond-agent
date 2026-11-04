// Each adapter against streams in the providers' documented SSE formats (test/fixtures/streams),
// fed in small chunks the way they arrive over the network.
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/db";
import { saveProviderSettings } from "../src/providers";
import { modelResponse } from "../src/responses";
import { anthropic } from "../src/adapters/anthropic";
import { chatAdapter } from "../src/adapters/chat";
import { responsesAdapter } from "../src/adapters/responses";
import { providerFailure } from "../src/adapters/errors";
import { agentModel, knownImages, knownReasoning } from "../src/effort";
import { providerFor } from "../src/models";
import { parseSse } from "../src/lib/sse";
import type { Adapter, ModelRow } from "../src/adapters/types";
import type { Message, StreamEvent } from "../src/wire";

const row = (provider: ModelRow["provider"], upstream: string, capabilities: ModelRow["capabilities"] = { reasoning: "none" }): ModelRow => ({
  id: `c:${upstream}`, provider, connection_id: "c", upstream_id: upstream, display_name: upstream, context_window: 200_000, max_output: 32_000,
  capabilities, input_micros: 0, output_micros: 0, cache_read_micros: 0, cache_write_micros: 0,
});
async function replay(adapter: Adapter, model: ModelRow, fixture: string) {
  const bytes = readFileSync(join(import.meta.dirname, "fixtures/streams", fixture));
  const body = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.subarray(i, i + 7)); c.close(); } });
  const parser = adapter.parser(model), events: StreamEvent[] = [];
  for await (const record of parseSse(body)) events.push(...parser.push(record.event, record.data));
  return { events, result: parser.result() };
}
const kinds = (events: StreamEvent[]) => events.map(e => e.event);
const conversation: Message[] = [
  { role: "user", content: [{ type: "text", text: "Fix the test" }, { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" }] },
  { role: "assistant", content: [{ type: "tool_call", id: "call_1", name: "read", input: { path: "a.ts" } }] },
  { role: "tool", content: [{ type: "tool_result", call_id: "call_1", name: "read", content: [{ type: "text", text: "code" }, { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" }] }] },
];
const tools = [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }];

describe("OpenAI Responses", () => {
  it("streams reasoning summaries, tool calls and cached usage", async () => {
    const { events, result } = await replay(responsesAdapter, row("openai", "gpt-5.5", { reasoning: "effort" }), "openai-responses-tool.sse");
    expect(kinds(events)).toEqual(["response.start", "block.start", "block.delta", "block.end", "block.start", "block.delta", "block.delta", "block.end"]);
    expect(events[4]!.data).toMatchObject({ type: "tool_call", id: "call_Ab1", name: "grep" });
    expect(events[7]!.data).toMatchObject({ input: { pattern: "TODO" } });
    expect(events[3]!.data).toMatchObject({ opaque: { provider: "openai", data: { encrypted_content: "gAAAAABo-enc" } } });
    expect(result).toEqual({ stop_reason: "tool_use", usage: { input_uncached: 1024, cache_read: 4096, cache_write: 0, output: 210, reasoning: 128 } });
  });
  it("builds requests with tools, images, effort and a cache key", () => {
    const body = responsesAdapter.build({ model: "m", system: "sys", messages: conversation, tools, reasoning: { effort: "high" }, metadata: { session_id: "s" } }, row("openai", "gpt-5.5", { reasoning: "effort", images: true })).body as Record<string, any>;
    expect(body).toMatchObject({ store: false, stream: true, instructions: "sys", max_output_tokens: 32000, prompt_cache_key: "s", reasoning: { effort: "high", summary: "auto" }, include: ["reasoning.encrypted_content"] });
    expect(body.tools).toEqual([{ type: "function", name: "read", description: "Read a file", parameters: tools[0]!.input_schema, strict: false }]);
    expect(body.input[0].content[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" });
    expect(body.input.at(-1)).toEqual({ role: "user", content: [{ type: "input_text", text: "Images returned by the tool:" }, { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }] });
  });
  it("turns a failed response into a retryable plain error", async () => {
    const { events, result } = await replay(responsesAdapter, row("openai", "gpt-5.5"), "openai-responses-failed.sse");
    expect(events.at(-1)).toEqual({ event: "error", data: { code: "provider_rate_limit", message: "The provider is limiting requests right now. Gond Agent will retry shortly.", retryable: true } });
    expect(result).toBeNull();
  });
});

describe("xAI through OpenAI-compatible connections", () => {
  it("is recognised by its API host and maps effort only where Grok accepts it", () => {
    expect(providerFor({ format: "openai-responses", baseURL: "https://api.x.ai/v1" })).toBe("xai");
    expect(providerFor({ format: "openai", baseURL: "https://proxy.example/v1" })).toBe("openai");
    expect(knownReasoning("openai", "grok-3-mini")).toEqual({ reasoning: "effort", efforts: ["low", "high"] });
    expect(knownReasoning("openai-responses", "grok-4")).toEqual({ reasoning: "none" });
    const grok = row("xai", "grok-3-mini", { reasoning: "effort", efforts: ["low", "high"] });
    const responses = responsesAdapter.build({ model: "m", messages: conversation, reasoning: { effort: "high" }, metadata: { session_id: "s" } }, grok).body as Record<string, any>;
    expect(responses.reasoning).toEqual({ effort: "high" });
    expect(responses).not.toHaveProperty("prompt_cache_key");
    expect((chatAdapter.build({ model: "m", messages: conversation, reasoning: { effort: "low" } }, grok).body as Record<string, any>).reasoning_effort).toBe("low");
    expect((chatAdapter.build({ model: "m", messages: conversation, reasoning: { effort: "high" } }, row("xai", "grok-4")).body as Record<string, any>)).not.toHaveProperty("reasoning_effort");
  });
  it("streams Responses text and Chat Completions reasoning with reasoning tokens counted as output", async () => {
    const text = await replay(responsesAdapter, row("xai", "grok-4"), "xai-responses-text.sse");
    expect(text.events.filter(e => e.event === "block.delta").map(e => (e.data as { text: string }).text).join("")).toBe("All tests pass.");
    expect(text.result).toEqual({ stop_reason: "end_turn", usage: { input_uncached: 900, cache_read: 0, cache_write: 0, output: 12, reasoning: 0 } });
    const chat = await replay(chatAdapter, row("xai", "grok-3-mini"), "xai-chat-reasoning.sse");
    expect(chat.events.filter(e => e.event === "block.start").map(e => (e.data as { type: string }).type)).toEqual(["reasoning", "text"]);
    expect(chat.result).toEqual({ stop_reason: "end_turn", usage: { input_uncached: 800, cache_read: 0, cache_write: 0, output: 300, reasoning: 260 } });
  });
});

describe("OpenAI Chat Completions and compatible proxies", () => {
  it("streams indexed tool calls and the trailing usage chunk", async () => {
    const { events, result } = await replay(chatAdapter, row("openai", "gpt-4.1"), "openai-chat-tool.sse");
    expect(events.find(e => e.event === "block.start")!.data).toMatchObject({ type: "tool_call", id: "call_q1", name: "read" });
    expect(events.find(e => e.event === "block.end")!.data).toMatchObject({ input: { path: "src/app.ts" } });
    expect(result).toEqual({ stop_reason: "tool_use", usage: { input_uncached: 476, cache_read: 1024, cache_write: 0, output: 22, reasoning: 0 } });
  });
  it("separates tool calls from servers that omit the index", async () => {
    const { events, result } = await replay(chatAdapter, row("openai", "gemini-3-pro"), "proxy-chat-indexless-tools.sse");
    expect(events.filter(e => e.event === "block.end").map(e => (e.data as { input: unknown }).input)).toEqual([{ path: "a.ts" }, { path: "b.ts" }]);
    expect(result?.stop_reason).toBe("tool_use");
  });
  it("reports context overflow plainly and sends images and tool results in Chat format", async () => {
    const { events } = await replay(chatAdapter, row("openai", "gpt-4.1"), "chat-context-error.sse");
    expect(events.at(-1)).toEqual({ event: "error", data: { code: "context_exceeded", message: "The conversation is too long for this model.", retryable: false } });
    const body = chatAdapter.build({ model: "m", system: "sys", messages: conversation, tools }, row("openai", "gpt-4.1", { reasoning: "none", images: true })).body as Record<string, any>;
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(body.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } });
    expect(body.tools[0]).toEqual({ type: "function", function: { name: "read", description: "Read a file", parameters: tools[0]!.input_schema } });
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe("Anthropic Messages", () => {
  it("streams signed thinking, tool input and cache usage", async () => {
    const { events, result } = await replay(anthropic, row("anthropic", "claude-sonnet-4-6", { reasoning: "adaptive" }), "anthropic-tool.sse");
    expect(kinds(events)).toEqual(["response.start", "block.start", "block.delta", "block.end", "block.start", "block.delta", "block.delta", "block.end"]);
    expect(events[3]!.data).toMatchObject({ opaque: { provider: "anthropic", data: { signature: "EqQBCkgIARAB" } } });
    expect(events[7]!.data).toMatchObject({ input: { path: "test/a.test.ts", old: "./b", new: "./a" } });
    expect(result).toEqual({ stop_reason: "tool_use", usage: { input_uncached: 12, cache_read: 8192, cache_write: 2048, output: 96, reasoning: 0 } });
  });
  it("maps effort to adaptive or budget thinking and reports overload as retryable", async () => {
    const adaptive = anthropic.build({ model: "m", messages: conversation, tools, reasoning: { effort: "max" } }, row("anthropic", "claude-opus-4-7", { reasoning: "adaptive", images: true })).body as Record<string, any>;
    expect(adaptive).toMatchObject({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "max" } });
    expect(adaptive.messages[0].content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } });
    const budget = anthropic.build({ model: "m", messages: conversation, reasoning: { effort: "medium" } }, row("anthropic", "claude-sonnet-4-5", { reasoning: "budget" })).body as Record<string, any>;
    expect(budget.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    const { events } = await replay(anthropic, row("anthropic", "claude-sonnet-4-6"), "anthropic-overloaded.sse");
    expect(events.at(-1)).toEqual({ event: "error", data: { code: "provider_unavailable", message: "The model provider is unavailable right now. Gond Agent will retry shortly.", retryable: true } });
  });
});

describe("provider errors, discovery and capabilities", () => {
  it.each([
    [401, { error: { code: "invalid_api_key", message: "Incorrect API key provided: sk-proj-abc" } }, "provider_auth", false],
    [400, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum" } }, "context_exceeded", false],
    [400, { error: { code: "context_length_exceeded" } }, "context_exceeded", false],
    [400, { error: { code: "prompt_too_long" } }, "context_exceeded", false],
    [400, { error: { code: "max_context_length_exceeded" } }, "context_exceeded", false],
    [400, { error: { code: "invalid_argument", message: "Prompt length exceeds the maximum number of tokens" } }, "context_exceeded", false],
    [429, { error: { code: "insufficient_quota", message: "You exceeded your current quota" } }, "provider_quota", false],
    [429, { error: { type: "rate_limit_error", message: "Too many requests" } }, "provider_rate_limit", true],
    [429, { error: { message: "Too many tokens: maximum number of tokens per minute reached" } }, "provider_rate_limit", true],
    [400, { error: { code: "rate_limit_exceeded", message: "maximum context length: rate limit reached" } }, "provider_rate_limit", true],
    [0, { error: { code: "rate_limit_error", message: "Too many tokens" } }, "provider_rate_limit", true],
    [429, { error: { code: "context_exceeded", message: "maximum context length" } }, "provider_rate_limit", true],
    [400, { error: { code: "invalid_request_error", message: "max_tokens exceeds the maximum number of tokens" } }, "provider_request", false],
    [400, { error: { message: "max_output_tokens is too large for this model's context window" } }, "provider_request", false],
    [400, { error: { message: "max_completion_tokens is too large for this model's context window" } }, "provider_request", false],
    [503, { error: { message: "prompt is too long" } }, "provider_unavailable", true],
    [529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "provider_unavailable", true],
    [404, { error: { code: "model_not_found" } }, "provider_model", false],
    [400, { error: { message: "Unsupported parameter" } }, "provider_request", false],
  ])("maps HTTP %i errors without echoing provider text", (status, body, code, retryable) => {
    const error = providerFailure(status, body);
    expect(error).toMatchObject({ code, retryable });
    expect(error.message).not.toMatch(/sk-proj|210000|Unsupported parameter/);
  });
  it("hides non-chat models from official catalogs and knows multimodal families", () => {
    const listed = ["gpt-5.5", "text-embedding-3-large", "tts-1", "whisper-1", "dall-e-3", "gpt-image-1", "omni-moderation-latest", "gpt-4o-realtime-preview", "o3"];
    expect(listed.filter(id => agentModel("https://api.openai.com/v1", id))).toEqual(["gpt-5.5", "o3"]);
    expect(["grok-4", "grok-2-image-1212"].filter(id => agentModel("https://api.x.ai/v1", id))).toEqual(["grok-4"]);
    expect(agentModel("https://proxy.example/v1", "my-embedding-router")).toBe(true);
    expect(["gpt-5.5", "gpt-4o-mini", "o4-mini", "grok-4", "claude-sonnet-4-6"].map(id => knownImages(id.startsWith("claude") ? "anthropic" : "openai", id))).toEqual([true, true, true, true, true]);
    expect(["gpt-3.5-turbo", "o1-mini", "grok-3-mini", "custom"].map(id => knownImages("openai", id))).toEqual([false, false, false, false]);
  });
});

describe("model relay errors", () => {
  it("returns the provider failure to the runner as a plain JSON error instead of a bare 502", async () => {
    const server = createServer((_req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "invalid_api_key", message: "Incorrect API key provided: sk-secret-1234" } })); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const dir = mkdtempSync(join(tmpdir(), "gond-relay-")), db = openStore(dir), secret = "d".repeat(40);
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args.join(" ")); });
    try {
      saveProviderSettings(db, secret, { connections: [{ id: "p", name: "P", format: "openai", baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: "sk-secret-1234", discover: false, models: [{ id: "gpt-4.1", name: "GPT", contextWindow: 128000, maxOutput: 8192, reasoning: "none", images: true }] }] });
      const response = await modelResponse(db, secret, "u", "r", new Request("http://worker/v1/responses", { method: "POST", body: JSON.stringify({ model: "p:gpt-4.1", messages: conversation.slice(0, 1) }) }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "provider_auth", message: "The provider rejected the API key. An administrator can update it in Settings → Models.", retryable: false } });
      expect(logged).toEqual(["model request failed 401 provider_auth"]);
    } finally {
      vi.restoreAllMocks();
      db.close(); rmSync(dir, { recursive: true, force: true });
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
