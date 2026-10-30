import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomBytes } from "node:crypto";
import type { Store } from "./db";
import type { Config } from "./config";
import type { Authentication } from "./auth";
import type { Runs } from "./runs/service";
import { gh, githubStatus, validRepo } from "./github";
import { GithubLogin, githubEnv } from "./github-login";
import { getSetting } from "./db";
import { photoFor, savePhoto } from "./profile-photo";
import { ApiError } from "./wire";
import { clearModelCatalog, loadModelCatalog } from "./models";
import { deletionPolicy } from "./account";
import { publicProviderSettings, saveProviderSettings, setupComplete } from "./providers";
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
  githubLogin = new GithubLogin(db, cfg.secret, cfg.data),
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
  app.get("/api/auth/bootstrap", (c) => {
    const firstAccount = !db.prepare('SELECT 1 FROM "user" LIMIT 1').get();
    c.header("Cache-Control", "no-store");
    return c.json({ firstAccount, signupAllowed: firstAccount || cfg.signup, providers: authentication.providers() });
  });
  let accountQueue: Promise<unknown> = Promise.resolve();
  const changeAccounts = <T>(action: () => Promise<T>) => {
    const result = accountQueue.then(action);
    accountQueue = result.catch(() => {});
    return result;
  };
  app.on(["GET", "POST"], "/api/auth/*", (c) => {
    // User creation (including OIDC callbacks) must not race the last account's deletion.
    return changeAccounts(() => authentication.current.handler(c.req.raw));
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
    runs.assertAccount(session.user.id);
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
      user: { ...u, ...photoFor(db, u) },
      admin: c.get("admin"),
      setup_required: !setupComplete(db),
      automations: {
        auto_pr: !!p.auto_pr,
      },
    });
  });
  app.get("/api/v1/me/deletion", c => {
    c.header("Cache-Control", "no-store");
    return c.json(deletionPolicy(db, c.get("user").id));
  });
  const deletionAttempts = new Map<string, { count: number; reset: number }>();
  app.delete("/api/v1/me", c => changeAccounts(async () => {
    const session = await authentication.current.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new ApiError(401, "unauthorized", "You're signed out. Sign in again.");
    const user = session.user, body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body) || body.confirmation !== user.email)
      throw new ApiError(400, "confirmation_required", "Type your email address to confirm account deletion.");
    const policy = deletionPolicy(db, user.id);
    if (policy.blocked_reason) throw new ApiError(409, "administrator_required", policy.blocked_reason);
    if (policy.has_password && (typeof body.password !== "string" || !body.password || body.password.length > 128))
      throw new ApiError(400, "password_required", "Enter your current password to delete your account.");
    if (!policy.has_password && Date.now() - new Date(session.session.createdAt).getTime() >= 15 * 60000)
      throw new ApiError(403, "fresh_signin_required", "Sign out and sign in again before deleting your account.");
    let attempts = deletionAttempts.get(user.id);
    if (!attempts || attempts.reset <= Date.now()) {
      attempts = { count: 0, reset: Date.now() + 15 * 60000 };
      deletionAttempts.set(user.id, attempts);
    }
    if (++attempts.count > 5) throw new ApiError(429, "deletion_limit", "Too many attempts. Wait 15 minutes before trying again.");
    return runs.withAccountDeletion(user.id, async prepare => {
      let preparationError: unknown;
      const result = await authentication.deleteAccount(c.req.raw.headers, policy.has_password ? body.password : undefined, async target => {
        if (target.id !== user.id) throw new ApiError(403, "forbidden", "You can only delete your own account.");
        try { await prepare(); } catch (error) { preparationError = error; throw error; }
      });
      if (preparationError) throw preparationError;
      if (!result.ok) {
        const error = await result.json().catch(() => ({}));
        if (error.code === "INVALID_PASSWORD") throw new ApiError(400, "invalid_password", "Your current password is incorrect.");
        if (error.code === "SESSION_EXPIRED") throw new ApiError(403, "fresh_signin_required", "Sign out and sign in again before deleting your account.");
        throw new ApiError(400, "delete_failed", "Couldn't delete your account. Sign in again and retry.");
      }
      const reset = !db.prepare('SELECT 1 FROM "user" LIMIT 1').get();
      deletionAttempts.delete(user.id);
      for (const [key, ticket] of tickets) if (ticket.user === user.id) tickets.delete(key);
      if (reset) {
        githubLogin.reset();
        clearModelCatalog(db);
        authentication.reload();
      }
      const headers = new Headers(result.headers);
      headers.set("Cache-Control", "no-store");
      return new Response(JSON.stringify({ ok: true, setup_reset: reset }), { headers });
    });
  }));
  app.put("/api/v1/me/photo", async c => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(c.req.header("content-type") ?? "")) throw new ApiError(400, "photo_type", "Choose a PNG, JPEG or WebP photo.");
    const user = c.get("user");
    await savePhoto(db, user.id, Buffer.from(await c.req.arrayBuffer()));
    c.header("Cache-Control", "no-store");
    return c.json(photoFor(db, user));
  });
  app.delete("/api/v1/me/photo", c => {
    const user = c.get("user");
    db.prepare("DELETE FROM profile_photos WHERE user_id=?").run(user.id);
    c.header("Cache-Control", "no-store");
    return c.json(photoFor(db, user));
  });
  app.get("/api/v1/users/:id/photo", c => {
    c.header("Cache-Control", "private, no-store");
    const row = db.prepare("SELECT bytes,revision FROM profile_photos WHERE user_id=?").get(c.req.param("id")) as { bytes: Buffer; revision: string } | undefined;
    if (!row || c.req.query("v") !== row.revision) throw new ApiError(404, "photo_not_found", "That profile photo isn't available.");
    c.header("Content-Type", "image/png");
    return c.body(new Uint8Array(row.bytes));
  });
  app.get("/api/v1/models", async (c) => c.json(await loadModelCatalog(db, cfg.secret, c.req.query("refresh") === "1")));
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
  app.put("/api/v1/me/automations", async (c) => {
    const b = await c.req.json(),
      user = c.get("user").id;
    runs.profile(user);
    if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some(key => key !== "auto_pr") || typeof b.auto_pr !== "boolean")
      throw new ApiError(400, "invalid_request", "Choose an automatic pull-request setting.");
    db.prepare("UPDATE profiles SET auto_pr=? WHERE user_id=?").run(Number(b.auto_pr), user);
    const p = runs.profile(user);
    return c.json({
      automations: {
        auto_pr: !!p.auto_pr,
      },
    });
  });
  const credentials = () => githubEnv(db, cfg.secret);
  app.get("/api/v1/github", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ ...await githubStatus(credentials()), managed: !!getSetting(db, "github") });
  });
  app.use("/api/v1/github/login", async (c, next) => {
    if (!c.get("admin")) throw new ApiError(403, "forbidden", "Only an administrator can connect GitHub.");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/api/v1/github/login", c => c.json(githubLogin.state(c.get("session").token)));
  app.post("/api/v1/github/login", c => c.json(githubLogin.start(c.get("session").token, async () => {
    const current = await authentication.current.api.getSession({ headers: c.req.raw.headers });
    return !!current && !!db.prepare("SELECT 1 FROM administrators WHERE user_id=?").get(current.user.id);
  })));
  app.delete("/api/v1/github/login", async c => {
    const body = await c.req.json();
    if (typeof body.id !== "string") throw new ApiError(400, "github_flow", "Choose the current GitHub sign-in.");
    return c.json(githubLogin.cancel(c.get("session").token, body.id));
  });
  app.get("/api/v1/github/repos", async (c) => {
    const repos: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await gh<any[]>(
        `user/repos?per_page=100&sort=pushed&page=${page}`,
        "GET", undefined, credentials(),
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
      "GET", undefined, credentials(),
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
    c.json(await saveRunner(db, cfg.secret, c.get("user").id, await c.req.json()), 201),
  );
  app.put("/api/v1/runners/:id", async (c) =>
    c.json(
      await saveRunner(db, cfg.secret, c.get("user").id, await c.req.json(), c.req.param("id")),
    ),
  );
  app.put("/api/v1/runners/:id/enabled", async (c) => {
    const row = listRunners(db, c.get("user").id).find(
      (r) => r.id === c.req.param("id"),
    );
    if (!row)
      throw new ApiError(404, "not_found", "That schedule doesn't exist.");
    return c.json(
      await saveRunner(
        db,
        cfg.secret,
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
  app.get("/", (c) => c.redirect("/agents/"));
  return { app, tickets, githubLogin };
}
