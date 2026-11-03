import { createHash, randomBytes, randomUUID } from "node:crypto";
import { seal, unseal } from "../auth";
import { getSetting, type Store } from "../db";
import { ApiError } from "../wire";
import { ReauthRequired, type Failure, type Registration, type SubscriptionModel, type SubscriptionProvider, type Tokens } from "./provider";

export const MAX_PENDING_LOGINS = 1000;
const LOGIN_TTL = 10 * 60_000;
const REFRESH_MARGIN = 5 * 60_000;
const LIMIT_PAUSE = 60_000;

interface Row {
  id: string; user_id: string; provider: string; subject: string; email: string | null; client_id: string;
  credentials: string; status: "active" | "signed_out" | "reauth"; plan: "enabled" | "disabled" | "not_eligible";
  limited_at: number | null; created_at: number; updated_at: number;
}
interface Pending { provider: string; account?: string; attempt: unknown; url: string; expires: number }
interface Catalog { key: string; checked: number; models: SubscriptionModel[]; status: "ready" | "empty" | "error"; message?: string; pending?: Promise<void> }

export interface AccountCatalog {
  account: string; provider: SubscriptionProvider; connectionId: string; connectionName: string;
  status: "ready" | "empty" | "error"; message?: string; limited: boolean; models: SubscriptionModel[];
}

const sealed = (secret: string, tokens: Tokens) => seal(secret, JSON.stringify(tokens));

/**
 * The one token store and refresh path for subscription model access. Credentials stay sealed in
 * SQLite inside the API service; workers and browsers only see model IDs.
 */
export class SubscriptionAccounts {
  private providers = new Map<string, SubscriptionProvider>();
  private logins = new Map<string, Pending>();
  private signingOut = new Set<string>();
  private refreshing = new Map<string, Promise<Tokens>>();
  private catalogs = new Map<string, Catalog>();
  constructor(private db: Store, private secret: string, providers: SubscriptionProvider[]) {
    for (const provider of providers) this.providers.set(provider.id, provider);
  }

  provider(id: string) {
    const provider = this.providers.get(id);
    if (!provider) throw new ApiError(404, "unknown_subscription", "That subscription isn't supported.");
    return provider;
  }

  /** A stable opaque identifier for this server, created before its first sign-in. */
  hostId() {
    let id = getSetting<string>(this.db, "subscription-host");
    if (!id) {
      this.db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('subscription-host',?)").run(JSON.stringify(`urn:uuid:${randomUUID()}`));
      id = getSetting<string>(this.db, "subscription-host")!;
    }
    return id;
  }

  private row(id: string, user?: string) {
    return this.db.prepare(`SELECT * FROM subscription_accounts WHERE id=?${user ? " AND user_id=?" : ""}`).get(...(user ? [id, user] : [id])) as Row | undefined;
  }
  private owned(user: string, id: string) {
    const row = this.row(id, user);
    if (!row) throw new ApiError(404, "not_found", "That ChatGPT account isn't connected.");
    return row;
  }
  private tokensOf(row: Row): Tokens | undefined {
    return row.credentials ? JSON.parse(unseal(this.secret, row.credentials)) as Tokens : undefined;
  }
  private registration(row: Row): Registration { return { clientId: row.client_id, subject: row.subject, email: row.email ?? undefined }; }

  private label(rows: Row[], row: Row) {
    const provider = this.providers.get(row.provider)?.name ?? row.provider;
    const same = rows.filter(r => r.provider === row.provider && r.email === row.email);
    const suffix = same.length > 1 ? ` (${same.findIndex(r => r.id === row.id) + 1})` : "";
    return `${provider} · ${row.email ?? "account"}${suffix}`;
  }

  private paused(row: Row) { return !!row.limited_at && Date.now() - row.limited_at < LIMIT_PAUSE; }

  list(user: string) {
    const rows = this.db.prepare("SELECT * FROM subscription_accounts WHERE user_id=? ORDER BY created_at").all(user) as Row[];
    return rows.map(row => ({
      id: row.id, provider: row.provider, email: row.email, label: this.label(rows, row),
      status: row.status, plan: row.plan, limited: !!row.limited_at, connected_at: row.created_at, updated_at: row.updated_at,
      usage_url: this.providers.get(row.provider)?.usageURL,
    }));
  }

  welcomePending(user: string) {
    return !this.db.prepare("SELECT 1 FROM subscription_notices WHERE user_id=?").get(user)
      && !!this.db.prepare("SELECT 1 FROM subscription_accounts WHERE user_id=? AND status='active' AND plan='enabled'").get(user);
  }
  acknowledgeWelcome(user: string) {
    this.db.prepare("INSERT OR IGNORE INTO subscription_notices(user_id,welcomed_at) VALUES(?,?)").run(user, Date.now());
  }

