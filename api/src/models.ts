import type { Store } from "./db";
import type { ModelRow } from "./adapters/types";
import { modelId, providerSettings } from "./providers";
import { ApiError } from "./wire";

export function modelRows(db: Store): ModelRow[] {
  return providerSettings(db).connections.flatMap(c => c.models.map(m => ({
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
  if (!rows.length) throw new ApiError(503, "provider_required", "Complete model setup before starting a run.");
  const model = rows.find(m => m.id === (id === "auto" ? providerSettings(db).defaultModel : id));
  if (!model) throw new ApiError(404, "unknown_model", "That model isn't configured. Choose another model.");
  return model;
}
export function publicModels(db: Store) {
  const rows = modelRows(db);
  if (!rows.length) return { models: [] };
  const auto = modelFor(db, "auto");
  return { models: [{ ...auto, id: "auto", provider: "auto", display_name: "Auto" }, ...rows].map(m => ({
    id: m.id, provider: m.provider, display_name: m.display_name,
    context_window: m.context_window, max_output: m.max_output, capabilities: m.capabilities,
  })) };
}
