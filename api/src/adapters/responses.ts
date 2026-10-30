// OpenAI Responses API translator. Requests are stateless and replay opaque reasoning.
import type { Block, Message, Opaque, Provider, ResponsesRequest, StopReason, StreamEvent, Usage } from "../wire";
import { emptyUsage } from "../wire";
import type { Adapter, ModelRow, StreamParser, UpstreamRequest } from "./types";
import { dataUrl, maxOutput, parseArgs, sameModel } from "./common";

type Item = Record<string, unknown>;

function own(o: Opaque | undefined, model: ModelRow): Item | undefined {
  if (!o || o.provider !== model.provider || !sameModel(o.model, model)) return undefined;
  return o.data as Item;
}

function toInput(messages: Message[], model: ModelRow): Item[] {
  const input: Item[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const content = m.content.flatMap((b): Item[] => {
        if (b.type === "text") return [{ type: "input_text", text: b.text }];
        if (b.type === "image") return model.capabilities.images === false ? [{ type: "input_text", text: "[An image was attached, but this model cannot read images.]" }] : [{ type: "input_image", image_url: dataUrl(b.media_type, b.data) }];
        return [];
      });
      if (content.length) input.push({ role: "user", content });
      continue;
    }
    if (m.role === "assistant") {
      for (const b of m.content) {
        const item = own((b as { opaque?: Opaque }).opaque, model);
        if (b.type === "reasoning") {
          if (item) input.push(item); // other providers' reasoning can't be replayed
        } else if (b.type === "text") {
          input.push(item ?? { type: "message", role: "assistant", content: [{ type: "output_text", text: b.text }] });
        } else if (b.type === "tool_call") {
          input.push(item ?? { type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
        }
      }
      continue;
    }
    // tool results; images go in a follow-up user message since function output is text
    const images: Item[] = [];
    for (const b of m.content as Block[]) {
      if (b.type !== "tool_result") continue;
      const text = b.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
      for (const p of b.content) if (p.type === "image" && model.capabilities.images !== false) images.push({ type: "input_image", image_url: dataUrl(p.media_type, p.data) });
      input.push({ type: "function_call_output", call_id: b.call_id, output: (b.is_error ? "[error] " : "") + (text || "(no output)") });
    }
    if (images.length) input.push({ role: "user", content: [{ type: "input_text", text: "Images returned by the tool:" }, ...images] });
  }
  return input;
}

export const responsesAdapter: Adapter = {
  build(req: ResponsesRequest, model: ModelRow): UpstreamRequest {
    const body: Record<string, unknown> = {
      model: model.upstream_id,
      input: toInput(req.messages, model),
      store: false,
      stream: true,
      max_output_tokens: maxOutput(req, model),
    };
    if (req.system) body.instructions = req.system;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema, strict: false }));
    }
    if (model.capabilities.reasoning === "effort" && req.reasoning?.effort !== "default") {
      const effort = req.reasoning?.effort ?? "medium";
      // "off" is each model's lowest setting: "none" where reasoning can be turned off, "low" where it can't.
      const off = model.capabilities.off === "low" || model.capabilities.off === "none" ? model.capabilities.off : "minimal";
      body.reasoning = { effort: effort === "off" ? off : effort, summary: "auto" };
      body.include = ["reasoning.encrypted_content"];
    }
    if (model.provider === "openai" && req.metadata?.session_id) body.prompt_cache_key = req.metadata.session_id;
    return { path: "v1/responses", body };
  },
  parser(model: ModelRow): StreamParser {
    return new ResponsesParser(model);
  },
};

interface Open {
  index: number;
  kind: "text" | "reasoning" | "tool_call";
  json: string;
}

class ResponsesParser implements StreamParser {
  private usage: Usage = emptyUsage();
  private done: { stop: StopReason } | null = null;
  private next = 0;
  private open = new Map<number, Open>();
  private sawTool = false;
  private chars = 0;
  constructor(private model: ModelRow) {}

  push(_event: string | undefined, raw: string): StreamEvent[] {
    let d: Record<string, any>;
    try {
      d = JSON.parse(raw);
    } catch {
      return [];
    }
    switch (d.type as string) {
      case "response.created":
        return [{ event: "response.start", data: { id: d.response?.id ?? "", model: this.model.id } }];
      case "response.output_item.added": {
        const item = d.item ?? {};
        const kind = item.type === "message" ? "text" : item.type === "reasoning" ? "reasoning" : item.type === "function_call" ? "tool_call" : null;
        if (!kind) return [];
        const o: Open = { index: this.next++, kind, json: "" };
        this.open.set(d.output_index, o);
        if (kind === "tool_call") this.sawTool = true;
        return [{ event: "block.start", data: { index: o.index, type: kind, id: item.call_id, name: item.name } }];
      }
      case "response.output_text.delta":
      case "response.refusal.delta":
      case "response.reasoning_summary_text.delta": {
        const o = this.open.get(d.output_index);
        if (!o || typeof d.delta !== "string") return [];
        this.chars += d.delta.length;
        return [{ event: "block.delta", data: { index: o.index, text: d.delta } }];
      }
      case "response.function_call_arguments.delta": {
        const o = this.open.get(d.output_index);
        if (!o) return [];
        o.json += d.delta;
        this.chars += d.delta.length;
        return [{ event: "block.delta", data: { index: o.index, partial_json: d.delta } }];
      }
      case "response.output_item.done": {
        const o = this.open.get(d.output_index);
        if (!o) return [];
        this.open.delete(d.output_index);
        const item = d.item ?? {};
        const opaque: Opaque = { provider: this.model.provider as Provider, model: this.model.id, data: item };
        const end: { index: number; input?: Record<string, unknown>; opaque?: Opaque } = { index: o.index, opaque };
        if (o.kind === "tool_call") end.input = parseArgs(item.arguments ?? o.json);
        return [{ event: "block.end", data: end }];
      }
      case "response.completed":
      case "response.incomplete": {
        this.applyUsage(d.response?.usage);
        const reason = d.response?.incomplete_details?.reason;
        const stop: StopReason =
          d.type === "response.completed"
            ? this.sawTool
              ? "tool_use"
              : "end_turn"
            : reason === "max_output_tokens"
              ? "max_tokens"
              : reason === "content_filter"
                ? "refusal"
                : "end_turn";
        this.done = { stop };
        return [];
      }
      case "response.failed":
      case "error": {
        const err = d.response?.error ?? d.error ?? d;
        return [{ event: "error", data: { code: "provider_error", message: "The model provider reported an error.", retryable: /rate|overload|server/i.test(String(err.code ?? "")) } }];
      }
      default:
        return [];
    }
  }

  private applyUsage(u: Record<string, any> | undefined) {
    if (!u) return;
    // input_tokens includes both cache reads and cache writes (newer models bill writes separately).
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    const written = u.input_tokens_details?.cache_write_tokens ?? 0;
    this.usage = {
      input_uncached: Math.max(0, (u.input_tokens ?? 0) - cached - written),
      cache_read: cached,
      cache_write: written,
      output: u.output_tokens ?? 0,
      reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
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
