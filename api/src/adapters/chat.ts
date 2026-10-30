// OpenAI-compatible Chat Completions translator. Reasoning is not replayed.
import type { Block, Message, ResponsesRequest, StopReason, StreamEvent, Usage } from "../wire";
import { emptyUsage } from "../wire";
import type { Adapter, ModelRow, StreamParser, UpstreamRequest } from "./types";
import { dataUrl, maxOutput, parseArgs } from "./common";

type Msg = Record<string, unknown>;


/** For models that can't read images: say one was attached instead of failing the request. */
const NO_IMAGE: Msg = { type: "text", text: "[An image was attached, but this model can't read images.]" };

function toMessages(messages: Message[], system?: string, images = true): Msg[] {
  const out: Msg[] = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (m.role === "user") {
      const content = m.content.flatMap((b): Msg[] => {
        if (b.type === "text") return [{ type: "text", text: b.text }];
        if (b.type === "image") return [images ? { type: "image_url", image_url: { url: dataUrl(b.media_type, b.data) } } : NO_IMAGE];
        return [];
      });
      if (content.length) out.push({ role: "user", content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const calls = m.content.flatMap((b) =>
        b.type === "tool_call" ? [{ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }] : [],
      );
      if (!text && !calls.length) continue;
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // tool results; images go in a follow-up user message since tool output is text
    const toolImages: Msg[] = [];
    for (const b of m.content as Block[]) {
      if (b.type !== "tool_result") continue;
      const text = b.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
      for (const p of b.content) if (p.type === "image") toolImages.push({ type: "image_url", image_url: { url: dataUrl(p.media_type, p.data) } });
      out.push({ role: "tool", tool_call_id: b.call_id, content: (b.is_error ? "[error] " : "") + (text || "(no output)") });
    }
    if (toolImages.length && images) out.push({ role: "user", content: [{ type: "text", text: "Images returned by the tool:" }, ...toolImages] });
  }
  return out;
}

export const chatAdapter: Adapter = {
  build(req: ResponsesRequest, model: ModelRow): UpstreamRequest {
    const body: Record<string, unknown> = {
      model: model.upstream_id,
      messages: toMessages(req.messages, req.system, model.capabilities.images !== false),
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: maxOutput(req, model),
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } }));
    }
    if (model.capabilities.reasoning === "effort") {
      const effort = req.reasoning?.effort ?? "medium";
      body.reasoning_effort = model.capabilities.levels?.[effort] ?? (effort === "off" ? (model.capabilities.off ?? "low") : effort);
    }
    return { path: "v1/chat/completions", body };
  },
  parser(model: ModelRow): StreamParser {
    return new ChatParser(model);
  },
};

interface Open {
  index: number;
  kind: "text" | "reasoning" | "tool_call";
  json: string;
}

class ChatParser implements StreamParser {
  private usage: Usage = emptyUsage();
  private done: { stop: StopReason } | null = null;
  private started = false;
  private next = 0;
  /** The text or reasoning block being streamed. */
  private flow: Open | null = null;
  /** Tool calls by their index in the choice. */
  private calls = new Map<number, Open>();
  private chars = 0;
  constructor(private model: ModelRow) {}

  push(_event: string | undefined, raw: string): StreamEvent[] {
    let d: Record<string, any>;
    try {
      d = JSON.parse(raw);
    } catch {
      return []; // "[DONE]"
    }
    if (d.error) {
      const e = d.error;
      return [{ event: "error", data: { code: "provider_error", message: "The model provider reported an error.", retryable: /rate|overload|server/i.test(String(e.code ?? e.type ?? "")) } }];
    }
    const out: StreamEvent[] = [];
    if (!this.started) {
      this.started = true;
      out.push({ event: "response.start", data: { id: d.id ?? "", model: this.model.id } });
    }
    if (d.usage) this.applyUsage(d.usage);
    const choice = d.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta ?? {};
    // Compatible APIs use either `reasoning` or `reasoning_content` for reasoning deltas.
    const reasoning = delta.reasoning ?? delta.reasoning_content;
    if (typeof reasoning === "string" && reasoning) out.push(...this.stream("reasoning", reasoning));
    if (typeof delta.content === "string" && delta.content) out.push(...this.stream("text", delta.content));
    for (const tc of (delta.tool_calls ?? []) as Record<string, any>[]) {
      let o = this.calls.get(tc.index ?? 0);
      if (!o) {
        out.push(...this.closeFlow());
        o = { index: this.next++, kind: "tool_call", json: "" };
        this.calls.set(tc.index ?? 0, o);
        out.push({ event: "block.start", data: { index: o.index, type: "tool_call", id: tc.id, name: tc.function?.name } });
      }
      const args = tc.function?.arguments;
      if (typeof args === "string" && args) {
        o.json += args;
        this.chars += args.length;
        out.push({ event: "block.delta", data: { index: o.index, partial_json: args } });
      }
    }
    if (choice.finish_reason) {
      out.push(...this.closeFlow());
      for (const o of this.calls.values()) out.push({ event: "block.end", data: { index: o.index, input: parseArgs(o.json) } });
      const r = choice.finish_reason as string;
      const stop: StopReason =
        r === "tool_calls" || this.calls.size ? "tool_use" : r === "length" ? "max_tokens" : r === "content_filter" ? "refusal" : "end_turn";
      this.calls.clear();
      this.done = { stop };
    }
    return out;
  }

  private stream(kind: "text" | "reasoning", text: string): StreamEvent[] {
    const out: StreamEvent[] = [];
    if (this.flow?.kind !== kind) {
      out.push(...this.closeFlow());
      this.flow = { index: this.next++, kind, json: "" };
      out.push({ event: "block.start", data: { index: this.flow.index, type: kind } });
    }
    this.chars += text.length;
    out.push({ event: "block.delta", data: { index: this.flow.index, text } });
    return out;
  }

  private closeFlow(): StreamEvent[] {
    if (!this.flow) return [];
    const end: StreamEvent = { event: "block.end", data: { index: this.flow.index } };
    this.flow = null;
    return [end];
  }

  /** prompt_tokens includes the cached ones; reasoning tokens are billed as output but counted apart. */
  private applyUsage(u: Record<string, any>) {
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
    const completion = u.completion_tokens ?? 0;
    const total = u.total_tokens ?? 0;
    // Some providers fold reasoning into completion_tokens, others don't: total tells which.
    const separate = total >= (u.prompt_tokens ?? 0) + completion + reasoning && reasoning > 0;
    this.usage = {
      input_uncached: Math.max(0, (u.prompt_tokens ?? 0) - cached),
      cache_read: cached,
      cache_write: 0,
      output: separate ? completion + reasoning : completion,
      reasoning,
    };
  }

  result() {
    return this.done ? { stop_reason: this.done.stop, usage: { ...this.usage } } : null;
  }
  partialUsage() {
    return { ...this.usage };
  }
  outputChars() {
    return this.chars;
  }
}