  usable(user: string) {
    return !!this.db.prepare("SELECT 1 FROM subscription_accounts WHERE user_id=? AND status='active' AND plan='enabled'").get(user);
  }

  begin(user: string, session: string, providerId: string, accountId?: string) {
    const now = Date.now();
    for (const [key, pending] of this.logins) if (pending.expires <= now) this.logins.delete(key);
    const key = `${user}\0${session}`;
    if (!this.logins.has(key) && this.logins.size >= MAX_PENDING_LOGINS)
      throw new ApiError(429, "signin_capacity", "Too many sign-ins are pending. Try again shortly.");
    const provider = this.provider(providerId);
    const row = accountId ? this.owned(user, accountId) : undefined;
    if (row && row.provider !== provider.id) throw new ApiError(400, "unknown_subscription", "Choose a ChatGPT account.");
    const { url, attempt } = provider.start({ hostId: this.hostId(), registration: row && this.registration(row), idTokenHint: row && this.tokensOf(row)?.idToken });
    const pending: Pending = { provider: provider.id, account: row?.id, attempt, url, expires: Date.now() + LOGIN_TTL };
    this.logins.set(`${user}\0${session}`, pending);
    return this.pending(user, session)!;
  }

  pending(user: string, session: string) {
    const key = `${user}\0${session}`, pending = this.logins.get(key);
    if (pending && pending.expires <= Date.now()) this.logins.delete(key);
    const current = this.logins.get(key);
    return current && { provider: current.provider, account_id: current.account ?? null, url: current.url, expires_at: current.expires };
  }

  cancel(user: string, session: string) { this.logins.delete(`${user}\0${session}`); }

  /** Completes the sign-in attempt that belongs to this browser session from a pasted callback address. */
  async complete(user: string, session: string, callbackURL: unknown, authorized: () => Promise<boolean>) {
    const key = `${user}\0${session}`, pending = this.logins.get(key);
    if (!pending || pending.expires <= Date.now()) {
      this.logins.delete(key);
      throw new ApiError(409, "signin_expired", "This sign-in expired or was started in another session. Continue with ChatGPT again.");
    }
    const provider = this.provider(pending.provider);
    let grant;
    try { grant = await provider.finish(pending.attempt, callbackURL); }
    catch (error) {
      // A mistyped or stale address can be corrected; every other outcome ends this attempt.
      if (!(error instanceof ApiError && ["chatgpt_callback", "chatgpt_state"].includes(error.code))) this.logins.delete(key);
      throw error;
    }
    let saved = false;
    try {
    if (this.logins.get(key) !== pending) throw new ApiError(409, "signin_expired", "This sign-in was cancelled. Continue with ChatGPT again.");
    this.logins.delete(key);
    if (!await authorized()) throw new ApiError(401, "unauthorized", "You're signed out. Sign in again.");
    const now = Date.now(), plan = provider.planEnabled(grant.tokens) ? "enabled" : "disabled";
    const existing = pending.account ? this.owned(user, pending.account)
      : this.db.prepare("SELECT * FROM subscription_accounts WHERE user_id=? AND provider=? AND client_id=? AND subject=?").get(user, provider.id, grant.registration.clientId, grant.registration.subject) as Row | undefined;
    const id = existing?.id ?? randomBytes(8).toString("hex");
    this.db.prepare(`INSERT INTO subscription_accounts(id,user_id,provider,subject,email,client_id,credentials,status,plan,limited_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'active',?,NULL,?,?)
      ON CONFLICT(id) DO UPDATE SET subject=excluded.subject,email=excluded.email,credentials=excluded.credentials,status='active',plan=excluded.plan,limited_at=NULL,updated_at=excluded.updated_at`)
      .run(id, user, provider.id, grant.registration.subject, grant.registration.email ?? null, grant.registration.clientId, sealed(this.secret, grant.tokens), plan, now, now);
    saved = true;
    this.catalogs.delete(id);
    return { account: this.list(user).find(a => a.id === id)!, welcome: this.welcomePending(user) };
    } finally {
      if (!saved) await provider.revoke(grant.registration, grant.tokens).catch(() => false);
    }
  }

  /** Revokes the renewable session, then clears tokens. The registration and host ID are kept. */
  async signOut(user: string, id: string) {
    this.owned(user, id);
    this.signingOut.add(id);
    try {
    await this.refreshing.get(id)?.catch(() => {});
    const row = this.owned(user, id), tokens = this.tokensOf(row);
    this.catalogs.delete(id);
    const revoked = tokens ? await this.provider(row.provider).revoke(this.registration(row), tokens).catch(() => false) : true;
    this.db.prepare("UPDATE subscription_accounts SET credentials='',status='signed_out',limited_at=NULL,updated_at=? WHERE id=?").run(Date.now(), id);
    return { revoked };
    } finally { this.signingOut.delete(id); }
  }

