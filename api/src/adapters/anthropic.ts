// Anthropic-compatible Messages API translator using native HTTP and SSE.
import type { Block, Message, Opaque, ResponsesRequest, StopReason, StreamEvent, Usage } from "../wire";
import { emptyUsage } from "../wire";
import type { Adapter, ModelRow, StreamParser, UpstreamRequest } from "./types";
import { maxOutput, parseArgs, sameModel } from "./common";

type ABlock = Record<string, unknown>;
interface AMessage {
  role: "user" | "assistant";
  content: ABlock[];
}

const BUDGET = { low: 2048, medium: 8000, high: 24000 } as const;

function own(o: Opaque | undefined, model: ModelRow): Record<string, unknown> | undefined {
  if (!o || o.provider !== "anthropic" || !sameModel(o.model, model)) return undefined;
  return (o.data ?? undefined) as Record<string, unknown> | undefined;
}

function convertBlock(b: Block, model: ModelRow): ABlock | null {
  switch (b.type) {
    case "text":
      return b.text ? { type: "text", text: b.text } : null;
    case "image":
      if (model.capabilities.images === false) return { type: "text", text: "[An image was attached, but this model cannot read images.]" };
      return { type: "image", source: { type: "base64", media_type: b.media_type, data: b.data } };
    case "reasoning": {
      // Thinking blocks only make sense replayed to the model that produced them.
      const d = own(b.opaque, model);
      if (!d) return null;
      if (d.redacted) return { type: "redacted_thinking", data: d.redacted };
      return { type: "thinking", thinking: b.text, signature: d.signature };
    }
    case "tool_call":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: b.call_id,
        is_error: b.is_error || undefined,
        content: b.content.map((p) =>
          p.type === "text"
            ? { type: "text", text: p.text || "(empty)" }
            : model.capabilities.images === false ? { type: "text", text: "[An image was returned, but this model cannot read images.]" } : { type: "image", source: { type: "base64", media_type: p.media_type, data: p.data } },
        ),
      };
  }
}

function toAnthropicMessages(messages: Message[], model: ModelRow): AMessage[] {
  const out: AMessage[] = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = m.content.map((b) => convertBlock(b, model)).filter((b): b is ABlock => b !== null);
    if (!content.length) continue;
    const last = out[out.length - 1];
    // Anthropic requires alternating roles; tool results and a following user message merge into one turn.
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  }
  return out;
}

export const anthropic: Adapter = {
  build(req: ResponsesRequest, model: ModelRow): UpstreamRequest {
    const messages = toAnthropicMessages(req.messages, model);
    // Cache breakpoints: tools, system, and the newest message (prefix grows append-only each turn).
    const lastMsg = messages[messages.length - 1];
    const lastBlock = lastMsg?.content[lastMsg.content.length - 1];
    if (lastBlock && lastBlock.type !== "thinking" && lastBlock.type !== "redacted_thinking") {
      lastBlock.cache_control = { type: "ephemeral" };
    }

    const tools = (req.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
    if (tools.length) (tools[tools.length - 1] as Record<string, unknown>).cache_control = { type: "ephemeral" };

    const body: Record<string, unknown> = {
      model: model.upstream_id,
      max_tokens: maxOutput(req, model),
      messages,
      stream: true,
    };
    if (req.system) body.system = [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }];
    if (tools.length) body.tools = tools;

    const effort = req.reasoning?.effort ?? "medium";
    const caps = model.capabilities;
    if (caps.reasoning === "adaptive" && effort !== "default") {
      if (effort === "off" && caps.off === "between_tools") {
        body.thinking = { type: "between_tools" };
      } else {
        body.thinking = { type: "adaptive", display: "summarized" };
        body.output_config = { effort: effort === "off" ? "low" : effort };
      }
    } else if (caps.reasoning === "budget" && effort !== "off" && effort !== "default") {
      const budget = Math.min(BUDGET[effort as keyof typeof BUDGET], (body.max_tokens as number) - 1024);
      if (budget >= 1024) body.thinking = { type: "enabled", budget_tokens: budget };
    }

    return { path: "v1/messages", body, headers: { "anthropic-version": "2023-06-01" } };
  },

  parser(model: ModelRow): StreamParser {
    return new AnthropicParser(model);
  },
};

const STOP: Record<string, StopReason> = {
  end_turn: "end_turn",
  stop_sequence: "end_turn",
  pause_turn: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
  model_context_window_exceeded: "context_exceeded",
};

