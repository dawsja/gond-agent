import { unseal } from "./auth";
import { publicSearchSettings, saveSearchSettings, executeSearch } from "./search";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomBytes } from "node:crypto";
import type { Store } from "./db";
import type { Config } from "./config";
import type { Authentication } from "./auth";
import type { Runs } from "./runs/service";
import { descriptionFor } from "./runs/publication";
import { gh, githubStatus, validRepo } from "./github";
import { GithubLogin, githubEnvFor } from "./github-login";
import { getSetting, setSetting } from "./db";
import { photoFor, savePhoto } from "./profile-photo";
import { DEFAULT_THEME, isTheme } from "../../shared/theme-preference";
import { ApiError } from "./wire";
import { clearModelCatalog } from "./models";
import { deletionPolicy } from "./account";
import { publicProviderSettings, saveProviderSettings, setupComplete } from "./providers";
import { listRunners, saveRunner } from "./scheduler";
import { serveStatic } from "@hono/node-server/serve-static";
import { join } from "node:path";
import { createMcp, createToken, listTokens } from "./mcp";
import { DEFAULT_ACCENT, isAccent } from "../../shared/accents";
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
  const mcp = createMcp(db, cfg, runs);
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
    c.header("Content-Security-Policy", "img-src 'self' data: blob:");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Frame-Options", "DENY");
  });
  app.use("*", async (c, next) => {
    let path: string;
    try {
      path = new URL(decodeURIComponent(new URL(c.req.url).pathname).replace(/\/+/g, "/"), cfg.origin).pathname.replace(/\/+$/, "").toLowerCase();
    } catch { throw new ApiError(400, "invalid_path", "Use a valid request address."); }
    if (/^\/api\/auth\/(link-social|unlink-account)$/.test(path)) {
      const current = await authentication.current.api.getSession({ headers: c.req.raw.headers });
      if (!current) throw new ApiError(401, "unauthorized", "Sign in before linking a sign-in method.");
      if (Date.now() - new Date(current.session.createdAt).getTime() > 10 * 60000)
        throw new ApiError(403, "recent_signin", "Sign out and sign in again before changing sign-in methods.");
    }
    await next();
  });
  app.all("/mcp", c => mcp.fetch(c.req.raw));
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
  app.get("/api/v1/mcp/tokens", c => {
    c.header("Cache-Control", "no-store");
    return c.json({ endpoint: `${cfg.origin}/mcp`, tokens: listTokens(db, c.get("user").id) });
  });
  app.post("/api/v1/mcp/tokens", async c => {
    c.header("Cache-Control", "no-store");
    const body = await c.req.json().catch(() => null);
    return c.json(createToken(db, c.get("user").id, body?.name), 201);
  });
  app.delete("/api/v1/mcp/tokens/:id", c => {
    const result = db.prepare("UPDATE mcp_tokens SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL").run(Date.now(), c.req.param("id"), c.get("user").id);
    if (!result.changes && !db.prepare("SELECT 1 FROM mcp_tokens WHERE id=? AND user_id=?").get(c.req.param("id"),c.get("user").id))
      throw new ApiError(404,"not_found","That token doesn't exist.");
    return c.json({ok:true});
  });
  app.get("/api/v1/me", (c) => {
    const u = c.get("user"),
      p = runs.profile(u.id);
    const accent = (db.prepare("SELECT accent FROM user_accents WHERE user_id=?").get(u.id) as { accent: unknown } | undefined)?.accent;
    return c.json({
      user: { ...u, ...photoFor(db, u) },
      theme: isTheme(p.theme) ? p.theme : DEFAULT_THEME,
      admin: c.get("admin"),
      accent: isAccent(accent) ? accent : DEFAULT_ACCENT,
      setup_required: !setupComplete(db) && !runs.subscriptions.usable(u.id),
      automations: {
        auto_pr: !!p.auto_pr,
      },
    });
  });
  app.put("/api/v1/me/theme", async c => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "theme") || !isTheme(body.theme))
      throw new ApiError(400, "invalid_request", "Choose system, light or dark for your theme.");
    db.prepare("INSERT INTO profiles(user_id,theme) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme").run(c.get("user").id, body.theme);
    c.header("Cache-Control", "no-store");
    return c.json({ theme: body.theme });
  });
  app.put("/api/v1/me/accent", async c => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !isAccent(body.accent))
      throw new ApiError(400, "invalid_accent", "Choose an available accent color.");
    db.prepare("INSERT INTO user_accents(user_id,accent) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET accent=excluded.accent").run(c.get("user").id, body.accent);
    return c.json({ accent: body.accent });
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
      githubLogin.reset(user.id);
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
  app.get("/api/v1/models", async (c) => c.json(await runs.catalog(c.get("user").id,c.req.query("refresh") === "1")));
  app.use("/api/v1/subscriptions/*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.use("/api/v1/subscriptions", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  const subscriptions = runs.subscriptions;
  app.get("/api/v1/subscriptions", c => c.json({
    providers: [{ id: "chatgpt", name: "ChatGPT", usage_url: subscriptions.provider("chatgpt").usageURL }],
    accounts: subscriptions.list(c.get("user").id),
    pending: subscriptions.pending(c.get("user").id, c.get("session").token) ?? null,
    welcome: subscriptions.welcomePending(c.get("user").id),
  }));
  app.post("/api/v1/subscriptions/:provider/login", async c => {
    const body = await c.req.json().catch(() => ({}));
    if (body?.account_id !== undefined && typeof body.account_id !== "string") throw new ApiError(400, "invalid_account", "Choose a saved account.");
    return c.json(subscriptions.begin(c.get("user").id, c.get("session").token, c.req.param("provider"), body?.account_id));
  });
  app.delete("/api/v1/subscriptions/:provider/login", c => {
    subscriptions.cancel(c.get("user").id, c.get("session").token);
    return c.json({ ok: true });
  });
  app.post("/api/v1/subscriptions/:provider/callback", async c => {
    const body = await c.req.json().catch(() => null);
    const user = c.get("user").id, session = c.get("session").token;
    if (subscriptions.pending(user, session)?.provider !== subscriptions.provider(c.req.param("provider")).id)
      throw new ApiError(409, "signin_expired", "This sign-in expired or was started in another session. Continue with ChatGPT again.");
    return c.json(await subscriptions.complete(user, session, body?.url, async () => {
      const current = await authentication.current.api.getSession({ headers: c.req.raw.headers });
      return current?.user.id === user && current.session.token === session;
    }));
  });
  app.post("/api/v1/subscriptions/welcome", c => { subscriptions.acknowledgeWelcome(c.get("user").id); return c.json({ ok: true }); });
  app.post("/api/v1/subscriptions/accounts/:id/sign-out", async c => c.json(await subscriptions.signOut(c.get("user").id, c.req.param("id"))));
  app.delete("/api/v1/subscriptions/accounts/:id", async c => c.json(await subscriptions.remove(c.get("user").id, c.req.param("id"))));
  app.get("/api/v1/me/sign-in-methods", c => {
    c.header("Cache-Control", "no-store");
    return c.json({ methods: db.prepare('SELECT id,providerId AS provider FROM account WHERE userId=?').all(c.get("user").id), providers: authentication.providers() });
  });
  app.get("/api/v1/settings/people", c => {
    if (!c.get("admin")) throw new ApiError(403, "forbidden", "Only an administrator can manage accounts.");
    c.header("Cache-Control", "no-store");
    const people = db.prepare('SELECT u.id,u.name,u.email,EXISTS(SELECT 1 FROM administrators a WHERE a.user_id=u.id) AS admin FROM "user" u ORDER BY u.createdAt,u.id').all() as { id: string; name: string; email: string; admin: number }[];
    return c.json({ people: people.map(person => ({ ...person, admin: !!person.admin, methods: (db.prepare('SELECT providerId AS provider FROM account WHERE userId=?').all(person.id) as { provider: string }[]).map(method => method.provider) })) });
  });
  app.put("/api/v1/settings/people/:id/role", c => changeAccounts(async () => {
    const body = await c.req.json();
    if (typeof body.admin !== "boolean") throw new ApiError(400, "invalid_request", "Choose an account role.");
    db.transaction(() => {
      if (!db.prepare("SELECT 1 FROM administrators WHERE user_id=?").get(c.get("user").id)) throw new ApiError(403, "forbidden", "Only an administrator can manage accounts.");
      const id = c.req.param("id");
      if (!db.prepare('SELECT 1 FROM "user" WHERE id=?').get(id)) throw new ApiError(404, "not_found", "That account no longer exists.");
      if (body.admin) db.prepare("INSERT OR IGNORE INTO administrators(user_id) VALUES(?)").run(id);
      else {
        if (db.prepare("SELECT 1 FROM administrators WHERE user_id=?").get(id) && !db.prepare("SELECT 1 FROM administrators WHERE user_id<>? LIMIT 1").get(id))
          throw new ApiError(409, "administrator_required", "Keep at least one administrator.");
        db.prepare("DELETE FROM administrators WHERE user_id=?").run(id);
      }
    })();
    return c.json({ ok: true });
  }));
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
  app.get("/api/v1/settings/web-search", (c) => {
    if (!c.get("admin")) throw new ApiError(403, "forbidden", "Only an administrator can manage web search.");
    return c.json(publicSearchSettings(db));
  });
  app.put("/api/v1/settings/web-search", async (c) => {
    if (!c.get("admin")) throw new ApiError(403, "forbidden", "Only an administrator can manage web search.");
    return c.json(saveSearchSettings(db, cfg.secret, await c.req.json()));
  });
  app.post("/api/v1/settings/web-search/test", async (c) => {
    if (!c.get("admin")) throw new ApiError(403, "forbidden", "Only an administrator can test web search.");
    return c.json(await executeSearch(db, cfg.secret, { query: "Brave Search API", count: 1 }, c.req.raw.signal));
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
  const credentials = (user: string) => githubEnvFor(db, cfg.secret, user);
  app.get("/api/v1/github", async (c) => {
    c.header("Cache-Control", "no-store");
    const managed = !!db.prepare("SELECT 1 FROM github_connections WHERE user_id=?").get(c.get("user").id);
    try { return c.json({ ...await githubStatus(credentials(c.get("user").id)), managed }); }
    catch (error) { if (error instanceof ApiError && error.code === "github_required") return c.json({ configured: false, login: null, managed }); throw error; }
  });
  app.delete("/api/v1/github", c => {
    githubLogin.reset(c.get("user").id);
    db.prepare("DELETE FROM github_connections WHERE user_id=?").run(c.get("user").id);
    return c.json({ ok: true });
  });
  for (const shared of [false, true]) {
    const path = shared ? "/api/v1/settings/github" : "/api/v1/github";
    app.use(`${path}/login`, async (c, next) => {
      if (shared && !c.get("admin")) throw new ApiError(403, "forbidden", "Only an administrator can manage the shared connection.");
      c.header("Cache-Control", "no-store");
      await next();
    });
    const target = (user: string) => shared ? "shared" : user;
    app.get(`${path}/login`, c => c.json(githubLogin.state(c.get("session").token, target(c.get("user").id))));
    app.post(`${path}/login`, c => c.json(githubLogin.start(c.get("session").token, async () => {
      const current = await authentication.current.api.getSession({ headers: c.req.raw.headers });
      return current?.user.id === c.get("user").id && (!shared || !!db.prepare("SELECT 1 FROM administrators WHERE user_id=?").get(current.user.id));
    }, target(c.get("user").id))));
    app.delete(`${path}/login`, async c => {
      const body = await c.req.json();
      if (typeof body.id !== "string") throw new ApiError(400, "github_flow", "Choose the current GitHub sign-in.");
      return c.json(githubLogin.cancel(c.get("session").token, body.id, target(c.get("user").id)));
    });
  }
  app.use("/api/v1/settings/github", async (c, next) => {
    if (!c.get("admin")) throw new ApiError(403, "forbidden", "Only an administrator can manage the shared connection.");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/api/v1/settings/github", async c => {
    const saved = getSetting<{ token: string }>(db, "github");
    return c.json({ ...(saved ? await githubStatus({ ...process.env, GH_TOKEN: unseal(cfg.secret, saved.token), GITHUB_TOKEN: undefined }) : { configured: false, login: null }), managed: !!saved, fallback: !!getSetting(db, "github-shared-fallback") });
  });
  app.put("/api/v1/settings/github", async c => {
    const body = await c.req.json();
    if (typeof body.fallback !== "boolean") throw new ApiError(400, "invalid_request", "Choose whether to use the shared connection.");
    setSetting(db, "github-shared-fallback", body.fallback);
    return c.json({ ok: true });
  });
  app.delete("/api/v1/settings/github", c => {
    githubLogin.reset("shared");
    db.prepare("DELETE FROM settings WHERE key='github'").run();
    return c.json({ ok: true });
  });
  app.get("/api/v1/github/repos", async (c) => {
    const repos: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await gh<any[]>(
        `user/repos?per_page=100&sort=pushed&page=${page}`,
        "GET", undefined, credentials(c.get("user").id),
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
      "GET", undefined, credentials(c.get("user").id),
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
  app.get("/api/v1/runs", async (c) => {
    await runs.refreshPulls(c.get("user").id);
    return c.json({ runs: runs.list(c.get("user").id).map(r => ({ ...r, description: descriptionFor(r) })) });
  });
  app.get("/api/v1/runs/:id", async (c) => {
    await runs.refreshPulls(c.get("user").id, c.req.param("id"));
    const r = runs.get(c.req.param("id"), c.get("user").id);
    return c.json({ ...r, description: descriptionFor(r), live: { phase: r.phase, pushed: r.pushed } });
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
        "cache-control": "private, no-store",
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
    await runs.validateFollowUp(c.req.param("id"), c.get("user").id, b.model, b.effort);
    runs.enqueue(c.req.param("id"), c.get("user").id, b.text, b.images, b.effort, b.model, undefined, b.pr_body);
    return c.json({ ok: true });
  });
  app.post("/api/v1/runs/:id/resume", async (c) =>
    c.json(await runs.resume(c.req.param("id"), c.get("user").id)),
  );
  app.post("/api/v1/runs/:id/close", async (c) =>
    c.json(await runs.closeSession(c.req.param("id"), c.get("user").id)),
  );
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
    c.json(await saveRunner(db, cfg.secret, c.get("user").id, await c.req.json(), undefined, (user,id)=>runs.resolveSelection(user,id)), 201),
  );
  app.put("/api/v1/runners/:id", async (c) =>
    c.json(
      await saveRunner(db, cfg.secret, c.get("user").id, await c.req.json(), c.req.param("id"), (user,id)=>runs.resolveSelection(user,id)),
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
        (user,id)=>runs.resolveSelection(user,id),
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
      plan_usage_url: subscriptions.provider("chatgpt").usageURL,
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
  return { app, tickets, githubLogin, mcp };
}