  async remove(user: string, id: string) {
    const result = this.owned(user, id).credentials ? await this.signOut(user, id) : { revoked: true };
    this.db.prepare("DELETE FROM subscription_accounts WHERE id=? AND user_id=?").run(id, user);
    return result;
  }

  async revokeAll(user: string) {
    for (const row of this.db.prepare("SELECT id FROM subscription_accounts WHERE user_id=? AND credentials<>''").all(user) as { id: string }[])
      await this.signOut(user, row.id).catch(() => {});
  }

  /** A current access token; refreshes before expiry, or when `stale` was just rejected. */
  async tokens(id: string, stale?: string): Promise<Tokens> {
    if (this.signingOut.has(id)) throw new ApiError(401, "subscription_signin", "This ChatGPT account is signing out.");
    const row = this.row(id), tokens = row && this.tokensOf(row);
    if (!row || row.status !== "active" || !tokens)
      throw new ApiError(401, "subscription_signin", "Sign in to ChatGPT again in Settings → Models to keep using your plan.");
    if (!stale && tokens.expiresAt - Date.now() > REFRESH_MARGIN) return tokens;
    let refresh = this.refreshing.get(id);
    if (!refresh) {
      refresh = this.refresh(id, stale).finally(() => this.refreshing.delete(id));
      this.refreshing.set(id, refresh);
    }
    return refresh;
  }

  private async refresh(id: string, stale?: string) {
    const row = this.row(id), tokens = row && this.tokensOf(row);
    if (!row || row.status !== "active" || !tokens) throw new ApiError(401, "subscription_signin", "Sign in to ChatGPT again in Settings → Models to keep using your plan.");
    // Another caller may already have replaced the rejected or expiring token.
    if (stale ? tokens.accessToken !== stale : tokens.expiresAt - Date.now() > REFRESH_MARGIN) return tokens;
    const provider = this.provider(row.provider);
    let next: Tokens;
    try { next = await provider.refresh(this.registration(row), tokens); }
    catch (error) {
      if (!(error instanceof ReauthRequired)) throw error;
      this.db.prepare("UPDATE subscription_accounts SET credentials='',status='reauth',updated_at=? WHERE id=? AND credentials=?").run(Date.now(), id, row.credentials);
      this.catalogs.delete(id);
      throw new ApiError(401, "subscription_signin", "Your ChatGPT sign-in has ended. Continue with ChatGPT in Settings → Models to sign in again.");
    }
    // Access token, expiry, scopes and the rotated refresh token are replaced together.
    const changed = this.db.prepare("UPDATE subscription_accounts SET credentials=?,plan=CASE WHEN plan='not_eligible' THEN plan ELSE ? END,updated_at=? WHERE id=? AND credentials=?")
      .run(sealed(this.secret, next), provider.planEnabled(next) ? "enabled" : "disabled", Date.now(), id, row.credentials).changes;
    if (!changed) {
      await provider.revoke(this.registration(row), next).catch(() => false);
      throw new ApiError(409, "subscription_signin", "This ChatGPT account changed while renewing its sign-in. Try again.", true);
    }
    return next;
  }

  /** Runs an authenticated upstream call, refreshing once and retrying once after a 401. */
  async withToken<T>(id: string, send: (tokens: Tokens, provider: SubscriptionProvider) => Promise<T>, options: { admit?: boolean } = {}) {
    const row = this.row(id);
    if (!row) throw new ApiError(404, "unknown_model", "That ChatGPT account isn't connected anymore. Choose another model.");
    const provider = this.provider(row.provider);
    if (options.admit) this.admit(row, provider);
    const attempt = async (tokens: Tokens) => {
      try {
        const result = await send(tokens, provider);
        return { result, rejected: result instanceof Response && result.status === 401 };
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return { error, rejected: true };
        throw error;
      }
    };
    const tokens = await this.tokens(id);
    let outcome = await attempt(tokens);
    if (outcome.rejected) {
      if (outcome.result instanceof Response) await outcome.result.body?.cancel().catch(() => {});
      outcome = await attempt(await this.tokens(id, tokens.accessToken));
    }
    if ("error" in outcome) throw outcome.error;
    return { result: outcome.result as T, provider };
  }

  private admit(row: Row, provider: SubscriptionProvider) {
    if (row.plan === "not_eligible") throw provider.failure(403, { error: { code: "subscription_sharing_user_not_eligible" } }).error;
    if (row.plan !== "enabled") throw new ApiError(403, "subscription_plan_disabled", "ChatGPT plan use isn't enabled for this sign-in. Continue with ChatGPT in Settings → Models and allow plan usage, or use an API key connection.");
    if (this.paused(row)) throw provider.failure(429, { error: { code: "subscription_sharing_usage_limit_exceeded" } }).error;
  }

