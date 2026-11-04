import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { providerFailure, providerStreamFailure } from "../src/adapters/errors";
import { chatgptFailure } from "../src/subscriptions/chatgpt";
import { modelErrors, modelPolicy, modelReason, retryAfterMs } from "../src/model-errors";

describe("shared model error policy", () => {
  it("covers every code emitted by the provider and subscription classifiers", () => {
    for (const path of ["adapters/errors.ts", "subscriptions/chatgpt.ts"]) {
      const source = readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
      const codes = [...source.matchAll(/modelFailure\(\d+, "([a-z_]+)"\)/g)].map(m => m[1]);
      expect(codes.length).toBeGreaterThan(5);
      for (const code of codes) expect(modelPolicy(code).code, code).toBe(code);
    }
    for (const policy of Object.values(modelErrors)) {
      expect(typeof policy.retryable).toBe("boolean");
      expect(policy.message).not.toMatch(/https?:|sk-|\n/);
    }
    expect(modelPolicy("unknown_provider_secret")).toMatchObject({ code:"unknown", retryable:false });
  });

  it("rejects malformed policy shapes when loading the module", async () => {
    const unknown = { retryable:false, message:"Unknown failure." };
    for (const table of [null, [], {}, {unknown, broken:{}}, {unknown, broken:{retryable:"false",message:"Bad"}}, {unknown, broken:{retryable:false}}, {unknown, broken:{retryable:false,message:42}}, {unknown, broken:null}]) {
      vi.resetModules();
      vi.doMock("node:fs", async (original) => ({
        ...await original<typeof import("node:fs")>(),
        readFileSync: vi.fn(() => JSON.stringify(table)),
      }));
      try {
        await expect(import("../src/model-errors")).rejects.toThrow(/model error policy/i);
      } finally {
        vi.doUnmock("node:fs");
        vi.resetModules();
      }
    }
  });

  it.each([
    [503, {}, "provider_unavailable", true],
    [529, {}, "provider_unavailable", true],
    [429, { error:{code:"insufficient_quota"} }, "provider_quota", false],
    [402, {}, "provider_quota", false],
    [429, { error:{message:"You exceeded your current quota. Check billing."} }, "provider_quota", false],
    [400, { error:{type:"invalid_request_error",message:"Your credit balance is too low."} }, "provider_quota", false],
    [401, {}, "provider_auth", false],
    [400, {}, "provider_request", false],
    [400, { error:{code:"context_length_exceeded"} }, "context_exceeded", false],
    [0, { error:{type:"server_error"} }, "provider_unavailable", true],
    [0, { response:{error:{code:"overloaded"}} }, "provider_unavailable", true],
    [0, { error:{code:"unrecognized"} }, "provider_error", false],
  ])("classifies status %s and never leaks provider prose", (status, body, code, retryable) => {
    const failure = providerFailure(status, body);
    expect(failure).toMatchObject({ code, retryable, message:modelErrors[code].message });
  });

  it("normalizes SSE errors and keeps subscription reset metadata without retrying limits", () => {
    expect(providerStreamFailure({ error:{type:"server_error",message:"https://private.invalid sk-secret"} })).toMatchObject({event:"error",data:{code:"provider_unavailable",retryable:true}});
    expect(chatgptFailure(0, {error:{code:"context_length_exceeded"}}).error).toMatchObject({code:"context_exceeded",retryable:false});
    const failure = chatgptFailure(0, {error:{code:"subscription_sharing_usage_limit_exceeded"}}).error;
    expect(failure).toMatchObject({code:"chatgpt_usage_limit",retryable:false});
    expect(modelReason(failure.code, 429, 1900000000)).toContain("2030-03-17T17:46:40.000Z");
    expect(modelReason("untrusted", "HTTP 503 secret", "secret")).not.toContain("secret");
  });

  it("parses seconds and HTTP dates and caps server waits at 120 seconds", () => {
    expect(retryAfterMs("8")).toBe(8000);
    expect(retryAfterMs("999")).toBe(120000);
    expect(retryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT", Date.parse("Wed, 21 Oct 2015 07:27:00 GMT"))).toBe(60000);
    expect(retryAfterMs("not a delay")).toBeUndefined();
  });
});
