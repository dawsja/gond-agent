import { describe, expect, it } from "vitest";
import { changeFormat, DEFAULT_URLS, newModel, type Connection } from "../../web/src/lib/provider-settings";

const connection = (): Connection => ({ id: "fixture", name: "Fixture", format: "openai", baseURL: DEFAULT_URLS.openai, hasKey: false, apiKey: "typed-key", discover: true, models: [newModel("test")] });
describe("provider form defaults and discovery", () => {
  it("switches built-in URLs with the API format without carrying a typed credential across providers", () => {
    const anthropic = { ...connection(), ...changeFormat(connection(), "anthropic") };
    expect(anthropic.baseURL).toBe(DEFAULT_URLS.anthropic);
    expect(anthropic.apiKey).toBe("");
    expect(changeFormat(anthropic, "openai-responses").baseURL).toBe(DEFAULT_URLS.openai);
    expect(changeFormat({ ...connection(), baseURL: "" }, "anthropic").baseURL).toBe(DEFAULT_URLS.anthropic);
  });
  it("preserves a custom proxy URL when switching formats", () => {
    expect(changeFormat({ ...connection(), baseURL: "https://proxy.example/custom/v1" }, "anthropic").baseURL).toBe("https://proxy.example/custom/v1");
  });
  it("uses conservative defaults for an optional manual model override", () => {
    expect(newModel("coder")).toEqual({ id: "coder", name: "coder", contextWindow: 128000, maxOutput: 8192, images: false, reasoning: "none" });
    expect(newModel("x".repeat(240)).name).toHaveLength(120);
  });
});