  /** Records what a failed request means for the account, then returns the customer-facing error. */
  apply(id: string, failure: Failure) {
    const now = Date.now();
    if (failure.effect === "limited") this.db.prepare("UPDATE subscription_accounts SET limited_at=?,updated_at=? WHERE id=?").run(now, now, id);
    if (failure.effect === "not_eligible") this.db.prepare("UPDATE subscription_accounts SET plan='not_eligible',updated_at=? WHERE id=?").run(now, id);
    return failure.error;
  }

  succeeded(id: string) {
    this.db.prepare("UPDATE subscription_accounts SET limited_at=NULL WHERE id=? AND limited_at IS NOT NULL").run(id);
  }

  /** Account-owned model catalogs, cached briefly per account and refreshed when credentials change. */
  async catalog(user: string, refresh = false): Promise<AccountCatalog[]> {
    const rows = (this.db.prepare("SELECT * FROM subscription_accounts WHERE user_id=? AND status<>'signed_out' ORDER BY created_at").all(user) as Row[])
      .filter(row => this.providers.has(row.provider));
    await Promise.all(rows.map(row => this.load(row, refresh)));
    return rows.map(original => {
      const row = this.row(original.id) ?? original, provider = this.provider(row.provider), entry = this.catalogs.get(row.id);
      const message = row.status === "reauth" ? `Sign in to ${provider.name} again to use this account.`
        : row.plan === "disabled" ? `${provider.name} plan use isn't enabled for this sign-in.`
        : row.plan === "not_eligible" ? `${provider.name} plan usage isn't available for this account.`
        : this.paused(row) ? "Usage limit reached. Manage usage in ChatGPT settings."
        : entry?.message;
      const ready = row.status === "active" && row.plan === "enabled";
      return {
        account: row.id, provider, connectionId: `${provider.id}.${row.id}`, connectionName: this.label(rows, row),
        status: ready ? entry?.status ?? "empty" : "error", message, limited: !!row.limited_at,
        models: ready ? entry?.models ?? [] : [],
      };
    });
  }

  private async load(row: Row, refresh: boolean) {
    if (row.status !== "active" || row.plan !== "enabled") return;
    const key = createHash("sha256").update(row.credentials).digest("hex");
    let entry = this.catalogs.get(row.id);
    if (entry?.key !== key) {
      // A refreshed token keeps the catalog; a new sign-in replaces it.
      entry = { key, checked: 0, models: entry?.models ?? [], status: entry?.status ?? "empty" };
      this.catalogs.set(row.id, entry);
    }
    if (entry.pending) return entry.pending;
    if (Date.now() - entry.checked < (refresh ? 5000 : 60000)) return;
    const current = entry;
    current.pending = (async () => {
      try {
        const signal = AbortSignal.timeout(15_000);
        const { result: models } = await this.withToken(row.id, (tokens, provider) => provider.models(tokens, signal));
        current.models = models;
        current.status = models.length ? "ready" : "empty";
        current.message = models.length ? undefined : "This account returned no models.";
      } catch (error) {
        current.status = "error";
        current.message = (error instanceof ApiError ? error.message : "Couldn't load this account's models.") + (current.models.length ? " Showing previously loaded models." : "");
      } finally {
        current.checked = Date.now();
        current.pending = undefined;
      }
    })();
    return current.pending;
  }

  /** The model for an account-owned selection, or undefined when the account can't serve it. */
  async model(user: string, account: string, slug: string) {
    const find = (catalogs: AccountCatalog[]) => {
      const catalog = catalogs.find(c => c.account === account);
      const model = catalog?.models.find(m => m.id === slug);
      return catalog && model ? { catalog, model } : undefined;
    };
    const row = this.row(account, user);
    if (!row) return undefined;
    // A known model of a paused, ineligible or expired account still resolves, so the request
    // fails with that account's specific message instead of "model not found".
    const cached = this.catalogs.get(account);
    if (cached?.models.some(m => m.id === slug)) {
      const provider = this.provider(row.provider);
      return { catalog: { account, provider, connectionId: `${provider.id}.${account}`, connectionName: this.label(this.db.prepare("SELECT * FROM subscription_accounts WHERE user_id=? ORDER BY created_at").all(user) as Row[], row), status: cached.status, limited: !!row.limited_at, models: cached.models }, model: cached.models.find(m => m.id === slug)! };
    }
    return find(await this.catalog(user));
  }

  close() { this.logins.clear(); this.catalogs.clear(); }
}
