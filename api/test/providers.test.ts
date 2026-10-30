import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openStore, setSetting } from "../src/db";
import { providerSettings, publicProviderSettings, saveProviderSettings, discoverProviderModels, modelId, setupComplete } from "../src/providers";
import { loadModelCatalog, modelFor, publicModels, resolveModel } from "../src/models";
import { callProvider } from "../src/adapters";
import { sameModel } from "../src/adapters/common";
import { modelResponse } from "../src/responses";

const secret = "test-secret-with-more-than-thirty-two-characters";
const model = { id: "org/coder.v1", name: "Coder", contextWindow: 128000, maxOutput: 8192, reasoning: "none", images: true };
let dir: string, db: ReturnType<typeof openStore>, server: Server, origin: string;
let seen: { path: string; headers: Record<string, unknown>; body: string }[];
let modelFailure: boolean;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gond-agent-providers-")); db = openStore(dir); seen = []; modelFailure = false;
  server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    seen.push({ path: req.url!, headers: req.headers, body: Buffer.concat(parts).toString() });
    const url = new URL(req.url!, "http://fixture");
    if (url.pathname.endsWith("/models")) {
      if (modelFailure) { res.writeHead(503).end(); return; }
      if (url.pathname.startsWith("/unsupported/")) { res.writeHead(404); res.end(); return; }
      if (url.pathname.startsWith("/denied/")) { res.writeHead(401); res.end("private-provider-key"); return; }
      if (url.pathname.startsWith("/redirect/")) { res.writeHead(307, { location: origin + "/leak" }); res.end(); return; }
      res.setHeader("content-type", "application/json");
      if (url.pathname.startsWith("/malformed/")) { res.end(JSON.stringify({ message: "private-provider-key" })); return; }
      const next = url.searchParams.get("after_id");
      if (url.pathname.startsWith("/paged/")) {
        res.end(JSON.stringify({ data: next ? [{ id: "second" }, { id: model.id }] : [{ id: model.id }], has_more: !next, last_id: next ? "second" : model.id })); return;
      }
      if (url.pathname.startsWith("/endless/")) {
        res.end(JSON.stringify({ data: [{ id: `page-${next ?? "first"}` }], has_more: true, last_id: `${next ?? "first"}-next` })); return;
      }
      res.end(JSON.stringify({ data: [{ id: model.id, display_name: "Coder", max_input_tokens: 200000, max_tokens: 16000, capabilities: { image_input: { supported: true } } }, null, { id: "" }, { id: model.id, display_name: "Coder", max_input_tokens: 200000, max_tokens: 16000, capabilities: { image_input: { supported: true } } }] })); return;
    }
    if (req.url!.endsWith("/redirect")) { res.writeHead(307, { location: origin + "/leak" }); res.end(); return; }
    res.setHeader("content-type", "text/event-stream");
    const body = JSON.parse(Buffer.concat(parts).toString());
    if (req.url!.endsWith("/messages")) {
      res.end(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", usage: { input_tokens: 4, output_tokens: 0 } } })}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`);
    } else if (req.url!.endsWith("/responses")) {
      res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\nevent: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"m1"}}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"Hello"}\n\nevent: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"m1","content":[{"type":"output_text","text":"Hello"}]}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}\n\n');
    } else {
      res.end(`data: ${JSON.stringify({ id: "c1", model: body.model, choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }] })}\n\ndata: {"id":"c1","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\ndata: [DONE]\n\n`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); rmSync(dir, { recursive: true, force: true }); });
