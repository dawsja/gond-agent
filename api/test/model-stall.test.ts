import { createServer, type ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { callProvider } from "../src/adapters";
import { modelStallMs } from "../src/config";
import type { ProviderConnection } from "../src/providers";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(server => {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  }));
});
async function provider(handler: (res: ServerResponse) => void) {
  const server = createServer((_req, res) => handler(res)); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as {port:number}).port;
  return {baseURL:`http://127.0.0.1:${port}`,format:"openai"} as ProviderConnection;
}
it.each([false, true])("aborts a stalled provider, headers received=%s", async headers => {
  vi.stubEnv("MODEL_STALL_MINUTES", "0.002");
  const connection = await provider(res => {
    if (headers) { res.writeHead(200); res.flushHeaders(); res.write("first"); }
  });
  const request = callProvider(connection, "secret", {path:"/responses",body:{}}, new AbortController().signal);
  if (headers) await expect((await request).text()).rejects.toThrow();
  else await expect(request).rejects.toMatchObject({code:"provider_connection",retryable:true});
});
it("allows a slow but progressing stream beyond the stall window", async () => {
  vi.stubEnv("MODEL_STALL_MINUTES", "0.005");
  const connection = await provider(res => {
    res.writeHead(200); res.flushHeaders();
    let chunks = 0;
    const timer = setInterval(() => { res.write("progress\n"); if (++chunks === 8) {clearInterval(timer);res.end();} }, 80);
    res.on("close", () => clearInterval(timer));
  });
  const response = await callProvider(connection, "secret", {path:"/responses",body:{}}, new AbortController().signal);
  expect(await response.text()).toBe("progress\n".repeat(8));
});
it("supports disabling the guard and still honors caller cancellation", async () => {
  vi.stubEnv("MODEL_STALL_MINUTES", "0");
  expect(modelStallMs()).toBe(0);
  const connection = await provider(res => {res.writeHead(200);res.flushHeaders();});
  const abort = new AbortController();
  const response = await callProvider(connection, "secret", {path:"/responses",body:{}}, abort.signal);
  abort.abort();
  await expect(response.text()).rejects.toThrow();
});
it("validates the configured stall window", () => {
  vi.stubEnv("MODEL_STALL_MINUTES", "-1"); expect(() => modelStallMs()).toThrow("Invalid MODEL_STALL_MINUTES");
  vi.stubEnv("MODEL_STALL_MINUTES", "10"); expect(modelStallMs()).toBe(600_000);
});
