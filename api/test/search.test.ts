import { afterEach, expect, it } from "vitest";
import { createServer, type RequestListener } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, getSetting } from "../src/db";
import { unseal } from "../src/auth";
import { BraveSearch, executeSearch, publicSearchSettings, saveSearchSettings, searchConfigured, SEARCH_WARNING } from "../src/search";
const secret = "search-test-secret-more-than-thirty-two-characters";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function server(handler: RequestListener) {
  const s = createServer(handler); await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}
it("seals keys, never returns them, preserves blank and supports clearing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gond-search-")), db = openStore(dir);
  cleanup.push(() => rmSync(dir, { recursive: true, force: true })); cleanup.push(() => { db.close(); });
  expect(searchConfigured(db)).toBe(false);
  await expect(executeSearch(db, secret, { query: "test" }, new AbortController().signal)).rejects.toThrow("unavailable");
  saveSearchSettings(db, secret, { provider: "brave", apiKey: "private-search-key" });
  const saved = getSetting<{ secret: string }>(db, "web-search")!;
  expect(saved.secret).not.toContain("private-search-key"); expect(unseal(secret, saved.secret)).toBe("private-search-key");
  expect(JSON.stringify(publicSearchSettings(db))).not.toContain("private-search-key");
  saveSearchSettings(db, secret, { provider: "brave", apiKey: "" }); expect(searchConfigured(db)).toBe(true);
  saveSearchSettings(db, secret, { provider: "brave", clearKey: true }); expect(searchConfigured(db)).toBe(false);
  expect(SEARCH_WARNING).toContain("untrusted text");
});
it("uses a real HTTP provider with bounded results", async () => {
  let auth = "", count = "", query = "";
  const url = await server((req, res) => {
    auth = String(req.headers["x-subscription-token"]); const u = new URL(req.url!, "http://test"); count = u.searchParams.get("count")!; query = u.searchParams.get("q")!;
    res.end(JSON.stringify({ web: { results: Array.from({ length: 20 }, () => ({ title: "t".repeat(1000), url: "https://example.com", description: "s".repeat(3000) })) } }));
  });
  const rows = await new BraveSearch("fixture-key", url).search("query", 5, AbortSignal.timeout(2000));
  expect({ auth, count, query }).toEqual({ auth: "fixture-key", count: "5", query: "query" });
  expect(rows).toHaveLength(5); expect(rows[0].title).toHaveLength(240); expect(rows[0].snippet).toHaveLength(1500);
  console.log("Mock search runtime: 5 results, title=240 chars, snippet=1500 chars; key sent only as header");
});
it("rejects oversized responses, redirects and reports plain auth/rate errors", async () => {
  const url = await server((req, res) => {
    if (req.url?.startsWith("/big")) return void res.end("x".repeat(1024 * 1024 + 1));
    if (req.url?.startsWith("/redirect")) return void res.writeHead(302, { location: "/target" }).end();
    res.writeHead(req.url?.startsWith("/rate") ? 429 : 401).end("private-search-key");
  });
  for (const [path, message] of [["big", "exceeded"], ["redirect", "reach"], ["rate", "Retry later"], ["auth", "invalid"]]) {
    await expect(new BraveSearch("private-search-key", `${url}/${path}`).search("q", 1, AbortSignal.timeout(2000))).rejects.toThrow(message);
  }
});