interface OpenBlock {
  index: number;
  kind: "text" | "reasoning" | "tool_call";
  json: string;
  signature?: string;
  redacted?: string;
}

class AnthropicParser implements StreamParser {
  private usage: Usage = emptyUsage();
  private stop: StopReason | null = null;
  private done = false;
  private next = 0;
  private open = new Map<number, OpenBlock>();
  private chars = 0;

  constructor(private model: ModelRow) {}

  push(event: string | undefined, raw: string): StreamEvent[] {
    let d: Record<string, any>;
    try {
      d = JSON.parse(raw);
    } catch {
      return [];
    }
    const type = (event ?? d.type) as string;
    switch (type) {
      case "message_start": {
        this.applyUsage(d.message?.usage);
        return [{ event: "response.start", data: { id: d.message?.id ?? "", model: this.model.id } }];
      }
      case "content_block_start": {
        const cb = d.content_block ?? {};
        let kind: OpenBlock["kind"] | null = null;
        if (cb.type === "text") kind = "text";
        else if (cb.type === "thinking" || cb.type === "redacted_thinking") kind = "reasoning";
        else if (cb.type === "tool_use") kind = "tool_call";
        if (!kind) return []; // server-tool blocks etc. are not part of the worker format
        const ob: OpenBlock = { index: this.next++, kind, json: "" };
        if (cb.type === "redacted_thinking") ob.redacted = cb.data;
        this.open.set(d.index, ob);
        return [{ event: "block.start", data: { index: ob.index, type: kind, id: cb.id, name: cb.name } }];
      }
      case "content_block_delta": {
        const ob = this.open.get(d.index);
        const delta = d.delta ?? {};
        if (!ob) return [];
        if (delta.type === "text_delta") {
          this.chars += delta.text.length;
          return [{ event: "block.delta", data: { index: ob.index, text: delta.text } }];
        }
        if (delta.type === "thinking_delta") {
          this.chars += delta.thinking.length;
          return [{ event: "block.delta", data: { index: ob.index, text: delta.thinking } }];
        }
        if (delta.type === "signature_delta") {
          ob.signature = (ob.signature ?? "") + delta.signature;
          return [];
        }
        if (delta.type === "input_json_delta") {
          ob.json += delta.partial_json;
          this.chars += delta.partial_json.length;
          return [{ event: "block.delta", data: { index: ob.index, partial_json: delta.partial_json } }];
        }
        return [];
      }
      case "content_block_stop": {
        const ob = this.open.get(d.index);
        if (!ob) return [];
        this.open.delete(d.index);
        const end: { index: number; input?: Record<string, unknown>; opaque?: Opaque } = { index: ob.index };
        if (ob.kind === "tool_call") end.input = parseArgs(ob.json);
        if (ob.kind === "reasoning") {
          end.opaque = {
            provider: "anthropic",
            model: this.model.id,
            data: ob.redacted ? { redacted: ob.redacted } : { signature: ob.signature ?? "" },
          };
        }
        return [{ event: "block.end", data: end }];
      }
      case "message_delta": {
        if (d.delta?.stop_reason) this.stop = STOP[d.delta.stop_reason] ?? "end_turn";
        this.applyUsage(d.usage);
        return [];
      }
      case "message_stop":
        this.done = true;
        return [];
      case "error":
        return [
          {
            event: "error",
            data: {
              code: "provider_error",
              message: "The model provider reported an error.",
              retryable: d.error?.type === "overloaded_error" || d.error?.type === "rate_limit_error",
            },
          },
        ];
      default:
        return [];
    }
  }

  private applyUsage(u: Record<string, any> | undefined) {
    if (!u) return;
    if (typeof u.input_tokens === "number") this.usage.input_uncached = u.input_tokens;
    if (typeof u.cache_read_input_tokens === "number") this.usage.cache_read = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") this.usage.cache_write = u.cache_creation_input_tokens;
    if (typeof u.output_tokens === "number") this.usage.output = u.output_tokens;
    const thinking = u.output_tokens_details?.thinking_tokens;
    if (typeof thinking === "number") this.usage.reasoning = thinking;
  }

  result() {
    return this.done ? { stop_reason: this.stop ?? "end_turn", usage: { ...this.usage } } : null;
  }

  partialUsage(): Usage {
    return { ...this.usage };
  }

  outputChars(): number {
    return this.chars;
  }
}
