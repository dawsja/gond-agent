// Model providers: which one a model id belongs to, and its name for people.

/**
 * Provider of a model id (the API's ids: claude-*, gpt-*, grok-*, gemini-*, kimi-*, qwen*, glm-*,
 * minimax-*). "auto" is Auto, the model Gond Agent picks: its own group and mark, no provider's.
 */
export function providerOf(modelId: string): string {
  if (modelId === "auto") return "auto"
  if (modelId.includes(":")) {
    try { modelId = decodeURIComponent(modelId.slice(modelId.indexOf(":") + 1)) } catch { return "other" }
  }
  modelId = modelId.slice(modelId.lastIndexOf("/") + 1).toLowerCase()
  if (modelId.startsWith("claude")) return "anthropic"
  if (modelId.startsWith("gpt") || /^o\d/.test(modelId)) return "openai"
  if (modelId.startsWith("grok")) return "xai"
  if (modelId.startsWith("gemini")) return "google"
  if (modelId.startsWith("kimi")) return "moonshot"
  if (modelId.startsWith("qwen")) return "qwen"
  if (modelId.startsWith("glm")) return "zai"
  if (modelId.startsWith("minimax")) return "minimax"
  return "other"
}

export const PROVIDER_LABEL: Record<string, string> = {
  auto: "Gond Agent",
  anthropic: "Anthropic",
  openai: "OpenAI",
  xai: "xAI",
  google: "Google",
  moonshot: "Moonshot AI",
  qwen: "Qwen",
  zai: "Z.ai",
  minimax: "MiniMax",
}
