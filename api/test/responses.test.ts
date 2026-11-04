import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as adapters from "../src/adapters";
import { openStore } from "../src/db";
import { saveProviderSettings } from "../src/providers";
import { modelResponse } from "../src/responses";

const secret = "relay-test-secret-with-at-least-thirty-two-characters";
const dropped = () => new DOMException("private-upstream-detail", "AbortError");
let dir: string, db: ReturnType<typeof openStore>;
const request = (signal?: AbortSignal) => new Request("http://worker/v1/responses", {
  method: "POST", signal,
  body: JSON.stringify({ model: "p:m", messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] }),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gond-relay-abort-"));
  db = openStore(dir);
  saveProviderSettings(db, secret, { connections: [{
    id: "p", name: "P", format: "openai", baseURL: "http://provider.invalid/v1", discover: false,
    models: [{ id: "m", name: "M", contextWindow: 4096, maxOutput: 1024, reasoning: "none", images: false }],
  }] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("model relay abort handling", () => {
  it.each([
    ["error", { error:{type:"server_error",message:"private-upstream-detail"} }, "provider_unavailable", true],
    ["error", { type:"server_error",message:"private-upstream-detail" }, "provider_unavailable", true],
    ["response.failed", { response:{error:{code:"overloaded"}} }, "provider_unavailable", true],
    ["response.incomplete", { response:{incomplete_details:{reason:"server_error"}} }, "provider_unavailable", true],
    ["response.failed", { response:{error:{code:"insufficient_quota"}} }, "provider_quota", false],
    ["error", { error:{code:"unknown-secret",message:"private-upstream-detail"} }, "provider_error", false],
  ])("terminates %s with a single normalized failure", async (kind, data, code, retryable) => {
    saveProviderSettings(db, secret, {connections:[{id:"p",name:"P",format:"openai-responses",baseURL:"http://provider.invalid/v1",discover:false,
      models:[{id:"m",name:"M",contextWindow:4096,maxOutput:1024,reasoning:"none",images:false}]}]});
    vi.spyOn(adapters, "callProvider").mockResolvedValue(new Response(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`, {headers:{"content-type":"text/event-stream"}}));
    const response = await modelResponse(db, secret, "u", "r", request());
    const body = await response.text();
    expect(body).toContain(`"code":"${code}"`);
    expect(body).toContain(`"retryable":${retryable}`);
    expect((body.match(/event: error/g) ?? [])).toHaveLength(1);
    expect(body).not.toMatch(/response.end|truncated|private-upstream-detail|unknown-secret/);
  });

  it("surfaces provider usage resets without retrying billing or usage limits", async () => {
    vi.spyOn(adapters, "callProvider").mockResolvedValue(new Response(JSON.stringify({error:{code:"usage_limit_reached",resets_at:1900000000,message:"secret"}}), {status:429}));
    const response = await modelResponse(db, secret, "u", "r", request());
    expect(await response.json()).toMatchObject({error:{code:"provider_usage_limit",retryable:false,reset_at:1900000000,message:expect.stringContaining("2030-03-17T17:46:40.000Z")}});
  });

  it("passes a bounded Retry-After from provider HTTP errors", async () => {
    vi.spyOn(adapters, "callProvider").mockResolvedValue(new Response("{}", {status:429,headers:{"retry-after":"30"}}));
    const response = await modelResponse(db, secret, "u", "r", request());
    expect(await response.json()).toMatchObject({error:{code:"provider_rate_limit",retryable:true,retry_after_ms:30000}});
  });
  it("returns a safe retryable error for an upstream AbortError before headers", async () => {
    vi.spyOn(adapters, "callProvider").mockRejectedValue(dropped());
    const response = await modelResponse(db, secret, "u", "r", request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: {
      code: "stream", message: "The connection to the model dropped. Try again.", retryable: true,
    } });
    expect(console.error).toHaveBeenCalledWith("model request failed", "AbortError");
  });

  it("emits a safe retryable stream error when upstream aborts after headers", async () => {
    vi.spyOn(adapters, "callProvider").mockResolvedValue(new Response(new ReadableStream({
      start(out) { out.error(dropped()); },
    })));
    const response = await modelResponse(db, secret, "u", "r", request());
    const body = await response.text();
    expect(body).toContain('event: error');
    expect(body).toContain('"retryable":true');
    expect(body).not.toMatch(/response.end|private-upstream-detail|AbortError/);
  });

  it("does not turn worker cancellation before headers into a retryable error", async () => {
    const cancel = new AbortController(), error = dropped();
    vi.spyOn(adapters, "callProvider").mockImplementation(async () => { cancel.abort(); throw error; });
    await expect(modelResponse(db, secret, "u", "r", request(cancel.signal))).rejects.toBe(error);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("does not emit retryable errors or usage after downstream stream cancellation", async () => {
    const cancel = new AbortController();
    let upstream!: ReadableStreamDefaultController<Uint8Array>, signal!: AbortSignal;
    vi.spyOn(adapters, "callProvider").mockImplementation(async (_connection, _secret, _up, inputSignal) => {
      signal = inputSignal;
      return new Response(new ReadableStream<Uint8Array>({ start(out) { upstream = out; } }));
    });
    const response = await modelResponse(db, secret, "u", "r", request(cancel.signal));
    cancel.abort();
    upstream.error(dropped());
    expect(signal.aborted).toBe(true);
    expect(await response.text()).toBe("");
    expect(db.prepare("SELECT count(*) AS n FROM usage").get()).toEqual({ n: 0 });
    expect(console.error).not.toHaveBeenCalled();
  });
});
