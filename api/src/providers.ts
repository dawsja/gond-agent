import { z } from "zod";
import { seal, unseal } from "./auth";
import { getSetting, setSetting, type Store } from "./db";
import { ApiError } from "./wire";

const modelSchema = z.object({
  id: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(120),
  contextWindow: z.number().int().min(1024).max(10_000_000),
  maxOutput: z.number().int().min(256).max(1_000_000),
  reasoning: z.enum(["none", "adaptive", "budget", "effort"]),
  images: z.boolean(),
}).refine(m => m.maxOutput <= m.contextWindow, "Output must fit in the context window.");
const connectionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  name: z.string().trim().min(1).max(80),
  format: z.enum(["anthropic", "openai", "openai-responses"]),
  baseURL: z.string().trim().min(1).max(2048),
  apiKey: z.string().trim().max(4096).optional(),
  clearKey: z.boolean().optional(),
  models: z.array(modelSchema).min(1).max(100),
});
const settingsSchema = z.object({
  connections: z.array(connectionSchema).min(1).max(20),
  defaultModel: z.string().min(1).max(1000),
  transcription: z.object({ connectionId: z.string().max(80), model: z.string().trim().max(240) }).nullable(),
});
export type ProviderModel = z.infer<typeof modelSchema>;
export type ProviderConnection = Omit<z.infer<typeof connectionSchema>, "apiKey" | "clearKey"> & { secret: string };
export interface ProviderSettings {
  connections: ProviderConnection[];
  defaultModel: string;
  transcription: { connectionId: string; model: string } | null;
}
export const modelId = (connectionId: string, id: string) => `${connectionId}:${encodeURIComponent(id)}`;
export function providerSettings(db: Store): ProviderSettings {
  return getSetting<ProviderSettings>(db, "providers") ?? { connections: [], defaultModel: "", transcription: null };
}
export function publicProviderSettings(db: Store) {
  const settings = providerSettings(db);
  return { ...settings, connections: settings.connections.map(({ secret, ...c }) => ({ ...c, hasKey: !!secret })) };
}
export function setupComplete(db: Store) {
  const settings = providerSettings(db);
  return settings.connections.some(c => c.models.some(m => modelId(c.id, m.id) === settings.defaultModel));
}
export function normalizeBaseURL(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400, "invalid_provider", "Enter a valid API base URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new ApiError(400, "invalid_provider", "Use an HTTP or HTTPS API URL without credentials, query parameters or fragments.");
  if (url.pathname === "/") url.pathname = "/v1";
  return url.toString().replace(/\/+$/, "");
}
export function saveProviderSettings(db: Store, secret: string, input: unknown) {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(400, "invalid_provider", "Add a provider, at least one model, valid token limits and a default model.");
  const old = providerSettings(db), ids = new Set<string>();
  const connections = parsed.data.connections.map(({ apiKey, clearKey, ...c }): ProviderConnection => {
    if (ids.has(c.id) || new Set(c.models.map(m => m.id)).size !== c.models.length)
      throw new ApiError(400, "invalid_provider", "Provider and model IDs must be unique.");
    ids.add(c.id);
    if (c.format !== "anthropic" && c.models.some(m => ["adaptive", "budget"].includes(m.reasoning)))
      throw new ApiError(400, "invalid_provider", "Adaptive and budget thinking require an Anthropic-compatible API.");
    if (c.format === "anthropic" && c.models.some(m => m.reasoning === "effort"))
      throw new ApiError(400, "invalid_provider", "Choose an Anthropic thinking mode for this provider.");
    const baseURL = normalizeBaseURL(c.baseURL), previous = old.connections.find(p => p.id === c.id);
    if (previous?.secret && !apiKey && !clearKey && (previous.baseURL !== baseURL || previous.format !== c.format))
      throw new ApiError(400, "replace_key", "Re-enter or clear the API key when changing its URL or API format.");
    return { ...c, baseURL, secret: apiKey ? seal(secret, apiKey) : clearKey ? "" : previous?.secret ?? "" };
  });
  const { defaultModel, transcription } = parsed.data;
  if (!connections.some(c => c.models.some(m => modelId(c.id, m.id) === defaultModel)))
    throw new ApiError(400, "invalid_provider", "Choose a default model from the configured providers.");
  if (transcription && (!transcription.model || !connections.some(c => c.id === transcription.connectionId && c.format !== "anthropic")))
    throw new ApiError(400, "invalid_provider", "Choose an OpenAI-compatible provider and transcription model, or disable voice transcription.");
  setSetting(db, "providers", { connections, defaultModel, transcription });
  return publicProviderSettings(db);
}
export function connectionFor(db: Store, id: string) {
  const connection = providerSettings(db).connections.find(c => c.id === id);
  if (!connection) throw new ApiError(503, "provider_required", "Configure this model's provider in Settings.");
  return connection;
}
export function providerHeaders(connection: ProviderConnection, secret: string): Record<string, string> {
  const key = connection.secret ? unseal(secret, connection.secret) : "";
  return connection.format === "anthropic"
    ? { "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) }
    : key ? { authorization: `Bearer ${key}` } : {};
}
export function providerURL(connection: ProviderConnection, path: string) {
  return `${connection.baseURL}/${path.replace(/^v1\//, "")}`;
}
export async function testProvider(db: Store, secret: string, id: string) {
  const connection = connectionFor(db, id);
  let response: Response;
  try {
    response = await fetch(providerURL(connection, "models"), {
      headers: providerHeaders(connection, secret), redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new ApiError(502, "provider_connection", "Could not reach the provider. Check its URL and network access."); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError(502, "provider_connection", `The provider returned HTTP ${response.status}. Check its URL and API key; model listing must be supported to use this test.`);
  }
  const body = await response.json().catch(() => null) as { data?: { id?: unknown }[] } | null;
  if (!Array.isArray(body?.data)) throw new ApiError(502, "provider_connection", "The provider did not return a model list. You can enter model IDs manually.");
  return { models: body.data.flatMap(m => typeof m.id === "string" ? [m.id] : []).slice(0, 500) };
}
export async function transcribe(db: Store, secret: string, audio: ArrayBuffer, type: string, language?: string) {
  const settings = providerSettings(db);
  if (!settings.transcription) throw new ApiError(409, "transcription_required", "Enable voice transcription in Settings first.");
  if (!audio.byteLength) throw new ApiError(400, "empty_audio", "Record some audio first.");
  if (!["audio/wav", "audio/x-wav", "audio/webm", "audio/mpeg", "audio/mp4", "audio/ogg"].includes(type))
    throw new ApiError(400, "audio_type", "Choose a supported audio recording.");
  const connection = connectionFor(db, settings.transcription.connectionId), form = new FormData();
  const ext = type.includes("wav") ? "wav" : type === "audio/mpeg" ? "mp3" : type.split("/")[1];
  form.set("file", new Blob([audio], { type }), `recording.${ext}`);
  form.set("model", settings.transcription.model);
  form.set("response_format", "json");
  if (language && /^[a-z]{2,3}$/.test(language)) form.set("language", language);
  let response: Response;
  try {
    response = await fetch(providerURL(connection, "audio/transcriptions"), {
      method: "POST", headers: providerHeaders(connection, secret), body: form,
      redirect: "error", signal: AbortSignal.timeout(120_000),
    });
  } catch { throw new ApiError(502, "transcription", "Could not reach the transcription provider. Try again."); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError(502, "transcription", "Could not transcribe that recording. Check the provider and transcription model in Settings.");
  }
  const result = await response.json().catch(() => null) as { text?: unknown } | null;
  if (typeof result?.text !== "string") throw new ApiError(502, "transcription", "The provider returned an invalid transcription.");
  return { text: result.text };
}
