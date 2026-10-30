import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomBytes } from "node:crypto";
import type { Store } from "./db";
import type { Config } from "./config";
import type { Authentication } from "./auth";
import type { Runs } from "./runs/service";
import { gh, githubStatus, validRepo } from "./github";
import { ApiError } from "./wire";
import { publicModels } from "./models";
import { publicProviderSettings, saveProviderSettings, setupComplete, testProvider, transcribe } from "./providers";
import { listRunners, saveRunner } from "./scheduler";
import { serveStatic } from "@hono/node-server/serve-static";
import { join } from "node:path";
export interface Ticket {
  run: string;
  user: string;
  expires: number;
}
export function createApp(
  db: Store,
  cfg: Config,
  authentication: Authentication,
  runs: Runs,
) {
  const app = new Hono<{
    Variables: {
      user: { id: string; name: string; email: string; image?: string | null };
      session: { token: string; createdAt: Date };
      admin: boolean;
    };
  }>();
  const tickets = new Map<string, Ticket>();
  app.onError((e, c) => {
    if (e instanceof ApiError)
      return c.json(
        { error: { code: e.code, message: e.message, retryable: e.retryable } },
        e.status as 400,
      );
    console.error(e);
    return c.json(
      {
        error: {
          code: "internal",
          message: "Something went wrong. Check the host logs and try again.",
        },
      },
      500,
    );
  });
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Frame-Options", "DENY");
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 12 * 1024 * 1024,
      onError: (c) =>
        c.json(
          {
            error: { code: "too_large", message: "The request is too large." },
          },
          413,
        ),
    }),
  );
  app.get("/health", (c) => {
    db.prepare("SELECT 1").get();
    return c.json({ ok: true });
  });
  app.get("/api/auth/providers", (c) =>
    c.json({ providers: authentication.providers() }),
  );
  let signupQueue: Promise<unknown> = Promise.resolve();
  app.on(["GET", "POST"], "/api/auth/*", (c) => {
    if (c.req.path === "/api/auth/sign-up/email" && c.req.method === "POST") {
      const result = signupQueue.then(() =>
        authentication.current.handler(c.req.raw),
      );
      signupQueue = result.catch(() => {});
      return result;
    }
    return authentication.current.handler(c.req.raw);
  });
  app.use("/api/v1/*", async (c, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      c.req.header("origin") !== cfg.origin
    )
      throw new ApiError(
        403,
        "origin",
        "Open Gond Agent on its configured address to continue.",
      );
    const session = await authentication.current.api.getSession({
      headers: c.req.raw.headers,
    });
    if (!session)
      throw new ApiError(
        401,
        "unauthorized",
        "You're signed out. Sign in again.",
      );
    c.set("user", session.user);
    c.set("session", session.session);
    c.set(
      "admin",
      !!db
        .prepare("SELECT 1 FROM administrators WHERE user_id=?")
        .get(session.user.id),
    );
    await next();
  });
  app.get("/api/v1/me", (c) => {
    const u = c.get("user"),
      p = runs.profile(u.id);
    return c.json({
      user: u,
      admin: c.get("admin"),
      setup_required: !setupComplete(db),
      automations: {
        issue_runs: !!p.issue_runs,
        fix_checks: !!p.fix_checks,
        auto_pr: !!p.auto_pr,
      },
    });
  });
  app.get("/api/v1/models", (c) => c.json(publicModels(db)));
  app.get("/api/v1/settings/oidc", (c) => {
    if (!c.get("admin"))
      throw new ApiError(
        403,
        "forbidden",
        "Only an administrator can manage sign-in.",
      );
    return c.json({
      ...authentication.oidc(),
      callbackURL: `${cfg.origin}/api/auth/callback/oidc`,
    });
  });
  app.put("/api/v1/settings/oidc", async (c) => {
    if (!c.get("admin"))
      throw new ApiError(
        403,
        "forbidden",
        "Only an administrator can manage sign-in.",
      );
    if (
      Date.now() - new Date(c.get("session").createdAt).getTime() >
      10 * 60_000
    )
      throw new ApiError(
        403,
        "recent_signin",
        "Sign out and sign in again before changing sign-in settings.",
      );
    const b = await c.req.json();
    if (
      typeof b.enabled !== "boolean" ||
      typeof b.name !== "string" ||
      typeof b.issuer !== "string" ||
      typeof b.clientId !== "string" ||
      (b.clientSecret !== undefined && typeof b.clientSecret !== "string")
    )
      throw new ApiError(400, "invalid_oidc", "Check the sign-in settings.");
    try {
      authentication.saveOIDC(b);
    } catch (e) {
      throw new ApiError(400, "invalid_oidc", (e as Error).message);
    }
    return c.json({ ok: true });
  });
  app.get("/api/v1/settings/providers", (c) => {
    if (!c.get("admin")) throw new ApiError(403, "forbidden", "Only an administrator can manage model providers.");
    return c.json(publicProviderSettings(db));
  });
  app.put("/api/v1/settings/providers", async (c) => {
    if (!c.get("admin")) throw new ApiError(403, "forbidden", "Only an administrator can manage model providers.");
    return c.json(saveProviderSettings(db, cfg.secret, await c.req.json()));
  });
  app.post("/api/v1/settings/providers/test", async (c) => {
    if (!c.get("admin")) throw new ApiError(403, "forbidden", "Only an administrator can manage model providers.");
    const body = await c.req.json();
    if (typeof body.id !== "string") throw new ApiError(400, "invalid_provider", "Choose a saved provider.");
    return c.json(await testProvider(db, cfg.secret, body.id));
  });
  app.put("/api/v1/me/automations", async (c) => {
    const b = await c.req.json(),
      user = c.get("user").id;
    runs.profile(user);
    for (const key of ["issue_runs", "fix_checks", "auto_pr"])
      if (key in b) {
        if (typeof b[key] !== "boolean")
          throw new ApiError(
            400,
            "invalid_request",
            "Choose an automation setting.",
          );
        if (key !== "auto_pr" && !c.get("admin"))
          throw new ApiError(
            403,
            "forbidden",
            "Only an administrator can configure GitHub polling.",
          );
        db.prepare(`UPDATE profiles SET ${key}=? WHERE user_id=?`).run(
          Number(b[key]),
          user,
        );
      }
    const p = runs.profile(user);
    return c.json({
      automations: {
        issue_runs: !!p.issue_runs,
        fix_checks: !!p.fix_checks,
        auto_pr: !!p.auto_pr,
      },
    });
  });
  app.get("/api/v1/github", async (c) => c.json(await githubStatus()));
  app.get("/api/v1/github/repos", async (c) => {
    const repos: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await gh<any[]>(
        `user/repos?per_page=100&sort=pushed&page=${page}`,
      );
      repos.push(...batch);
      if (batch.length < 100) break;
    }
    return c.json({
      repos: repos.map((r) => ({
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch,
        pushed_at: r.pushed_at,
      })),
    });
  });
  app.get("/api/v1/github/branches", async (c) => {
    const repo = c.req.query("repo") ?? "";
    if (!validRepo(repo))
      throw new ApiError(400, "invalid_repo", "Choose a repository.");
    const branches = await gh<{ name: string }[]>(
      `repos/${repo}/branches?per_page=100`,
    );
    return c.json({ branches: branches.map((r) => r.name) });
  });
  app.post("/api/v1/images", async (c) => {
    const type = c.req.header("content-type") ?? "";
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type))
      throw new ApiError(
        400,
        "image_type",
        "Choose a PNG, JPEG, WebP or GIF image.",
      );
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (!bytes.length || bytes.length > 5_000_000)
      throw new ApiError(400, "image_size", "Images can be up to 5 MB.");
    const id = `img_${randomBytes(12).toString("hex")}`;
    db.prepare(
      "INSERT INTO images(id,user_id,media_type,bytes,created_at) VALUES(?,?,?,?,?)",
    ).run(id, c.get("user").id, type, bytes, Date.now());
    return c.json({ id }, 201);
  });
  app.post("/api/v1/transcribe", async (c) => c.json(await transcribe(
    db, cfg.secret, await c.req.arrayBuffer(),
    (c.req.header("content-type") ?? "audio/wav").split(";")[0], c.req.query("lang"),
  )));
  app.post("/api/v1/runs", async (c) =>
    c.json(await runs.create(c.get("user").id, await c.req.json()), 201),
  );
  app.get("/api/v1/runs", (c) => c.json({ runs: runs.list(c.get("user").id) }));
  app.get("/api/v1/runs/:id", (c) => {
    const r = runs.get(c.req.param("id"), c.get("user").id);
    return c.json({ ...r, live: { phase: r.phase, pushed: r.pushed } });
  });
  app.get("/api/v1/runs/:id/diff", (c) =>
    c.text(runs.get(c.req.param("id"), c.get("user").id).diff),
  );
  app.get("/api/v1/runs/:id/images/:image", (c) => {
    runs.get(c.req.param("id"), c.get("user").id);
    const img = db
      .prepare(
        "SELECT media_type,bytes FROM images WHERE id=? AND run_id=? AND user_id=?",
      )
      .get(c.req.param("image"), c.req.param("id"), c.get("user").id) as
      { media_type: string; bytes: Buffer } | undefined;
    if (!img)
      throw new ApiError(404, "not_found", "That image isn't available.");
    return new Response(new Uint8Array(img.bytes), {
      headers: {
        "content-type": img.media_type,
        "cache-control": "private, max-age=3600",
      },
    });
  });
  app.post("/api/v1/runs/:id/messages", async (c) => {
    const b = await c.req.json();
    if (
      typeof b.text !== "string" ||
      (b.images !== undefined && !Array.isArray(b.images))
    )
      throw new ApiError(400, "invalid_message", "Write a message.");
    runs.enqueue(c.req.param("id"), c.get("user").id, b.text, b.images);
    return c.json({ ok: true });
  });
  app.post("/api/v1/runs/:id/stop", async (c) => {
    await runs.stop(c.req.param("id"), c.get("user").id);
    return c.json({ ok: true });
  });
  app.post("/api/v1/runs/:id/pull", async (c) =>
    c.json(await runs.openPull(c.req.param("id"), c.get("user").id)),
  );
  app.post("/api/v1/runs/:id/merge", async (c) => {
    await runs.merge(c.req.param("id"), c.get("user").id);
    return c.json({ ok: true });
  });
  app.delete("/api/v1/runs/:id", async (c) => {
    await runs.remove(c.req.param("id"), c.get("user").id);
    return c.json({ ok: true });
  });
  app.post("/api/v1/runs/:id/ticket", (c) => {
    const run = c.req.param("id");
    runs.get(run, c.get("user").id);
    for (const [k, v] of tickets) if (v.expires < Date.now()) tickets.delete(k);
    const ticket = randomBytes(32).toString("base64url");
    tickets.set(ticket, {
      run,
      user: c.get("user").id,
      expires: Date.now() + 60000,
    });
    return c.json({ ticket });
  });
  app.get("/api/v1/runners", (c) =>
    c.json({ runners: listRunners(db, c.get("user").id) }),
  );
  app.post("/api/v1/runners", async (c) =>
    c.json(saveRunner(db, c.get("user").id, await c.req.json()), 201),
  );
  app.put("/api/v1/runners/:id", async (c) =>
    c.json(
      saveRunner(db, c.get("user").id, await c.req.json(), c.req.param("id")),
    ),
  );
  app.put("/api/v1/runners/:id/enabled", async (c) => {
    const row = listRunners(db, c.get("user").id).find(
      (r) => r.id === c.req.param("id"),
    );
    if (!row)
      throw new ApiError(404, "not_found", "That schedule doesn't exist.");
    return c.json(
      saveRunner(
        db,
        c.get("user").id,
        { ...row, ...(await c.req.json()) },
        row.id,
      ),
    );
  });
  app.delete("/api/v1/runners/:id", (c) => {
    const n = db
      .prepare("DELETE FROM runners WHERE id=? AND user_id=?")
      .run(c.req.param("id"), c.get("user").id).changes;
    if (!n)
      throw new ApiError(404, "not_found", "That schedule doesn't exist.");
    return c.json({ ok: true });
  });
  app.get("/api/v1/usage", (c) => {
    const u = c.get("user").id;
    const period = new Date().toISOString().slice(0, 7),
      from = Date.parse(period + "-01T00:00:00Z");
    const rows = db
      .prepare(
        "SELECT model_id,sum(input) AS input,sum(output) AS output,sum(cache_read) AS cache_read,sum(cost_micros) AS cost_micros FROM usage WHERE user_id=? AND created_at>=? GROUP BY model_id",
      )
      .all(u, from) as any[];
    return c.json({
      period,
      models: rows,
      total: rows.reduce(
        (t, r) => ({
          input: t.input + r.input,
          output: t.output + r.output,
          cache_read: t.cache_read + r.cache_read,
          cost_micros: t.cost_micros + r.cost_micros,
        }),
        { input: 0, output: 0, cache_read: 0, cost_micros: 0 },
      ),
    });
  });
  app.get("/api/v1/sessions", async (c) =>
    c.json({
      sessions: await authentication.current.api.listSessions({
        headers: c.req.raw.headers,
      }),
      currentToken: c.get("session").token,
    }),
  );
  app.post("/api/v1/sessions/revoke", async (c) => {
    const b = await c.req.json();
    if (typeof b.token !== "string" || b.token === c.get("session").token)
      throw new ApiError(
        400,
        "current_session",
        "Use Sign out for this session.",
      );
    await authentication.current.api.revokeSession({
      headers: c.req.raw.headers,
      body: { token: b.token },
    });
    return c.json({ ok: true });
  });
  app.get(
    "/agents/*",
    serveStatic({
      root: join(import.meta.dirname, "../../web/dist"),
      rewriteRequestPath: (p) => p.replace(/^\/agents/, ""),
    }),
  );
  app.get("/agents", (c) => c.redirect("/agents/"));
  app.get(
    "/agents/*",
    serveStatic({
      path: join(import.meta.dirname, "../../web/dist/index.html"),
    }),
  );
  app.get(
    "*",
    serveStatic({ root: join(import.meta.dirname, "../../site/dist") }),
  );
  app.get(
    "*",
    serveStatic({
      path: join(import.meta.dirname, "../../site/dist/index.html"),
    }),
  );
  return { app, tickets };
}
