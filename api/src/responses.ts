import { modelPolicy, modelReason, retryAfterMs } from "./model-errors";
import type { Store } from "./db";
import { ModelAccess } from "./access";
import { SubscriptionAccounts } from "./subscriptions/accounts";
import { validateEffort } from "./effort";
import { connectionFor } from "./providers";
import { adapterFor, callProvider, callUpstream, errorBody } from "./adapters";
import { providerFailure, providerStreamFailure } from "./adapters/errors";
import { parseSse, encodeEvent } from "./lib/sse";
import { ApiError, emptyUsage, type ResponsesRequest, type StreamEvent } from "./wire";

/** The worker's model relay. Errors reach the runner as `{error}` JSON so it can show and retry them. */
export async function modelResponse(db: Store, secret: string, userId: string, runId: string, req: Request, access = new ModelAccess(db, secret, new SubscriptionAccounts(db, secret, []))): Promise<Response> {
  try {
    return await relay(db, secret, access, userId, runId, req);
  } catch (error) {
    // An upstream AbortError is a dropped model connection, not necessarily worker cancellation.
    // Genuine downstream cancellation must not be turned into a retryable response.
    if (req.signal.aborted) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      console.error("model request failed", error.name);
      error = new ApiError(502, "stream", "The connection to the model dropped. Try again.", true);
    }
    if (!(error instanceof ApiError)) throw error;
    const failure = error as ApiError, policy = modelPolicy(failure.code);
    return Response.json({ error: { code: policy.code, message: modelReason(policy.code, undefined, failure.resetAt), retryable: policy.retryable,
      retry_after_ms: failure.retryAfterMs, reset_at: failure.resetAt } }, { status: failure.status });
  }
}

async function relay(db: Store, secret: string, access: ModelAccess, userId: string, runId: string, req: Request): Promise<Response> {
  req.signal.throwIfAborted();
  const reader = req.body?.getReader();
  let size = 0;
  const parts: Uint8Array[] = [];
  if (reader)
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 12 * 1024 * 1024) {
        await reader.cancel();
        throw new ApiError(413, "too_large", "The model request is too large.");
      }
      parts.push(value);
    }
  let body: ResponsesRequest;
  try {
    body = JSON.parse(Buffer.concat(parts).toString());
  } catch {
    throw new ApiError(400, "invalid_request", "Send a valid model request.");
  }
  if (typeof body.model !== "string" || !Array.isArray(body.messages) || !body.messages.length)
    throw new ApiError(400, "invalid_request", "Choose a model and send a message.");
  const model = await access.resolve(userId, body.model),
    adapter = adapterFor(model),
    abort = new AbortController();
  if (body.reasoning && model.capabilities.reasoning !== "none") validateEffort(model, body.reasoning.effort);
  req.signal.throwIfAborted();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  for (const message of body.messages)
    for (const block of message.content)
      if (block.type === "image" && block.id)
        throw new ApiError(400, "invalid_image", "Image bytes must be processed by the worker before a model request.");
  const up = adapter.build(body, model);
  const plan = model.access;
  let upstream: Response;
  let remap: (event: StreamEvent) => StreamEvent = event => event;
  if (plan) {
    // Plan usage never falls back to an API connection: every failure below stops this request.
    const { result, provider } = await access.subscriptions.withToken(plan.account,
      (tokens, provider) => callUpstream(`${provider.baseURL}/${up.path.replace(/^v1\//, "")}`, provider.headers(tokens), up.body, abort.signal), { admit: true });
    upstream = result;
    if (!upstream.ok || !upstream.body) {
      const details = await errorBody(upstream), failure = provider.failure(upstream.status, details);
      const metadata = providerStreamFailure(details && typeof details === "object" ? details as Record<string, unknown> : {});
      if (metadata.event === "error") failure.error.resetAt = metadata.data.reset_at;
      console.error("subscription model request failed", provider.id, upstream.status, failure.error.code);
      const error = access.subscriptions.apply(plan.account, failure);
      error.retryAfterMs = retryAfterMs(upstream.headers.get("retry-after")) ?? (metadata.event === "error" ? metadata.data.retry_after_ms : undefined);
      throw error;
    }
    remap = event => {
      if (event.event !== "error" || (!/^(subscription_sharing_|chatpass_)/.test(event.data.code) && event.data.code !== "provider_usage_limit")) return event;
      const failure = provider.failure(0, { error: { code: event.data.code === "provider_usage_limit" ? "usage_limit_reached" : event.data.code } }), error = access.subscriptions.apply(plan.account, failure);
      return { event: "error", data: { ...event.data, code: error.code, message: error.message, retryable: error.retryable } };
    };
  } else {
    upstream = await callProvider(connectionFor(db, model.connection_id!), secret, up, abort.signal);
    if (!upstream.ok || !upstream.body) {
      const details = await errorBody(upstream), error = providerFailure(upstream.status, details);
      const metadata = providerStreamFailure(details && typeof details === "object" ? details as Record<string, unknown> : {});
      if (metadata.event === "error") error.resetAt = metadata.data.reset_at;
      console.error("model request failed", upstream.status, error.code);
      error.retryAfterMs = retryAfterMs(upstream.headers.get("retry-after")) ?? (metadata.event === "error" ? metadata.data.retry_after_ms : undefined);
      throw error;
    }
  }
  const parser = adapter.parser(model);
  const stream = new ReadableStream<Uint8Array>({
    async start(out) {
      try {
        for await (const rec of parseSse(upstream.body!)) {
          abort.signal.throwIfAborted();
          for (const ev of parser.push(rec.event, rec.data)) {
            const event = remap(ev);
            if (event.event === "error") {
              const policy = modelPolicy(event.data.code);
              out.enqueue(encodeEvent({ event: "error", data: { ...event.data, code: policy.code, retryable: policy.retryable,
                message: modelReason(policy.code, event.data.status, event.data.reset_at) } }));
              // An explicit provider error is terminal; never emit a contradictory truncated/success event.
              abort.abort();
              out.close();
              return;
            }
            out.enqueue(encodeEvent(event));
          }
        }
        abort.signal.throwIfAborted();
        const result = parser.result();
        const u = result?.usage ?? emptyUsage();
        const cost = Math.ceil((u.input_uncached * model.input_micros + u.output * model.output_micros + u.cache_read * model.cache_read_micros + u.cache_write * model.cache_write_micros) / 1_000_000);
        db.prepare("INSERT INTO usage(user_id,run_id,model_id,input,output,cache_read,cost_micros,created_at) VALUES(?,?,?,?,?,?,?,?)")
          .run(userId, runId, model.id, u.input_uncached, u.output, u.cache_read, cost, Date.now());
        // A plan request succeeds only at response.completed; incomplete or cut-off streams are errors.
        if (result) {
          if (plan) access.subscriptions.succeeded(plan.account);
          out.enqueue(encodeEvent({ event: "response.end", data: { stop_reason: result.stop_reason, usage: u } }));
        } else
          out.enqueue(encodeEvent({ event: "error", data: { code: "truncated", message: "The model stopped before finishing. Try again.", retryable: true } }));
        out.close();
      } catch (e) {
        if (abort.signal.aborted) {
          try { out.close(); } catch { /* disconnected */ }
          return;
        }
        console.error("model stream failed", e instanceof Error ? e.name : "error");
        try {
          out.enqueue(encodeEvent({ event: "error", data: { code: "stream", message: "The connection to the model dropped. Try again.", retryable: true } }));
          out.close();
        } catch { /* disconnected */ }
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" } });
}
