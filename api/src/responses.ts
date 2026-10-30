import type { Store } from "./db";
import { connectionFor } from "./providers";
import { modelFor } from "./models";
import { adapterFor, callProvider } from "./adapters";
import { parseSse, encodeEvent } from "./lib/sse";
import { ApiError, type ResponsesRequest, type Usage } from "./wire";
export async function modelResponse(
  db: Store,
  secret: string,
  userId: string,
  runId: string,
  req: Request,
): Promise<Response> {
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
  if (
    typeof body.model !== "string" ||
    !Array.isArray(body.messages) ||
    !body.messages.length
  )
    throw new ApiError(
      400,
      "invalid_request",
      "Choose a model and send a message.",
    );
  const model = modelFor(db, body.model),
    adapter = adapterFor(model),
    abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  // Resolve only images belonging to this run and user.
  for (const message of body.messages)
    for (const block of message.content) {
      if (block.type === "image" && "id" in block && block.id) {
        const image = db
          .prepare(
            "SELECT media_type,bytes FROM images WHERE id=? AND user_id=? AND run_id=?",
          )
          .get(block.id, userId, runId) as
          { media_type: string; bytes: Buffer } | undefined;
        if (!image)
          throw new ApiError(
            404,
            "image_not_found",
            "That image isn't available.",
          );
        Object.assign(block, {
          media_type: image.media_type,
          data: image.bytes.toString("base64"),
        });
        delete (block as { id?: string }).id;
      }
    }
  const upstream = await callProvider(
    connectionFor(db, model.connection_id!),
    secret,
    adapter.build(body, model),
    abort.signal,
  );
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel();
    console.error("model request failed", upstream.status);
    throw new ApiError(
      502,
      "model_unavailable",
      "The model is unavailable. Check the provider settings.",
      true,
    );
  }
  const parser = adapter.parser(model);
  const stream = new ReadableStream<Uint8Array>({
    async start(out) {
      try {
        for await (const rec of parseSse(upstream.body!))
          for (const ev of parser.push(rec.event, rec.data))
            out.enqueue(encodeEvent(ev));
        const result = parser.result();
        const u: Usage = result?.usage ?? {
          input_uncached: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          reasoning: 0,
        };
        const cost = Math.ceil(
          (u.input_uncached * model.input_micros +
            u.output * model.output_micros +
            u.cache_read * model.cache_read_micros +
            u.cache_write * model.cache_write_micros) /
            1_000_000,
        );
        db.prepare(
          "INSERT INTO usage(user_id,run_id,model_id,input,output,cache_read,cost_micros,created_at) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          userId,
          runId,
          model.id,
          u.input_uncached,
          u.output,
          u.cache_read,
          cost,
          Date.now(),
        );
        if (result)
          out.enqueue(
            encodeEvent({
              event: "response.end",
              data: { stop_reason: result.stop_reason, usage: u },
            }),
          );
        else
          out.enqueue(
            encodeEvent({
              event: "error",
              data: {
                code: "truncated",
                message: "The model stopped before finishing. Try again.",
                retryable: true,
              },
            }),
          );
        out.close();
      } catch (e) {
        console.error("model stream failed", e);
        try {
          out.enqueue(
            encodeEvent({
              event: "error",
              data: {
                code: "stream",
                message: "The connection to the model dropped. Try again.",
                retryable: true,
              },
            }),
          );
          out.close();
        } catch {
          /* disconnected */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
    },
  });
}
