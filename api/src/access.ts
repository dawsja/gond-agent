// Model access for the built-in runner: administrator API connections plus account-owned subscriptions.
import type { Store } from "./db";
import type { ModelRow } from "./adapters/types";
import { BACKEND, RETIRED_MODEL_PREFIX } from "./backend";
import { knownImages, knownReasoning, supportedEfforts, efforts as allEfforts } from "./effort";
import { loadModelCatalog, resolveModel } from "./models";
import { providerSettings } from "./providers";
import type { AccountCatalog, SubscriptionAccounts } from "./subscriptions/accounts";
import type { SubscriptionModel } from "./subscriptions/provider";
import { ApiError, type Effort } from "./wire";
import { modelDisplayName } from "../../shared/model-names";

/** `<provider>.<account>:<model>`. API connection IDs can't contain dots, so the two never collide. */
export const subscriptionModelId = (provider: string, account: string, model: string) => `${provider}.${account}:${encodeURIComponent(model)}`;
function parseSubscriptionId(id: string) {
  const match = /^([a-z][a-z0-9-]{0,30})\.([a-f0-9]{16}):(.+)$/.exec(id);
  if (!match) return undefined;
  try { return { provider: match[1]!, account: match[2]!, model: decodeURIComponent(match[3]!) }; } catch { return undefined; }
}

export function subscriptionRow(catalog: AccountCatalog, model: SubscriptionModel): ModelRow {
  const known = knownReasoning("openai-responses", model.id);
  const advertised = model.efforts?.filter((e): e is Exclude<Effort, "default"> => (allEfforts as readonly string[]).includes(e) && e !== "default");
  const efforts = advertised?.length ? advertised : known.efforts;
  return {
    id: subscriptionModelId(catalog.provider.id, catalog.account, model.id),
    provider: "openai", connection_id: catalog.connectionId, format: catalog.provider.format,
    access: { provider: catalog.provider.id, account: catalog.account },
    upstream_id: model.id, display_name: `${modelDisplayName(model.name, model.id)} · ${catalog.provider.name}`,
    context_window: model.contextWindow ?? 200_000, max_output: 128_000,
    capabilities: { reasoning: efforts?.length ? "effort" : known.reasoning, efforts, images: model.images ?? knownImages("openai-responses", model.id) },
    input_micros: 0, output_micros: 0, cache_read_micros: 0, cache_write_micros: 0,
  };
}

export class ModelAccess {
  constructor(private db: Store, private secret: string, readonly subscriptions: SubscriptionAccounts) {}

  /** Every model this account can start a run with: shared API connections and its own subscriptions. */
  async catalog(user: string, refresh = false) {
    const [api, accounts] = await Promise.all([loadModelCatalog(this.db, this.secret, refresh), this.subscriptions.catalog(user, refresh)]);
    const plans = accounts.flatMap(catalog => catalog.models.map(model => {
      const row = subscriptionRow(catalog, model);
      return {
        id: row.id, provider: row.provider, display_name: row.display_name, resolved_model: row.upstream_id,
        connection_id: catalog.connectionId, connection_name: catalog.connectionName,
        context_window: row.context_window, max_output: row.max_output, capabilities: row.capabilities, efforts: supportedEfforts(row),
        backend: BACKEND, access: catalog.provider.id,
      };
    }));
    return {
      models: [...api.models, ...plans],
      connections: [
        ...api.connections.map(c => ({ ...c, access: "api" })),
        ...accounts.map(c => ({ id: c.connectionId, name: c.connectionName, status: c.status, ...(c.message ? { message: c.message } : {}), access: c.provider.id, limited: c.limited, usage_url: c.provider.usageURL })),
      ],
    };
  }

  /** Resolves a selection for this account. Subscription models never resolve for another account. */
  async resolve(user: string, id: string): Promise<ModelRow> {
    if (typeof id !== "string" || !id || id.length > 1000) throw new ApiError(400, "invalid_model", "Choose an available model.");
    if (id.startsWith(RETIRED_MODEL_PREFIX))
      throw new ApiError(404, "retired_model", "Claude Code and Codex agents were removed. Choose a model from an API connection or your ChatGPT plan.");
    const plan = parseSubscriptionId(id);
    if (plan) {
      const found = await this.subscriptions.model(user, plan.account, plan.model);
      if (!found || found.catalog.provider.id !== plan.provider)
        throw new ApiError(404, "unknown_model", "That ChatGPT model isn't available. Sign in again in Settings → Models or choose another model.");
      return subscriptionRow(found.catalog, found.model);
    }
    if (id === "auto" && !providerSettings(this.db).connections.length) {
      // Subscription-only accounts: Auto uses the first model of their first usable plan.
      const first = (await this.subscriptions.catalog(user)).find(c => c.models.length);
      if (first) return subscriptionRow(first, first.models[0]!);
    }
    return resolveModel(this.db, this.secret, id);
  }
}
