// "Sign in with ChatGPT" plan usage for open-source apps:
// https://developers.openai.com/siwc/token-sharing-open-source
import { createHash, randomBytes, timingSafeEqual, type JsonWebKey } from "node:crypto";
import { ApiError } from "../wire";
import { verifyIdToken } from "./jwt";
import { ReauthRequired, type Failure, type Grant, type Registration, type SubscriptionModel, type SubscriptionProvider, type Tokens } from "./provider";

export const CHATGPT_REDIRECT = "http://127.0.0.1:1455/auth/callback";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const AGENT_NAME = "Gond Agent";
const REGISTRATION = "dynamic_agent_client";
const TERMINAL_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused", "invalid_client"]);
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

interface Attempt { state: string; nonce: string; verifier: string; clientId?: string; subject?: string }
interface Discovery { issuer: string; jwks_uri: string; revocation_endpoint?: string }

const random = (bytes: number) => randomBytes(bytes).toString("base64url");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const invalidCallback = () => new ApiError(400, "chatgpt_callback", `Paste the full address that starts with ${CHATGPT_REDIRECT} from the page that didn't load.`);

/** Accepts only the fixed loopback redirect. The address is parsed, never requested. */
export function parseCallback(value: unknown): URLSearchParams {
  if (typeof value !== "string" || !value.trim() || value.length > 8192) throw invalidCallback();
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw invalidCallback(); }
  const expected = new URL(CHATGPT_REDIRECT);
  if (url.protocol !== expected.protocol || url.hostname !== expected.hostname || url.port !== expected.port || url.pathname !== expected.pathname || url.username || url.password)
    throw invalidCallback();
  for (const key of new Set(url.searchParams.keys())) if (url.searchParams.getAll(key).length > 1) throw invalidCallback();
  return url.searchParams;
}

function errorCode(body: unknown): { code?: string; param?: string } {
  const b = body as { error?: unknown; response?: { error?: unknown }; code?: unknown; param?: unknown } | null;
  const e = (b?.error ?? b?.response?.error ?? b) as { code?: unknown; param?: unknown; error?: unknown } | string | null | undefined;
  if (typeof e === "string") return { code: e };
  const code = typeof e?.code === "string" ? e.code : typeof e?.error === "string" ? e.error : undefined;
  return { code, param: typeof e?.param === "string" ? e.param.slice(0, 120) : undefined };
}

/** Plain messages for the documented plan-usage errors. None of them falls back to API billing. */
export function chatgptFailure(status: number, body: unknown): Failure {
  const { code, param } = errorCode(body);
  const manage = `Review it in ChatGPT settings → Usage (${CHATGPT_USAGE_URL}).`;
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return { effect: "limited", error: new ApiError(429, "chatgpt_usage_limit", `You've reached a ChatGPT plan usage limit for Gond Agent. ${manage} Gond Agent doesn't switch to API billing.`) };
    case "subscription_sharing_usage_unavailable":
      return { error: new ApiError(503, "chatgpt_usage_unavailable", "ChatGPT couldn't check your plan usage right now. Gond Agent will retry shortly.", true) };
    case "subscription_sharing_user_unavailable":
      return { error: new ApiError(503, "chatgpt_user_unavailable", "ChatGPT account information is temporarily unavailable. Gond Agent will retry shortly.", true) };
    case "subscription_sharing_user_not_eligible":
      return { effect: "not_eligible", error: new ApiError(403, "chatgpt_not_eligible", "ChatGPT plan usage isn't available for this account, workspace or policy. Use an API key connection instead.") };
    case "subscription_sharing_invalid_user":
      return { error: new ApiError(401, "chatgpt_invalid_user", "ChatGPT couldn't validate this account. If this continues, sign in again in Settings → Models.") };
    case "subscription_sharing_unsupported_capability":
      return { error: new ApiError(400, "chatgpt_unsupported", `ChatGPT plan usage doesn't support part of this request${param ? ` (${param})` : ""}. Choose another model or use an API key connection.`) };
    case "subscription_sharing_route_not_supported":
      return { error: new ApiError(403, "chatgpt_route", "This request type isn't available with a ChatGPT plan.") };
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return { effect: "not_eligible", error: new ApiError(403, "chatgpt_not_authorized", "This sign-in doesn't allow Gond Agent to use your ChatGPT plan. Continue with ChatGPT again and allow plan usage, or use an API key connection.") };
  }
  if (status === 401) return { error: new ApiError(401, "chatgpt_unauthorized", "ChatGPT didn't accept this sign-in. Sign in again in Settings → Models.") };
  if (status === 403) return { error: new ApiError(403, "chatgpt_forbidden", "ChatGPT blocked this request by policy, for example the permitted region.") };
  if (status === 429) return { error: new ApiError(429, "chatgpt_rate_limit", "ChatGPT is limiting requests right now. Gond Agent will retry shortly.", true) };
  if (status === 503 || status >= 500 || status === 0) return { error: new ApiError(503, "chatgpt_unavailable", "ChatGPT plan usage is unavailable right now. Gond Agent will retry shortly.", true) };
  if (code === "context_length_exceeded") return { error: new ApiError(400, "context_exceeded", "The conversation is too long for this model.") };
  return { error: new ApiError(502, "chatgpt_rejected", "ChatGPT rejected this request. Choose another model or try again.") };
}

