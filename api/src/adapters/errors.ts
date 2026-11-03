import { ApiError } from "../wire";

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
  if (["context_exceeded", "context_length_exceeded", "prompt_too_long", "max_context_length_exceeded"].includes(code ?? "")
    || /prompt is too long|maximum context|context length|context window|prompt length exceeds|too many tokens|maximum number of tokens/i.test(message))
    return new ApiError(400, "context_exceeded", "The conversation is too long for this model.");
  if (code === "insufficient_quota" || code === "billing_error")
    return new ApiError(402, "provider_quota", "The provider account has no remaining credit or quota. Check billing with the provider.");
  if (status === 401 || code === "authentication_error" || code === "invalid_api_key")
    return new ApiError(401, "provider_auth", "The provider rejected the API key. An administrator can update it in Settings → Models.");
  if (status === 403 || code === "permission_error")
    return new ApiError(403, "provider_forbidden", "This API key doesn't have access to the model.");
  if (status === 404 || code === "not_found_error" || code === "model_not_found")
    return new ApiError(404, "provider_model", "The provider doesn't recognize this model. Refresh the model list or choose another model.");
  if (status === 429 || code === "rate_limit_error" || code === "rate_limit_exceeded")
    return new ApiError(429, "provider_rate_limit", "The provider is limiting requests right now. Gond Agent will retry shortly.", true);
  if (status === 529 || status >= 500 || code === "overloaded_error" || code === "server_error" || code === "api_error")
    return new ApiError(503, "provider_unavailable", "The model provider is unavailable right now. Gond Agent will retry shortly.", true);
  if (status === 400 || status === 422 || code === "invalid_request_error")
    return new ApiError(400, "provider_request", "The provider rejected the request. Choose another model or check its settings.");
  return new ApiError(502, "provider_error", "The model provider reported an error.", true);
}
