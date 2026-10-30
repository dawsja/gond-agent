import type { Provider, ResponsesRequest, StopReason, StreamEvent, Usage } from "../wire";

interface Capabilities {
  /** adaptive: Anthropic adaptive thinking + effort. budget: Anthropic budget_tokens. effort: a reasoning effort (OpenAI, Chat Completions models). */
  reasoning?: "adaptive" | "budget" | "effort" | "none";
  /** How to honor effort "off" when thinking can't simply be disabled. */
  off?: "between_tools" | "low" | "none";
  /** The model's own reasoning_effort value for each of ours, where its names differ (Chat Completions). */
  levels?: Partial<Record<"off" | "low" | "medium" | "high", string>>;
  images?: boolean;
}

export interface ModelRow {
  id: string;
  provider: Provider;
  connection_id?: string;
  format?: "anthropic" | "openai" | "openai-responses";
  upstream_id: string;
  display_name: string;
  context_window: number;
  max_output: number;
  capabilities: Capabilities;
  input_micros: number;
  output_micros: number;
  cache_read_micros: number;
  cache_write_micros: number;
}

export interface UpstreamRequest {
  /** Path on the provider API: "v1/messages", "v1/responses" or "v1/chat/completions". */
  path: string;
  body: unknown;
  headers?: Record<string, string>;
}

/** Stateful translator from a provider's native SSE stream to Gond Agent stream events. */
export interface StreamParser {
  push(event: string | undefined, data: string): StreamEvent[];
  /** Final stop reason and usage once the upstream stream has completed, else null. */
  result(): { stop_reason: StopReason; usage: Usage } | null;
  /** Usage known so far, used to estimate cost when the stream is aborted. */
  partialUsage(): Usage;
  /** Characters of output streamed so far (for estimates). */
  outputChars(): number;
}

export interface Adapter {
  build(req: ResponsesRequest, model: ModelRow): UpstreamRequest;
  parser(model: ModelRow): StreamParser;
}
