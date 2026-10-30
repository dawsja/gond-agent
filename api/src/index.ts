import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { configFromEnv } from "./config";
import { openStore } from "./db";
import { createAuthentication } from "./auth";
import { ContainerPool } from "./containers";
import { Runs } from "./runs/service";
import { createApp } from "./app";
import { Scheduler } from "./scheduler";
const cfg = configFromEnv(),
  db = openStore(cfg.data),
  auth = await createAuthentication(db, cfg),
  pool = new ContainerPool(cfg);
await pool.recover();
const runs = new Runs(db, cfg, (id, handler) => pool.start(id, handler));
await runs.recover();
const { app, tickets } = createApp(db, cfg, auth, runs);
const server = serve({
  fetch: (request, env) => {
    const headers = new Headers(request.headers);
    const peer = env.incoming.socket.remoteAddress ?? "unknown";
    const forwarded =
      process.env.TRUST_PROXY === "true"
        ? headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        : null;
    headers.set("x-gond-agent-client-ip", forwarded || peer);
    return app.fetch(new Request(request, { headers }));
  },
  port: cfg.port,
  hostname: process.env.BIND_ADDRESS ?? "0.0.0.0",
});
const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", cfg.origin),
    id = /^\/ws\/runs\/(run_[a-f0-9]{24})$/.exec(url.pathname)?.[1],
    token = url.searchParams.get("ticket") ?? "",
    ticket = tickets.get(token);
  tickets.delete(token);
  if (
    req.headers.origin !== cfg.origin ||
    !id ||
    !ticket ||
    ticket.run !== id ||
    ticket.expires < Date.now()
  ) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  try {
    runs.get(id, ticket.user);
  } catch {
    return socket.destroy();
  }
  sockets.handleUpgrade(req, socket, head, (ws) => {
    const send = (ev: unknown) => {
      if (ws.readyState === ws.OPEN) {
        if (ws.bufferedAmount > 8_000_000) return ws.close(1013);
        ws.send(JSON.stringify(ev));
      }
    };
    let after = Math.max(0, Number(url.searchParams.get("after")) || 0);
    while (true) {
      const batch = runs.history(id, after);
      for (const e of batch) send(e);
      if (batch.length < 2000) break;
      after = batch.at(-1).seq;
    }
    const r = runs.get(id);
    send({
      type: "run.info",
      status: r.status,
      phase: r.phase,
      pr: r.pr_number ? { number: r.pr_number, url: r.pr_url } : null,
    });
    const listener = (ev: unknown) => send(ev);
    runs.events.on(id, listener);
    ws.on("message", () => send({ type: "pong" }));
    ws.on("close", () => runs.events.off(id, listener));
    ws.on("error", () => ws.close());
  });
});
const scheduler = new Scheduler(db, runs);
const timer = setInterval(() => void scheduler.tick(), 60_000);
void scheduler.tick();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  sockets.clients.forEach((s) => s.close());
  await runs.shutdown();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
console.log(`Gond Agent listening on ${cfg.origin}`);