const settings = (format = "openai", baseURL = origin + "/custom/v1") => ({
  connections: [{ id: "local", name: "Local", format, baseURL, apiKey: "private-provider-key", discover: false, models: [model] }],
  defaultModel: modelId("local", model.id),
});
describe("provider settings and request routing", () => {
  it("starts empty, encrypts keys, persists settings and preserves a blank update", () => {
    expect(publicModels(db).models).toEqual([]);
    expect(() => modelFor(db, "auto")).toThrow(/No models are available/);
    saveProviderSettings(db, secret, settings());
    expect(JSON.stringify(publicProviderSettings(db))).not.toContain("private-provider-key");
    expect(providerSettings(db).connections[0].secret).not.toContain("private-provider-key");
    const shown = publicProviderSettings(db);
    saveProviderSettings(db, secret, { ...shown, connections: shown.connections.map(c => ({ ...c, apiKey: "" })) });
    expect(publicProviderSettings(db).connections[0].hasKey).toBe(true);
    const reopened = openStore(dir);
    expect(modelFor(reopened, "auto").upstream_id).toBe(model.id); reopened.close();
    expect(modelFor(db, "auto").connection_id).toBe("local");
  });
  it("validates URLs, IDs, default models and capabilities", () => {
    for (const url of ["file:///tmp/key", "https://user:key@example.com/v1", "https://api.example/v1?key=secret", "https://api.example/#key"]) {
      expect(() => saveProviderSettings(db, secret, settings("openai", url))).toThrow();
    }
    expect(() => saveProviderSettings(db, secret, { ...settings(), defaultModel: "other:model" })).toThrow();
    const duplicate = settings(); duplicate.connections.push(duplicate.connections[0]);
    expect(() => saveProviderSettings(db, secret, duplicate)).toThrow(/unique/);
    const badThinking = settings(); badThinking.connections[0].models = [{ ...model, reasoning: "adaptive" }];
    expect(() => saveProviderSettings(db, secret, badThinking)).toThrow(/Anthropic/);
    const huge = settings(); huge.connections[0].models = [{ ...model, maxOutput: model.contextWindow + 1 }];
    expect(() => saveProviderSettings(db, secret, huge)).toThrow();
  });
  it("does not silently send a saved key to a changed URL or API format", () => {
    saveProviderSettings(db, secret, settings());
    const shown = publicProviderSettings(db);
    expect(() => saveProviderSettings(db, secret, { ...shown, connections: shown.connections.map(c => ({ ...c, baseURL: origin + "/other/v1" })) })).toThrow(/Re-enter or clear/);
    saveProviderSettings(db, secret, { ...shown, connections: shown.connections.map(c => ({ ...c, baseURL: origin + "/other/v1", clearKey: true })) });
    expect(publicProviderSettings(db).connections[0].hasKey).toBe(false);
  });
  for (const [format, path] of [["anthropic", "/messages"], ["openai", "/chat/completions"], ["openai-responses", "/responses"]]) {
    it(`streams ${format} directly through its custom API prefix and records usage`, async () => {
      saveProviderSettings(db, secret, settings(format));
      const req = new Request("http://gond-agent/v1/responses", { method: "POST", body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] }) });
      const response = await modelResponse(db, secret, "user", "run", req), stream = await response.text();
      expect(stream).toContain("Hello"); expect(stream).toContain("response.end");
      expect(stream).not.toContain("private-provider-key");
      expect(seen[0].path).toBe("/custom/v1" + path);
      expect(JSON.parse(seen[0].body).model).toBe(model.id);
      expect(seen[0].body).not.toContain("providerOptions");
      if (format === "anthropic") {
        expect(seen[0].headers["x-api-key"]).toBe("private-provider-key");
        expect(seen[0].headers["anthropic-version"]).toBe("2023-06-01");
        expect(seen[0].headers.authorization).toBeUndefined();
      } else expect(seen[0].headers.authorization).toBe("Bearer private-provider-key");
      expect(db.prepare("SELECT input,output FROM usage").get()).toEqual({ input: 4, output: 2 });
    });
  }
  it("rejects redirects without forwarding credentials to the redirect target", async () => {
    saveProviderSettings(db, secret, settings());
    await expect(callProvider(providerSettings(db).connections[0], secret, { path: "redirect", body: {} }, new AbortController().signal)).rejects.toMatchObject({ code: "provider_connection" });
    expect(seen.map(r => r.path)).toEqual(["/custom/v1/redirect"]);
  });
  it("does not replay opaque reasoning across connections with the same upstream model ID", () => {
    saveProviderSettings(db, secret, settings());
    const current = modelFor(db, "auto");
    expect(sameModel(current.id, current)).toBe(true);
    expect(sameModel(modelId("other", model.id), current)).toBe(false);
    expect(sameModel(model.id, current)).toBe(false);
  });
  for (const format of ["anthropic", "openai", "openai-responses"]) {
    it(`discovers ${format} models and metadata before saving any settings`, async () => {
      const result = await discoverProviderModels(db, secret, settings(format).connections[0]);
      expect(result).toEqual({ supported: true, truncated: false, models: [{ id: model.id, name: "Coder", contextWindow: 200000, maxOutput: 16000, images: true }] });
      expect(providerSettings(db)).toEqual({ connections: [], defaultModel: "" });
      expect(JSON.stringify(result)).not.toContain("private-provider-key");
      const url = new URL(seen[0].path, origin);
      expect(url.pathname).toBe("/custom/v1/models");
      if (format === "anthropic") {
        expect(seen[0].headers["x-api-key"]).toBe("private-provider-key");
        expect(seen[0].headers["anthropic-version"]).toBe("2023-06-01");
        expect(seen[0].headers.authorization).toBeUndefined();
      } else expect(seen[0].headers.authorization).toBe("Bearer private-provider-key");
    });
  }
  it("supports discovery for a local API without a key", async () => {
    const config = settings(); config.connections[0].apiKey = "";
    await discoverProviderModels(db, secret, config.connections[0]);
    expect(seen[0].headers.authorization).toBeUndefined();
  });
  it("reuses a saved key only for the same endpoint and format", async () => {
    saveProviderSettings(db, secret, settings());
    const shown = publicProviderSettings(db).connections[0];
    await expect(discoverProviderModels(db, secret, { ...shown, baseURL: origin + "/changed/v1" })).rejects.toMatchObject({ code: "replace_key" });
    await expect(discoverProviderModels(db, secret, { ...shown, format: "anthropic" })).rejects.toMatchObject({ code: "replace_key" });
    expect(seen).toHaveLength(0);
    await discoverProviderModels(db, secret, shown);
    expect(seen[0].headers.authorization).toBe("Bearer private-provider-key");
    await discoverProviderModels(db, secret, { ...shown, baseURL: origin + "/changed/v1", clearKey: true });
    expect(seen[1].headers.authorization).toBeUndefined();
    expect(publicProviderSettings(db).connections[0].hasKey).toBe(true);
  });
  it("paginates Anthropic models on the same endpoint and deduplicates IDs", async () => {
    const result = await discoverProviderModels(db, secret, settings("anthropic", origin + "/paged/v1").connections[0]);
    expect(result.models.map(m => m.id)).toEqual([model.id, "second"]);
    expect(result.truncated).toBe(false);
    expect(seen).toHaveLength(2);
    expect(new URL(seen[1].path, origin).searchParams.get("after_id")).toBe(model.id);
  });
  it("bounds pagination and leaves unsupported providers available for manual entry", async () => {
    const endless = await discoverProviderModels(db, secret, settings("anthropic", origin + "/endless/v1").connections[0]);
    expect(endless.models).toHaveLength(5);
    expect(endless.truncated).toBe(true);
    expect(seen).toHaveLength(5);
    expect(await discoverProviderModels(db, secret, settings("openai", origin + "/unsupported/v1").connections[0])).toEqual({ supported: false, models: [], truncated: false });
  });
  it("rejects discovery redirects, malformed lists and authentication failures without leaking upstream details", async () => {
    for (const path of ["denied", "redirect", "malformed"]) {
      await expect(discoverProviderModels(db, secret, settings("openai", `${origin}/${path}/v1`).connections[0])).rejects.toMatchObject({ code: "provider_connection" });
    }
    expect(seen.some(request => request.path === "/leak")).toBe(false);
  });
  it("removes retired audio configuration on reopen without losing model connections or keys", () => {
    saveProviderSettings(db, secret, settings());
    const saved = providerSettings(db);
    setSetting(db, "providers", { ...saved, transcription: { connectionId: "local", model: "retired" } });
    expect(publicProviderSettings(db)).not.toHaveProperty("transcription");
    const reopened = openStore(dir);
    try {
      expect(providerSettings(reopened)).toEqual(saved);
      expect((reopened.prepare("SELECT value FROM settings WHERE key='providers'").get() as { value: string }).value).not.toContain('"transcription"');
    } finally { reopened.close(); }
  });
  it("finishes provider setup without selecting models and combines live catalogs with connection-scoped IDs", async () => {
    saveProviderSettings(db, secret, { connections: [
      { id: "first", name: "First key", format: "openai", baseURL: origin + "/first/v1", apiKey: "first-key" },
      { id: "second", name: "Second key", format: "openai-responses", baseURL: origin + "/second/v1", apiKey: "second-key" },
    ] });
    expect(setupComplete(db)).toBe(true);
    expect(providerSettings(db).connections.every(c => c.models.length === 0 && c.discover)).toBe(true);
    const [catalog, concurrent] = await Promise.all([loadModelCatalog(db, secret), loadModelCatalog(db, secret)]);
    expect(catalog).toEqual(concurrent);
    expect(seen).toHaveLength(2);
    expect(catalog.models.map(m => m.id)).toEqual(["auto", modelId("first", model.id), modelId("second", model.id)]);
    expect(catalog.models[2]).toMatchObject({ display_name: "Coder · Second key", context_window: 200000, max_output: 16000, capabilities: { images: true } });
    expect(JSON.stringify(catalog)).not.toMatch(/first-key|second-key/);
    expect((await resolveModel(db, secret, modelId("second", model.id))).connection_id).toBe("second");
    const response = await modelResponse(db, secret, "user", "run", new Request("http://gond-agent/v1/responses", { method: "POST", body: JSON.stringify({ model: modelId("second", model.id), messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] }) }));
    expect(await response.text()).toContain("Hello");
    expect(seen.at(-1)!.path).toBe("/second/v1/responses");
    expect(seen.at(-1)!.headers.authorization).toBe("Bearer second-key");
    await loadModelCatalog(db, secret);
    expect(seen).toHaveLength(3);
  });
  it("keeps healthy connections and manual overrides usable when another catalog fails", async () => {
    saveProviderSettings(db, secret, { connections: [
      { id: "healthy", name: "Healthy", format: "openai", baseURL: origin + "/custom/v1" },
      { id: "failed", name: "Failed", format: "openai", baseURL: origin + "/denied/v1", apiKey: "private-provider-key" },
      { id: "manual", name: "Manual", format: "openai", baseURL: origin + "/unsupported/v1", models: [model] },
    ] });
    const catalog = await loadModelCatalog(db, secret);
    expect(catalog.models.map(m => m.id)).toEqual(["auto", modelId("healthy", model.id), modelId("manual", model.id)]);
    expect(catalog.connections.map(c => c.status)).toEqual(["ready", "error", "unsupported"]);
    expect(JSON.stringify(catalog)).not.toContain("private-provider-key");
  });
  it("does not expose cached models after a connection is removed or its credentials change", async () => {
    saveProviderSettings(db, secret, { connections: [{ id: "live", name: "Live", format: "openai", baseURL: origin + "/custom/v1", apiKey: "old-key" }] });
    await loadModelCatalog(db, secret);
    const shown = publicProviderSettings(db);
    saveProviderSettings(db, secret, { ...shown, connections: shown.connections.map(c => ({ ...c, baseURL: origin + "/changed/v1", apiKey: "new-key" })) });
    expect(publicModels(db).models).toHaveLength(0);
    await loadModelCatalog(db, secret);
    expect(seen.at(-1)!.path).toBe("/changed/v1/models");
    expect(seen.at(-1)!.headers.authorization).toBe("Bearer new-key");
    saveProviderSettings(db, secret, { connections: [{ id: "replacement", name: "Replacement", format: "openai", baseURL: origin + "/custom/v1", models: [model], discover: false }] });
    expect(publicModels(db).models.every(m => m.connection_id === "replacement")).toBe(true);
  });
  it("bounds refresh requests and retains known models when a catalog temporarily fails", async () => {
    saveProviderSettings(db, secret, { connections: [{ id: "live", name: "Live", format: "openai", baseURL: origin + "/custom/v1" }] });
    await loadModelCatalog(db, secret);
    await loadModelCatalog(db, secret, true);
    expect(seen).toHaveLength(1);
    modelFailure = true;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
    const catalog = await loadModelCatalog(db, secret);
    expect(catalog.models.map(m => m.id)).toEqual(["auto", modelId("live", model.id)]);
    expect(catalog.connections[0].status).toBe("error");
    expect(catalog.connections[0].message).toContain("previously loaded");
    expect(seen).toHaveLength(2);
  });
  it("migrates old profile preferences without losing account or run data", () => {
    db.close();
    const old = new Database(join(dir, "gond-agent.sqlite"));
    old.exec("ALTER TABLE profiles ADD COLUMN obsolete_preference INTEGER NOT NULL DEFAULT 0; ALTER TABLE profiles ADD COLUMN issue_runs INTEGER NOT NULL DEFAULT 0; ALTER TABLE profiles ADD COLUMN fix_checks INTEGER NOT NULL DEFAULT 0; INSERT INTO profiles(user_id,issue_runs,fix_checks,auto_pr,obsolete_preference) VALUES('u',1,1,0,1); CREATE TABLE models(id TEXT PRIMARY KEY); INSERT INTO models VALUES('obsolete-model'); INSERT INTO settings VALUES('kept','true');");
    const history = JSON.stringify({ id: "historical-run", source: "issue", checks: "failure", prompt: "Keep this history" });
    const event = JSON.stringify({ type: "user", text: "Historical automated message", source: { kind: "checks", sha: "abc123" } });
    old.prepare("INSERT INTO runs(id,user_id,repo,status,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?)").run("historical-run", "u", "acme/app", "ready", 1, 1, history);
    old.prepare("INSERT INTO events(run_id,data) VALUES(?,?)").run("historical-run", event);
    old.close();
    db = openStore(dir);
    expect(db.prepare("SELECT * FROM profiles WHERE user_id='u'").get()).toEqual({ user_id: "u", auto_pr: 0 });
    expect(db.prepare("SELECT value FROM settings WHERE key='kept'").get()).toEqual({ value: "true" });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='models'").get()).toBeUndefined();
    expect(db.prepare("SELECT data FROM runs WHERE id='historical-run'").get()).toEqual({ data: history });
    expect(db.prepare("SELECT data FROM events WHERE run_id='historical-run'").get()).toEqual({ data: event });
  });
});
