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
  try {
    return await fetch(providerURL(connection, up.path), {
      method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]), redirect: "error",
      headers: { "content-type": "application/json", ...up.headers, ...providerHeaders(connection, secret) },
      body: JSON.stringify(up.body),
    });
  } catch {
    throw new ApiError(502, "provider_connection", "Could not reach the model provider. Check its URL and network access.", true);
  }
}
