export type Format = "anthropic" | "openai" | "openai-responses"
export interface ProviderModel { id: string; name: string; contextWindow: number; maxOutput: number; reasoning: "none" | "adaptive" | "budget" | "effort"; efforts?: string[]; images: boolean }
export interface Connection { id: string; name: string; format: Format; baseURL: string; hasKey: boolean; apiKey?: string; clearKey?: boolean; discover: boolean; models: ProviderModel[] }
export interface ProviderSettingsValue { connections: Connection[]; defaultModel: string }

export const DEFAULT_URLS: Record<Format, string> = { anthropic: "https://api.anthropic.com/v1", openai: "https://api.openai.com/v1", "openai-responses": "https://api.openai.com/v1" }
export function newModel(id = ""): ProviderModel {
  return { id, name: id.slice(0, 120), contextWindow: 128000, maxOutput: 8192, reasoning: "none", images: false }
}
export function changeFormat(connection: Connection, format: Format): Partial<Connection> {
  const url = connection.baseURL.trim().replace(/\/+$/, "")
  return {
    format,
    baseURL: !url || Object.values(DEFAULT_URLS).includes(url) ? DEFAULT_URLS[format] : connection.baseURL,
    apiKey: "", clearKey: false,
    models: connection.models.map(model => ({ ...model, reasoning: "none" })),
  }
}
