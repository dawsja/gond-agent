// Gond Agent wire format v1. Spec: protocol/README.md. Mirrored in runner/src/api/wire.rs.

/** Model protocol families and maker labels. */
export type Provider = "anthropic" | "openai" | "xai" | "google" | "moonshot" | "qwen" | "zai" | "minimax";

export interface Opaque {
  provider: Provider;
  model: string;
  data: unknown;
}

export type ResultPart = { type: "text"; text: string } | { type: "image"; media_type: string; data: string };

export type Block =
  | { type: "text"; text: string; opaque?: Opaque }
  | { type: "reasoning"; text: string; opaque?: Opaque }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown>; opaque?: Opaque }
  | { type: "tool_result"; call_id: string; name: string; content: ResultPart[]; is_error?: boolean }
  /** `data` (base64), or `id`: an image uploaded to /v1/images, filled in before the model call. */
  | { type: "image"; media_type: string; data: string; id?: string };

export interface Message {
  role: "user" | "assistant" | "tool";
  content: Block[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type Effort = "default" | "off" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ResponsesRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolDef[];
  max_output_tokens?: number;
  reasoning?: { effort: Effort };
  metadata?: { session_id?: string; agent_id?: string };
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "context_exceeded";

export interface Usage {
  input_uncached: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
}

export type StreamEvent =
  | { event: "response.start"; data: { id: string; model: string } }
  | { event: "block.start"; data: { index: number; type: "text" | "reasoning" | "tool_call"; id?: string; name?: string } }
  | { event: "block.delta"; data: { index: number; text?: string; partial_json?: string } }
  | { event: "block.end"; data: { index: number; input?: Record<string, unknown>; opaque?: Opaque } }
  | { event: "response.end"; data: { stop_reason: StopReason; usage: Usage } }
  | { event: "error"; data: { code: string; message: string; retryable: boolean } };

export const emptyUsage = (): Usage => ({ input_uncached: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 });

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
