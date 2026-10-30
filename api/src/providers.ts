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
  models: z.array(modelSchema).max(100).default([]),
  discover: z.boolean().default(true),
});
const settingsSchema = z.object({
  connections: z.array(connectionSchema).min(1).max(20),
  defaultModel: z.string().max(1000).default(""),
});
const discoverySchema = connectionSchema.omit({ name: true, models: true }).extend({ id: connectionSchema.shape.id.optional() });
export type ProviderModel = z.infer<typeof modelSchema>;
export type ProviderConnection = Omit<z.infer<typeof connectionSchema>, "apiKey" | "clearKey"> & { secret: string };
export interface ProviderSettings {
  connections: ProviderConnection[];
  defaultModel: string;
}
export const modelId = (connectionId: string, id: string) => `${connectionId}:${encodeURIComponent(id)}`;
export function providerSettings(db: Store): ProviderSettings {
  const saved = getSetting<ProviderSettings>(db, "providers");
  return { connections: (saved?.connections ?? []).map(c => ({ ...c, discover: c.discover ?? true, models: c.models ?? [] })), defaultModel: saved?.defaultModel ?? "" };
}
export function publicProviderSettings(db: Store) {
  const settings = providerSettings(db);
  return { ...settings, connections: settings.connections.map(({ secret, ...c }) => ({ ...c, hasKey: !!secret })) };
}
export function setupComplete(db: Store) {
  return providerSettings(db).connections.length > 0;
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
    throw new ApiError(400, "invalid_provider", "Add a provider with a valid name, API format and URL. Check any manual model overrides.");
  const old = providerSettings(db), ids = new Set<string>();
  const connections = parsed.data.connections.map(({ apiKey, clearKey, ...c }): ProviderConnection => {
    if (ids.has(c.id) || new Set(c.models.map(m => m.id)).size !== c.models.length)
      throw new ApiError(400, "invalid_provider", "Provider and model IDs must be unique.");
    ids.add(c.id);
    if (c.format !== "anthropic" && c.models.some(m => ["adaptive", "budget"].includes(m.reasoning)))
      throw new ApiError(400, "invalid_provider", "Adaptive and budget thinking require an Anthropic-compatible API.");
    if (c.format === "anthropic" && c.models.some(m => m.reasoning === "effort"))
      throw new ApiError(400, "invalid_provider", "Choose an Anthropic thinking mode for this provider.");
    return { ...c, ...resolveCredentials(secret, { ...c, apiKey, clearKey }, old.connections.find(p => p.id === c.id)) };
  });
  const { defaultModel } = parsed.data;
  if (defaultModel && !connections.some(c => defaultModel.startsWith(c.id + ":")))
    throw new ApiError(400, "invalid_provider", "The default model must belong to a configured provider.");
  setSetting(db, "providers", { connections, defaultModel });
  return publicProviderSettings(db);
}
export function connectionFor(db: Store, id: string) {
  const connection = providerSettings(db).connections.find(c => c.id === id);
  if (!connection) throw new ApiError(503, "provider_required", "Configure this model's provider in Settings.");
  return connection;
}
function resolveCredentials(secret: string, input: z.infer<typeof discoverySchema>, previous?: ProviderConnection) {
  const baseURL = normalizeBaseURL(input.baseURL);
  if (previous?.secret && !input.apiKey && !input.clearKey && (previous.baseURL !== baseURL || previous.format !== input.format))
    throw new ApiError(400, "replace_key", "Re-enter or clear the API key when changing its URL or API format.");
  return { format: input.format, baseURL, secret: input.apiKey ? seal(secret, input.apiKey) : input.clearKey ? "" : previous?.secret ?? "" };
}
export function providerHeaders(connection: Pick<ProviderConnection, "format" | "secret">, secret: string): Record<string, string> {
  const key = connection.secret ? unseal(secret, connection.secret) : "";
  return connection.format === "anthropic"
    ? { "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) }
    : key ? { authorization: `Bearer ${key}` } : {};
}
export function providerURL(connection: Pick<ProviderConnection, "baseURL">, path: string) {
  return `${connection.baseURL}/${path.replace(/^v1\//, "")}`;
}
export interface DiscoveredModel { id: string; name: string; contextWindow?: number; maxOutput?: number; images?: boolean }
export async function discoverProviderModels(db: Store, secret: string, input: unknown) {
  const parsed = discoverySchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "invalid_provider", "Enter an API format and base URL to load models.");
  const connection = resolveCredentials(secret, parsed.data, providerSettings(db).connections.find(c => c.id === parsed.data.id));
  const models = new Map<string, DiscoveredModel>(), cursors = new Set<string>();
  const signal = AbortSignal.timeout(15_000);
  let cursor = "", truncated = false;
  for (let page = 0; page < 5; page++) {
    const url = new URL(providerURL(connection, "models"));
    if (connection.format === "anthropic") {
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("after_id", cursor);
    }
    let response: Response;
    try { response = await fetch(url, { headers: providerHeaders(connection, secret), redirect: "error", signal }); }
    catch { throw new ApiError(502, "provider_connection", "Could not reach the provider. Check its URL and network access."); }
    if (!response.ok) {
      await response.body?.cancel();
      if ([404, 405, 501].includes(response.status)) return { supported: false, models: [], truncated: false };
      throw new ApiError(502, "provider_connection", `The provider returned HTTP ${response.status}. Check its URL and API key. You can also enter model IDs manually.`);
    }
    const body = await response.json().catch(() => null) as { data?: unknown[]; has_more?: boolean; last_id?: string } | null;
    if (!Array.isArray(body?.data)) throw new ApiError(502, "provider_connection", "The provider did not return a model list. You can enter model IDs manually.");
    for (const value of body.data) {
      if (!value || typeof value !== "object") continue;
      const m = value as Record<string, unknown>;
      if (typeof m.id !== "string" || !m.id.trim() || m.id.length > 240) continue;
      const name = typeof m.display_name === "string" ? m.display_name : typeof m.name === "string" ? m.name : m.id;
      const result: DiscoveredModel = { id: m.id.trim(), name: name.trim().slice(0, 120) || m.id.slice(0, 120) };
      if (Number.isInteger(m.max_input_tokens) && (m.max_input_tokens as number) >= 1024 && (m.max_input_tokens as number) <= 10_000_000) result.contextWindow = m.max_input_tokens as number;
      if (Number.isInteger(m.max_tokens) && (m.max_tokens as number) >= 256 && (m.max_tokens as number) <= 1_000_000) result.maxOutput = m.max_tokens as number;
      const capabilities = m.capabilities as { image_input?: { supported?: unknown } } | null | undefined;
      if (typeof capabilities?.image_input?.supported === "boolean") result.images = capabilities.image_input.supported;
      models.set(result.id, result);
      if (models.size === 500) break;
    }
    const more = connection.format === "anthropic" && body.has_more === true;
    truncated = more || body.data.length > 500;
    if (!more || models.size === 500) break;
    if (typeof body.last_id !== "string" || !body.last_id || body.last_id.length > 240 || cursors.has(body.last_id)) break;
    cursor = body.last_id; cursors.add(cursor);
  }
  return { supported: true, models: [...models.values()], truncated };
}