export class ChatGPTProvider implements SubscriptionProvider {
  readonly id = "chatgpt";
  readonly name = "ChatGPT";
  readonly usageURL = CHATGPT_USAGE_URL;
  readonly format = "openai-responses" as const;
  readonly baseURL: string;
  private issuer: string;
  private fetch: typeof fetch;
  private discovery?: { at: number; value: Promise<Discovery> };
  private keys?: { at: number; value: JsonWebKey[] };
  constructor(options: { issuer?: string; baseURL?: string; fetch?: typeof fetch } = {}) {
    this.issuer = options.issuer ?? "https://auth.openai.com";
    this.baseURL = options.baseURL ?? RESOURCE;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  start(input: { hostId: string; registration?: Registration; idTokenHint?: string }) {
    const attempt: Attempt = { state: random(32), nonce: random(32), verifier: random(48), clientId: input.registration?.clientId, subject: input.registration?.subject };
    const query = new URLSearchParams({ client_id: input.registration?.clientId ?? REGISTRATION });
    if (!input.registration) query.set("agent_name_hint", AGENT_NAME);
    query.set("ext_agent_host_id", input.hostId);
    if (input.registration && input.idTokenHint) query.set("id_token_hint", input.idTokenHint);
    if (input.registration?.email) query.set("login_hint", input.registration.email);
    query.set("response_type", "code");
    query.set("redirect_uri", CHATGPT_REDIRECT);
    query.set("scope", SCOPES);
    query.set("resource", RESOURCE);
    query.set("state", attempt.state);
    query.set("nonce", attempt.nonce);
    query.set("code_challenge_method", "S256");
    query.set("code_challenge", createHash("sha256").update(attempt.verifier).digest("base64url"));
    return { url: `${this.issuer}/api/accounts/authorize?${query}`, attempt };
  }

  async finish(raw: unknown, callbackURL: unknown): Promise<Grant> {
    const attempt = raw as Attempt;
    const params = parseCallback(callbackURL);
    const state = params.get("state");
    if (!state || !same(state, attempt.state))
      throw new ApiError(400, "chatgpt_state", "This address belongs to a different or older sign-in. Paste the address from the newest ChatGPT tab, or start again.");
    if (params.get("error") === "access_denied")
      throw new ApiError(400, "chatgpt_declined", "You didn't allow Gond Agent to use your ChatGPT plan. Nothing was saved. Continue with ChatGPT again, or use an API key connection.");
    if (params.has("error")) throw new ApiError(400, "chatgpt_signin", "ChatGPT sign-in didn't finish. Start again.");
    const code = params.get("code"), returned = params.get("client_id");
    if (!code || code.length > 4096) throw invalidCallback();
    let clientId: string;
    if (attempt.clientId) {
      if (returned && returned !== attempt.clientId)
        throw new ApiError(400, "chatgpt_client", "ChatGPT returned a different app registration than the account you chose. Nothing was replaced. Start again.");
      clientId = attempt.clientId;
    } else {
      if (!returned || returned === REGISTRATION || !/^[A-Za-z0-9_.:-]{1,200}$/.test(returned))
        throw new ApiError(400, "chatgpt_registration", "ChatGPT didn't finish registering Gond Agent. Start again.");
      clientId = returned;
    }
    const response = await this.token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: CHATGPT_REDIRECT, resource: RESOURCE });
    if (!response.ok) {
      const { code: error } = errorCode(response.body);
      console.error("ChatGPT code exchange failed", response.status, error ?? "unknown");
      if (error === "invalid_grant") throw new ApiError(400, "chatgpt_code", "That sign-in address was already used or has expired. Start again.");
      throw new ApiError(502, "chatgpt_exchange", "ChatGPT sign-in couldn't be completed. Try again.", true);
    }
    const tokens = this.tokens(response.body);
    if (!tokens.idToken) throw new ApiError(502, "chatgpt_identity", "ChatGPT's sign-in response couldn't be verified. Try again.");
    let claims;
    try {
      claims = await verifyIdToken(tokens.idToken, { keys: refresh => this.jwks(refresh), issuer: this.issuer, audience: clientId, nonce: attempt.nonce });
    } catch (error) {
      console.error("ChatGPT ID token rejected:", (error as Error).message);
      throw new ApiError(502, "chatgpt_identity", "ChatGPT's sign-in response couldn't be verified. Try again.");
    }
    if (attempt.subject && claims.sub !== attempt.subject)
      throw new ApiError(400, "chatgpt_account", "You signed in to a different ChatGPT account than the one you chose. Nothing was replaced.");
    return { registration: { clientId, subject: claims.sub, email: typeof claims.email === "string" ? claims.email.slice(0, 320) : undefined }, tokens };
  }

  async refresh(registration: Registration, old: Tokens): Promise<Tokens> {
    if (!old.refreshToken) throw new ReauthRequired("No refresh token");
    const response = await this.token({ grant_type: "refresh_token", client_id: registration.clientId, refresh_token: old.refreshToken, resource: RESOURCE });
    if (response.ok) return this.tokens(response.body, old);
    const { code } = errorCode(response.body);
    console.error("ChatGPT token refresh failed", response.status, code ?? "unknown");
    if (code && TERMINAL_REFRESH.has(code)) throw new ReauthRequired(code);
    throw new ApiError(503, "chatgpt_unavailable", "ChatGPT couldn't renew this sign-in right now. Try again shortly.", true);
  }

  async revoke(registration: Registration, tokens: Tokens) {
    if (!tokens.refreshToken) return true;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
      try {
        const endpoint = (await this.discover()).revocation_endpoint;
        if (!endpoint) return false;
        const response = await this.fetch(endpoint, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: tokens.refreshToken, token_type_hint: "refresh_token", client_id: registration.clientId }),
        });
        await response.body?.cancel();
        if (response.status === 200) return true;
        if (response.status < 500) return false;
      } catch { /* Retry network failures while the refresh token is still available. */ }
    }
    return false;
  }

  planEnabled(tokens: Tokens) { return tokens.scopes.includes(PLAN_SCOPE); }

  headers(tokens: Tokens) { return { authorization: `Bearer ${tokens.accessToken}` }; }

  async models(tokens: Tokens, signal: AbortSignal): Promise<SubscriptionModel[]> {
    let response: Response;
    try { response = await this.fetch(`${this.baseURL}/models`, { headers: this.headers(tokens), redirect: "error", signal }); }
    catch { throw new ApiError(503, "chatgpt_unavailable", "ChatGPT couldn't be reached to list models. Try again shortly.", true); }
    const body = await response.json().catch(() => null) as { models?: unknown } | null;
    if (!response.ok) throw this.failure(response.status, body).error;
    if (!Array.isArray(body?.models)) throw new ApiError(502, "chatgpt_models", "ChatGPT didn't return a model list.");
    const models: SubscriptionModel[] = [];
    for (const value of body.models.slice(0, 500)) {
      const m = value as Record<string, unknown> | null;
      if (!m || m.visibility !== "list" || typeof m.slug !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(m.slug)) continue;
      const model: SubscriptionModel = { id: m.slug, name: typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim().slice(0, 120) : m.slug };
      if (Number.isInteger(m.context_window) && (m.context_window as number) >= 1024 && (m.context_window as number) <= 10_000_000) model.contextWindow = m.context_window as number;
      if (Array.isArray(m.supported_reasoning_levels)) model.efforts = m.supported_reasoning_levels.map(l => typeof l === "string" ? l : (l as { effort?: unknown })?.effort).filter((e): e is string => typeof e === "string" && /^[a-z]{1,12}$/.test(e));
      if (Array.isArray(m.input_modalities)) model.images = m.input_modalities.includes("image");
      models.push(model);
    }
    return models;
  }

  failure(status: number, body: unknown) { return chatgptFailure(status, body); }

  private tokens(body: unknown, old?: Tokens): Tokens {
    const b = body as Record<string, unknown> | null;
    if (typeof b?.access_token !== "string" || !b.access_token)
      throw new ApiError(502, "chatgpt_exchange", "ChatGPT sign-in couldn't be completed. Try again.", true);
    const lifetime = typeof b.expires_in === "number" && b.expires_in > 0 ? Math.min(b.expires_in, 86400) : 3600;
    const scope = typeof b.scope === "string" ? b.scope : old ? undefined : SCOPES;
    return {
      accessToken: b.access_token,
      refreshToken: typeof b.refresh_token === "string" && b.refresh_token ? b.refresh_token : old?.refreshToken,
      idToken: typeof b.id_token === "string" && b.id_token ? b.id_token : old?.idToken,
      expiresAt: Date.now() + lifetime * 1000,
      scopes: scope !== undefined ? [...new Set(scope.split(/[\s+]+/).filter(Boolean))].sort() : old?.scopes ?? [],
    };
  }

  private async token(form: Record<string, string>) {
    try {
      const response = await this.fetch(`${this.issuer}/api/accounts/oauth/token`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(form),
      });
      return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) as unknown };
    } catch {
      throw new ApiError(503, "chatgpt_unavailable", "ChatGPT couldn't be reached. Try again shortly.", true);
    }
  }

  private discover() {
    if (!this.discovery || Date.now() - this.discovery.at > 3600_000) {
      const value = (async () => {
        const response = await this.fetch(`${this.issuer}/.well-known/openid-configuration`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
        const doc = await response.json() as Discovery;
        if (!response.ok || doc.issuer !== this.issuer || typeof doc.jwks_uri !== "string") throw new Error("Invalid OpenID configuration");
        return doc;
      })();
      this.discovery = { at: Date.now(), value };
      value.catch(() => { this.discovery = undefined; });
    }
    return this.discovery.value;
  }

  private async jwks(refresh: boolean) {
    if (!refresh && this.keys && Date.now() - this.keys.at < 3600_000) return this.keys.value;
    const response = await this.fetch((await this.discover()).jwks_uri, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    const body = await response.json() as { keys?: JsonWebKey[] };
    if (!response.ok || !Array.isArray(body.keys)) throw new Error("Invalid JWKS");
    this.keys = { at: Date.now(), value: body.keys };
    return body.keys;
  }
}
