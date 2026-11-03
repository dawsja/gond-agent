import type { Store } from "./db";
import { ModelAccess } from "./access";
import { SubscriptionAccounts } from "./subscriptions/accounts";
import { validateEffort } from "./effort";
import { connectionFor } from "./providers";
import { adapterFor, callProvider, callUpstream, errorBody } from "./adapters";
import { errorParts, providerFailure } from "./adapters/errors";
import { parseSse, encodeEvent } from "./lib/sse";
import { ApiError, emptyUsage, type ResponsesRequest, type StreamEvent } from "./wire";

/** The worker's model relay. Errors reach the runner as `{error}` JSON so it can show and retry them. */
export async function modelResponse(db: Store, secret: string, userId: string, runId: string, req: Request, access = new ModelAccess(db, secret, new SubscriptionAccounts(db, secret, []))): Promise<Response> {
  try {
    return await relay(db, secret, access, userId, runId, req);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return Response.json({ error: { code: error.code, message: error.message, retryable: error.retryable } }, { status: error.status });
  }
}

async function relay(db: Store, secret: string, access: ModelAccess, userId: string, runId: string, req: Request): Promise<Response> {
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
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  // Resolve only images belonging to this run and user.
  for (const message of body.messages)
    for (const block of message.content) {
      if (block.type === "image" && "id" in block && block.id) {
        const image = db.prepare("SELECT media_type,bytes FROM images WHERE id=? AND user_id=? AND run_id=?")
          .get(block.id, userId, runId) as { media_type: string; bytes: Buffer } | undefined;
        if (!image) throw new ApiError(404, "image_not_found", "That image isn't available.");
        Object.assign(block, { media_type: image.media_type, data: image.bytes.toString("base64") });
        delete (block as { id?: string }).id;
      }
    }
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
      const failure = provider.failure(upstream.status, await errorBody(upstream));
      console.error("subscription model request failed", provider.id, upstream.status, failure.error.code, upstream.headers.get("x-request-id") ?? "");
      throw access.subscriptions.apply(plan.account, failure);
    }
    remap = event => {
      if (event.event !== "error" || !/^(subscription_sharing_|chatpass_)/.test(event.data.code)) return event;
      const failure = provider.failure(0, { error: { code: event.data.code } }), error = access.subscriptions.apply(plan.account, failure);
      return { event: "error", data: { code: error.code, message: error.message, retryable: error.retryable } };
    };
  } else {
    upstream = await callProvider(connectionFor(db, model.connection_id!), secret, up, abort.signal);
    if (!upstream.ok || !upstream.body) {
      const details = await errorBody(upstream), error = providerFailure(upstream.status, details);
      console.error("model request failed", upstream.status, errorParts(details).code ?? "");
      throw error;
    }
  }
  const parser = adapter.parser(model);
  const stream = new ReadableStream<Uint8Array>({
    async start(out) {
      try {
        for await (const rec of parseSse(upstream.body!))
          for (const ev of parser.push(rec.event, rec.data)) out.enqueue(encodeEvent(remap(ev)));
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
