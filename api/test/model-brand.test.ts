import { describe, expect, it } from "vitest";
import { providerOf } from "../../shared/providers";

describe("model brands across connection types", () => {
  it.each([
    ["cli-claude-code:sonnet", "anthropic"],
    ["cli-claude-code:opus%5B1m%5D", "anthropic"],
    ["cli-codex:default", "openai"],
    ["proxy:anthropic%2Fclaude-sonnet-4-6", "anthropic"],
    ["proxy:openai%2Fgpt-5.4", "openai"],
    ["proxy:google%2Fgemini-3-pro", "google"],
    ["proxy:mistralai%2Fdevstral-2", "mistral"],
    ["proxy:moonshotai%2Fkimi-k2", "moonshot"],
    ["proxy:qwen%2Fqwen3-coder", "qwen"],
    ["proxy:z-ai%2Fglm-5", "zai"],
    ["unknown-model", "other"],
  ])("identifies %s as %s", (model, provider) => {
    expect(providerOf(model)).toBe(provider);
  });
});
