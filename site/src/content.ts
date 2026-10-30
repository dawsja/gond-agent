import { HELP_EMAIL } from "@shared/brand"

// Product copy for the self-hosted site.
export const APP_URL = "/agents/"
export const NAV = [{ id: "agents", label: "How it works" }, { id: "selfhost", label: "Self-hosting" }, { id: "models", label: "Models" }] as const
export const CLOUD_RUN = {
  repo: "acme/web",
  base: "main",
  branch: "gond-agent/rate-limit-login",
  model: "Auto",
  task: "Add rate limiting to the login endpoint, 5 tries a minute per IP",
  log: [
    { kind: "info", text: "Cloned acme/web in a fresh worker container", step: "Reading the code" },
    { kind: "tool", text: "Read src/routes/auth.ts", step: "Reading the code" },
    { kind: "tool", text: "Edit src/routes/auth.ts", note: "+16 −1", step: "Writing the change" },
    { kind: "tool", text: "Write test/auth.test.ts", note: "+22", step: "Running the tests" },
    { kind: "test", text: "Bash npm test", note: "✓ 19 passed", step: "Committing changes" },
    { kind: "info", text: "Pushed gond-agent/rate-limit-login", step: "Opening pull request" },
  ] as { kind: "info" | "tool" | "test"; text: string; note?: string; step?: string }[],
  pr: { number: 42, title: "Rate limit login attempts per IP", add: 38, del: 1, files: 2 },
}

export const MODELS = [
  { maker: "Anthropic", models: ["Claude Sonnet 5.5", "Claude Fable 5.1", "Claude Opus 5.5", "Claude Haiku 5.5"] },
  { maker: "OpenAI", models: ["GPT-6 Astra", "GPT-6.1 Sol", "GPT-5.6 Terra", "GPT-6 Luna"] },
  { maker: "xAI", models: ["Grok 4.7", "Grok 4.6"] },
  { maker: "Google", models: ["Gemini 3.8 Flash"] },
  { maker: "Moonshot AI", models: ["Kimi K3"] },
  { maker: "Qwen", models: ["Qwen 3.8 27B"] },
  { maker: "Z.ai", models: ["GLM-5.3 Flash"] },
  { maker: "MiniMax", models: ["MiniMax M3"] },
]


export const MODELS_NOTE = "Choose the right model for the task. Every account has access to all configured models."
export const FOOTER = { links: [{ label: "Docs", href: "/docs" }, { label: "Sign in", href: APP_URL }, { label: "Privacy", href: "/privacy" }], note: "Your coding agents. Your infrastructure. Every feature, for every account.", email: HELP_EMAIL }
