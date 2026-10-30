import { createHash } from "node:crypto";
import type { Store } from "./db";
import type { ModelRow } from "./adapters/types";
import { discoverProviderModels, modelId, providerSettings, type ProviderConnection, type ProviderModel } from "./providers";
import { ApiError } from "./wire";

interface CatalogEntry {
  fingerprint: string;
  checked: number;
  models: ProviderModel[];
  status: "ready" | "empty" | "unsupported" | "error";
  message?: string;
  pending?: Promise<void>;
}
const catalogs = new WeakMap<Store, Map<string, CatalogEntry>>();
const fingerprint = (c: ProviderConnection) => createHash("sha256").update(JSON.stringify([c.format, c.baseURL, c.secret, c.discover])).digest("hex");
const cached = (db: Store, c: ProviderConnection) => {
  const entry = catalogs.get(db)?.get(c.id);
  return entry?.fingerprint === fingerprint(c) ? entry : undefined;
};
function modelsForConnection(db: Store, c: ProviderConnection) {
  return [...new Map([...(c.discover ? cached(db, c)?.models ?? [] : []), ...c.models].map(m => [m.id, m])).values()];
}
export function modelRows(db: Store): ModelRow[] {
  return providerSettings(db).connections.flatMap(c => modelsForConnection(db, c).map(m => ({
    id: modelId(c.id, m.id), connection_id: c.id, format: c.format,
    provider: c.format === "anthropic" ? "anthropic" as const : "openai" as const,
    upstream_id: m.id, display_name: `${m.name} · ${c.name}`,
    context_window: m.contextWindow, max_output: m.maxOutput,
    capabilities: { reasoning: m.reasoning, images: m.images },
    input_micros: 0, output_micros: 0, cache_read_micros: 0, cache_write_micros: 0,
  })));
}
export function modelFor(db: Store, id: string): ModelRow {
  const rows = modelRows(db);
  if (!rows.length) throw new ApiError(503, "provider_required", "No models are available. Check the provider connections or add a manual model override.");
  const selected = id === "auto" ? providerSettings(db).defaultModel : id;
  const model = rows.find(m => m.id === selected) ?? (id === "auto" ? rows[0] : undefined);
  if (!model) throw new ApiError(404, "unknown_model", "That model is no longer available. Refresh the model list and choose another model.");
  return model;
}
export function publicModels(db: Store) {
  const rows = modelRows(db), settings = providerSettings(db);
  const auto = rows.length ? modelFor(db, "auto") : undefined;
  return {
    models: [...(auto ? [{ ...auto, id: "auto", provider: "auto" as const, display_name: "Auto" }] : []), ...rows].map(m => ({
      id: m.id, provider: m.provider, display_name: m.display_name,
      connection_id: m.connection_id, connection_name: settings.connections.find(c => c.id === m.connection_id)?.name,
      context_window: m.context_window, max_output: m.max_output, capabilities: m.capabilities,
    })),
    connections: settings.connections.map(c => {
      const entry = c.discover ? cached(db, c) : undefined;
      return { id: c.id, name: c.name, status: entry?.status ?? (c.models.length ? "ready" : "empty"),
        ...(entry?.message ? { message: entry.message } : !c.discover && !c.models.length ? { message: "Add manual model IDs for this connection, or enable discovery." } : {}) };
    }),
  };
}
export async function loadModelCatalog(db: Store, secret: string, refresh = false) {
  const connections = providerSettings(db).connections;
  const catalog = catalogs.get(db) ?? new Map<string, CatalogEntry>();
  catalogs.set(db, catalog);
  for (const id of catalog.keys()) if (!connections.some(c => c.id === id)) catalog.delete(id);
  const load = async (c: ProviderConnection) => {
    if (!c.discover) return;
    let entry = cached(db, c);
    if (entry?.pending) return entry.pending;
    if (entry && Date.now() - entry.checked < (refresh ? 5000 : 60000)) return;
    if (!entry) {
      entry = { fingerprint: fingerprint(c), checked: 0, models: [], status: "empty" };
      catalog.set(c.id, entry);
    }
    const current = entry;
    current.pending = (async () => {
      try {
        const result = await discoverProviderModels(db, secret, { id: c.id, format: c.format, baseURL: c.baseURL });
        if (result.supported) current.models = result.models.map(m => {
          const contextWindow = m.contextWindow ?? 128000;
          return { id: m.id, name: m.name, contextWindow, maxOutput: Math.min(m.maxOutput ?? 8192, contextWindow), reasoning: "none", images: m.images ?? false };
        });
        current.status = !result.supported ? "unsupported" : current.models.length ? "ready" : "empty";
        current.message = !result.supported ? c.models.length ? "Model discovery is unsupported. Using manual model overrides." : "Model discovery is unsupported. Add manual model IDs in provider settings." : !current.models.length ? "The provider returned no models." : result.truncated ? "Showing the first 500 models. Other IDs can be added as manual overrides." : undefined;
      } catch (error) {
        current.status = "error";
        current.message = (error instanceof ApiError ? error.message : "Could not load this connection's models. Check its provider settings.") + (current.models.length ? " Showing previously loaded models." : "");
      } finally {
        current.checked = Date.now();
        current.pending = undefined;
      }
    })();
    await current.pending;
  };
  // Settings cap connections at 20; concurrent callers share each in-flight discovery.
  await Promise.all(connections.map(load));
  return publicModels(db);
}
export async function resolveModel(db: Store, secret: string, id: string) {
  try { return modelFor(db, id); }
  catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await loadModelCatalog(db, secret);
    return modelFor(db, id);
  }
}
