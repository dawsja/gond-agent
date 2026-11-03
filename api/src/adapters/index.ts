import { modelStallMs } from "../config";
import { ApiError } from "../wire";
import { providerHeaders, providerURL, type ProviderConnection } from "../providers";
import { anthropic } from "./anthropic";
import { chatAdapter } from "./chat";
import { responsesAdapter } from "./responses";
import type { Adapter, ModelRow, UpstreamRequest } from "./types";

export function adapterFor(model: ModelRow): Adapter {
  if (model.format === "anthropic" || (!model.format && model.provider === "anthropic")) return anthropic;
  if (model.format === "openai-responses" || (!model.format && model.provider === "openai")) return responsesAdapter;
  return chatAdapter;
}
export async function callProvider(connection: ProviderConnection, secret: string, up: UpstreamRequest, signal: AbortSignal): Promise<Response> {
  const stallMs = modelStallMs();
  const abort = new AbortController();
  const combined = AbortSignal.any([signal, abort.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => clearTimeout(timer);
  const progress = () => {
    clear();
    if (stallMs) timer = setTimeout(() => abort.abort(new Error("Model response stalled")), stallMs);
  };
  progress();
  try {
    const response = await fetch(providerURL(connection, up.path), {
      method: "POST", signal: combined, redirect: "error",
      headers: { "content-type": "application/json", ...up.headers, ...providerHeaders(connection, secret) },
      body: JSON.stringify(up.body),
    });
    progress();
    if (!response.body) { clear(); return response; }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(out) {
        try {
          const {done, value} = await reader.read();
          if (done) { clear(); reader.releaseLock(); out.close(); return; }
          if (value.byteLength) progress();
          out.enqueue(value);
        } catch (error) { clear(); reader.releaseLock(); out.error(error); }
      },
      async cancel(reason) {
        clear();
        abort.abort(reason);
        await reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(body, {status:response.status, statusText:response.statusText, headers:response.headers});
  } catch {
    clear();
    throw new ApiError(502, "provider_connection", "Could not reach the model provider. Check its URL and network access.", true);
  }
}
