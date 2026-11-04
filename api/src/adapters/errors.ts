import { modelFailure, retryAfterMs } from "../model-errors";
import type { ApiError, StreamEvent } from "../wire";

export function providerStreamFailure(body: Record<string, any>): StreamEvent {
  const { code } = errorParts(body), failure = providerFailure(0, body);
  const detail = body.error ?? body.response?.error ?? body;
  const retry = retryAfterMs(String(detail.retry_after ?? ""));
  const reset = Number(detail.reset_at ?? detail.resets_at ?? (Number.isFinite(detail.resets_in_seconds) ? Date.now() / 1000 + detail.resets_in_seconds : undefined));
  return { event: "error", data: {
    // Subscription codes are consumed and normalized by the relay, never sent as public prose.
    code: code && /^(subscription_sharing_|chatpass_)/.test(code) ? code : failure.code,
    message: failure.message, retryable: failure.retryable,
    ...(retry === undefined ? {} : { retry_after_ms: retry }),
    ...(Number.isFinite(reset) && reset > 0 && reset < 253402300800 ? { reset_at: reset } : {}),
  } };
}

/** The machine-readable code and message of an OpenAI, Anthropic or compatible error body. */
export function errorParts(body: unknown): { code?: string; message: string } {
  const b = body as { error?: unknown; response?: { error?: unknown } } | null;
  const e = (b?.error ?? b?.response?.error ?? b) as { code?: unknown; type?: unknown; message?: unknown } | string | null | undefined;
  if (typeof e === "string") return { code: e, message: "" };
  const code = typeof e?.code === "string" ? e.code : typeof e?.type === "string" ? e.type : undefined;
  return { code, message: typeof e?.message === "string" ? e.message : "" };
}

/** A plain message for an API connection's failure. Provider bodies stay in server logs. */
export function providerFailure(status: number, body: unknown): ApiError {
  const { code, message } = errorParts(body);
  const rateLimit = status === 429 || /rate_?limit/i.test(code ?? "");
  const outputLimit = /max_(tokens|output_tokens|completion_tokens)/i.test(`${code ?? ""} ${message}`);
  // Preserve rate/output errors before the relay can relabel them as context overflow.
  // SSE errors have no HTTP status and need an explicit context code.
  if (!rateLimit && !outputLimit && !/quota/i.test(code ?? "")
    && (["context_exceeded", "context_length_exceeded", "model_context_window_exceeded", "prompt_too_long", "max_context_length_exceeded"].includes((code ?? "").toLowerCase())
      || (status === 400 && /prompt is too long|maximum context|context length|context window|prompt length exceeds/i.test(message))))
    return modelFailure(400, "context_exceeded");
  if (/usage_limit/i.test(code ?? "")) return modelFailure(429, "provider_usage_limit");
  if (status === 402 || /quota|billing|credit_balance/i.test(code ?? "")
    || /insufficient (?:credit|quota)|exceeded (?:your )?current quota|credit balance.*(?:low|exhaust)|billing (?:hard )?limit|payment required|out of credit/i.test(message))
    return modelFailure(402, "provider_quota");
  if (status === 401 || code === "authentication_error" || code === "invalid_api_key")
    return modelFailure(401, "provider_auth");
  if (status === 403 || code === "permission_error")
    return modelFailure(403, "provider_forbidden");
  if (status === 404 || code === "not_found_error" || code === "model_not_found")
    return modelFailure(404, "provider_model");
  if (rateLimit)
    return modelFailure(429, "provider_rate_limit");
  if (status === 529 || status >= 500 || code === "overloaded_error" || code === "overloaded" || code === "server_error" || code === "api_error")
    return modelFailure(status >= 500 && status <= 599 ? status : 503, "provider_unavailable");
  if (status === 400 || status === 422 || code === "invalid_request_error")
    return modelFailure(400, "provider_request");
  return modelFailure(502, "provider_error");
}
