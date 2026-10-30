import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openStore } from "../src/db";
import { providerSettings, publicProviderSettings, saveProviderSettings, testProvider, transcribe, modelId } from "../src/providers";
import { modelFor, publicModels } from "../src/models";
import { callProvider } from "../src/adapters";
import { sameModel } from "../src/adapters/common";
import { modelResponse } from "../src/responses";

const secret = "test-secret-with-more-than-thirty-two-characters";
const model = { id: "org/coder.v1", name: "Coder", contextWindow: 128000, maxOutput: 8192, reasoning: "none", images: true };
let dir: string, db: ReturnType<typeof openStore>, server: Server, origin: string;
let seen: { path: string; headers: Record<string, unknown>; body: string }[];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gond-agent-providers-")); db = openStore(dir); seen = [];
  server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    seen.push({ path: req.url!, headers: req.headers, body: Buffer.concat(parts).toString() });
    if (req.url!.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: model.id }] })); return; }
    if (req.url!.endsWith("/audio/transcriptions")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ text: "Fix the tests" })); return; }
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
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); rmSync(dir, { recursive: true, force: true }); });
const settings = (format = "openai", baseURL = origin + "/custom/v1") => ({
  connections: [{ id: "local", name: "Local", format, baseURL, apiKey: "private-provider-key", models: [model] }],
  defaultModel: modelId("local", model.id), transcription: null,
});
describe("provider settings and request routing", () => {
  it("starts empty, encrypts keys, persists settings and preserves a blank update", () => {
    expect(publicModels(db).models).toEqual([]);
    expect(() => modelFor(db, "auto")).toThrow(/Complete model setup/);
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
  it("validates URLs, IDs, default models, capabilities and optional transcription", () => {
    for (const url of ["file:///tmp/key", "https://user:key@example.com/v1", "https://api.example/v1?key=secret", "https://api.example/#key"]) {
      expect(() => saveProviderSettings(db, secret, settings("openai", url))).toThrow();
    }
    expect(() => saveProviderSettings(db, secret, { ...settings(), defaultModel: "other:model" })).toThrow();
    const duplicate = settings(); duplicate.connections.push(duplicate.connections[0]);
    expect(() => saveProviderSettings(db, secret, duplicate)).toThrow(/unique/);
    expect(() => saveProviderSettings(db, secret, { ...settings(), transcription: { connectionId: "missing", model: "whisper-1" } })).toThrow();
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
  it("tests saved connections and sends optional audio as a multipart file", async () => {
    const config = { ...settings(), transcription: { connectionId: "local", model: "speech-model" } };
    saveProviderSettings(db, secret, config);
    expect(await testProvider(db, secret, "local")).toEqual({ models: [model.id] });
    const audio = new TextEncoder().encode("test-audio");
    expect(await transcribe(db, secret, audio.buffer, "audio/wav", "en")).toEqual({ text: "Fix the tests" });
    const request = seen[1];
    expect(request.path).toBe("/custom/v1/audio/transcriptions");
    expect(request.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(request.body).toContain('filename="recording.wav"');
    expect(request.body).toContain("speech-model"); expect(request.body).toContain("test-audio");
    expect(request.headers.authorization).toBe("Bearer private-provider-key");
  });
  it("supports a local API without a key, and leaves voice disabled until configured", async () => {
    const config = settings(); config.connections[0].apiKey = "";
    saveProviderSettings(db, secret, config);
    await testProvider(db, secret, "local");
    expect(seen[0].headers.authorization).toBeUndefined();
    await expect(transcribe(db, secret, new ArrayBuffer(2), "audio/wav")).rejects.toMatchObject({ code: "transcription_required" });
  });
  it("migrates old profile preferences without losing account or run data", () => {
    db.close();
    const old = new Database(join(dir, "gond-agent.sqlite"));
    old.exec("ALTER TABLE profiles ADD COLUMN obsolete_preference INTEGER NOT NULL DEFAULT 0; INSERT INTO profiles(user_id,issue_runs,fix_checks,auto_pr,obsolete_preference) VALUES('u',1,1,0,1); CREATE TABLE models(id TEXT PRIMARY KEY); INSERT INTO models VALUES('obsolete-model'); INSERT INTO settings VALUES('kept','true');"); old.close();
    db = openStore(dir);
    expect(db.prepare("SELECT * FROM profiles WHERE user_id='u'").get()).toEqual({ user_id: "u", issue_runs: 1, fix_checks: 1, auto_pr: 0 });
    expect(db.prepare("SELECT value FROM settings WHERE key='kept'").get()).toEqual({ value: "true" });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='models'").get()).toBeUndefined();
  });
});
