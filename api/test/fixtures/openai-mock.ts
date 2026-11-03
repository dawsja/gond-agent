// A local stand-in for OpenAI's "Sign in with ChatGPT" issuer and plan-usage API. It enforces the
// documented open-source flow and preview limits so tests fail when the client drifts from them:
// https://developers.openai.com/siwc/token-sharing-open-source
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const REDIRECT = /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/;
const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
const RESOURCE = "https://api.openai.com/v1";
const FORBIDDEN = ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id"];
const HOSTED = ["image_generation", "file_search", "code_interpreter", "computer_use", "computer_use_preview", "mcp", "tool_search", "programmatic_tool_calling"];

interface Code { client: string; challenge: string; redirect: string; nonce: string; subject: string; scope: string; used: boolean }
interface Refresh { client: string; subject: string; scope: string; state: "active" | "used" | "revoked" }

export interface MockOptions { subject?: string; email?: string }

export class OpenAIMock {
  url = "";
  server: Server;
  readonly keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  /** What the simulated person does on the consent screen. */
  consent: "approve" | "deny" | "no-plan-scope" = "approve";
  /** Force the callback to name a different issued client (reauthorization must reject it). */
  returnClientId?: string;
  sharedClientId?: string;
  /** Sign ID tokens with a wrong nonce. */
  wrongNonce = false;
  accessLifetime = 3600;
  omitTokenScope = false;
  refreshDelay = 0;
  revokeFailures = 0;
  subject: string;
  email: string;
  clients = new Map<string, { subject: string }>();
  codes = new Map<string, Code>();
  refreshTokens = new Map<string, Refresh>();
  accessTokens = new Map<string, { client: string; expires: number; scope: string }>();
  /** Every secret the issuer handed out, so tests can prove none of them leak. */
  issued: string[] = [];
  calls: { method: string; path: string; body?: unknown; form?: Record<string, string>; auth?: string }[] = [];
  revoked: Record<string, string>[] = [];
  /** Queue of failures returned by POST /v1/responses before any stream opens. */
  responseFailures: { status: number; body: unknown }[] = [];
  /** Fail the next stream after it opens, with this Responses error code. */
  streamFailure?: string;
  /** Answer the next request with 401 once, even with a valid token. */
  rejectOnce = false;

  constructor(options: MockOptions = {}) {
    this.subject = options.subject ?? "user-sub-1";
    this.email = options.email ?? "person@example.test";
    this.server = createServer((req, res) => void this.handle(req, res).catch(error => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    }));
  }

  async start() {
    await new Promise<void>(resolve => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this;
  }
  close() { return new Promise<void>(resolve => this.server.close(() => resolve())); }
  count(path: string) { return this.calls.filter(c => c.path === path).length; }

  private secret(prefix: string) { const value = `${prefix}_${randomBytes(18).toString("base64url")}`; this.issued.push(value); return value; }

  private idToken(client: string, nonce: string, subject: string) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "mock-key", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: this.url, aud: client, sub: subject, email: this.email, nonce: this.wrongNonce ? "other-nonce" : nonce, iat: now, exp: now + 3600 })).toString("base64url");
    const token = `${header}.${payload}.${sign("sha256", Buffer.from(`${header}.${payload}`), this.keys.privateKey).toString("base64url")}`;
    this.issued.push(token);
    return token;
  }

  private tokens(client: string, subject: string, scope: string, nonce?: string) {
    const access = this.secret("at"), refresh = this.secret("rt");
    this.accessTokens.set(access, { client, expires: Date.now() + this.accessLifetime * 1000, scope });
    this.refreshTokens.set(refresh, { client, subject, scope, state: "active" });
    return { access_token: access, refresh_token: refresh, ...(nonce !== undefined ? { id_token: this.idToken(client, nonce, subject) } : {}), token_type: "Bearer", expires_in: this.accessLifetime, ...(this.omitTokenScope ? {} : { scope }), earliest_refresh_at: Math.floor(Date.now() / 1000) };
  }

  /** Expires every issued access token, as if an hour had passed. */
  expireAccess() { for (const token of this.accessTokens.values()) token.expires = 0; }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.url);
    const raw = await new Promise<string>(resolve => { let b = ""; req.on("data", c => b += c); req.on("end", () => resolve(b)); });
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "x-request-id": "req_mock" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
    const form = req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : undefined;
    const body = req.headers["content-type"]?.startsWith("application/json") && raw ? JSON.parse(raw) : undefined;
    this.calls.push({ method: req.method!, path: url.pathname, body, form, auth: req.headers.authorization });

    if (url.pathname === "/.well-known/openid-configuration")
      return json(200, { issuer: this.url, authorization_endpoint: `${this.url}/api/accounts/authorize`, token_endpoint: `${this.url}/api/accounts/oauth/token`, jwks_uri: `${this.url}/jwks`, revocation_endpoint: `${this.url}/oauth/revoke` });
    if (url.pathname === "/jwks") return json(200, { keys: [{ ...this.keys.publicKey.export({ format: "jwk" }), kid: "mock-key", use: "sig", alg: "RS256" }] });
    if (url.pathname === "/api/accounts/authorize") return this.authorize(url.searchParams, res, json);
    if (url.pathname === "/api/accounts/oauth/token") return this.token(form ?? {}, json);
    if (url.pathname === "/oauth/revoke") {
      if (this.revokeFailures > 0) { this.revokeFailures--; return json(503, { error: "temporarily_unavailable" }); }
      this.revoked.push(form ?? {});
      const token = this.refreshTokens.get(form?.token ?? "");
      if (token && token.client === form?.client_id) token.state = "revoked";
      res.writeHead(200); return res.end();
    }
    if (url.pathname === "/v1/models" || url.pathname === "/v1/responses") {
      const token = this.accessTokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (this.rejectOnce) { this.rejectOnce = false; return json(401, { error: { code: "invalid_token", message: "expired" } }); }
      if (!token || token.expires < Date.now()) return json(401, { error: { code: "invalid_token", message: "The access token is invalid or expired." } });
      if (!token.scope.split(" ").includes("chatgpt.tokens.use.direct")) return json(403, { error: { code: "chatpass_v2_scope_not_authorized" } });
      if (url.pathname === "/v1/models") {
        if (req.method !== "GET") return json(403, { error: { code: "subscription_sharing_route_not_supported" } });
        return json(200, { models: [
          { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", context_window: 272000, supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }], input_modalities: ["text", "image"] },
          { slug: "gpt-5.5-mini", display_name: "GPT-5.5 mini", visibility: "list" },
          { slug: "internal-preview", display_name: "Internal", visibility: "hide" },
        ] });
      }
      return this.responses(body, res, json);
    }
    return json(404, { detail: "Not found" });
  }

  private authorize(q: URLSearchParams, res: ServerResponse, json: (s: number, b: unknown) => void) {
    const problems: string[] = [];
    const client = q.get("client_id") ?? "";
    const dynamic = client === "dynamic_agent_client";
    if (!dynamic && !this.clients.has(client)) problems.push("unknown client_id");
    if (dynamic !== q.has("agent_name_hint")) problems.push("agent_name_hint belongs only to first registration");
    if (dynamic && q.get("agent_name_hint") !== "Gond Agent") problems.push("agent_name_hint");
    if (!/^(urn:uuid:[0-9a-f-]{36}|urn:ietf:params:oauth:jwk-thumbprint:.+|did:key:.+)$/.test(q.get("ext_agent_host_id") ?? "")) problems.push("ext_agent_host_id");
    if (q.get("response_type") !== "code") problems.push("response_type");
    const redirect = q.get("redirect_uri") ?? "";
    if (!REDIRECT.test(redirect)) problems.push("redirect_uri");
    if (q.get("scope")?.split(" ").sort().join(" ") !== [...SCOPES].sort().join(" ")) problems.push("scope");
    if (q.get("resource") !== RESOURCE) problems.push("resource");
    if (!q.get("state") || !q.get("nonce")) problems.push("state/nonce");
    if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") ?? "")) problems.push("pkce");
    if (dynamic && (q.has("id_token_hint") || q.has("login_hint"))) problems.push("hints belong to reauthorization");
    if (problems.length) return json(400, { error: "invalid_request", problems });
    const back = new URL(redirect);
    back.searchParams.set("state", q.get("state")!);
    if (this.consent === "deny") { back.searchParams.set("error", "access_denied"); res.writeHead(302, { location: back.toString() }); return res.end(); }
    let issued = client;
    if (dynamic) { issued = this.sharedClientId ?? this.secret("oaiapp"); this.clients.set(issued, { subject: this.subject }); }
    const scope = this.consent === "no-plan-scope" ? SCOPES.filter(s => s !== "chatgpt.tokens.use.direct").join(" ") : SCOPES.join(" ");
    const code = this.secret("code");
    this.codes.set(code, { client: issued, challenge: q.get("code_challenge")!, redirect, nonce: q.get("nonce")!, subject: this.clients.get(issued)!.subject, scope, used: false });
    back.searchParams.set("code", code);
    back.searchParams.set("scope", scope);
    if (dynamic || this.returnClientId) back.searchParams.set("client_id", this.returnClientId ?? issued);
    res.writeHead(302, { location: back.toString() });
    res.end();
  }

  private async token(form: Record<string, string>, json: (s: number, b: unknown) => void) {
    if (form.resource !== RESOURCE) return json(400, { error: "invalid_target" });
    if (form.client_secret) return json(400, { error: "invalid_client" });
    if (form.grant_type === "authorization_code") {
      const code = this.codes.get(form.code ?? "");
      if (!code || code.used) return json(400, { error: "invalid_grant" });
      code.used = true;
      if (form.client_id !== code.client || form.client_id === "dynamic_agent_client") return json(400, { error: "invalid_client" });
      if (form.redirect_uri !== code.redirect) return json(400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
      if (createHash("sha256").update(form.code_verifier ?? "").digest("base64url") !== code.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE" });
      return json(200, this.tokens(code.client, code.subject, code.scope, code.nonce));
    }
    if (form.grant_type === "refresh_token") {
      if (this.refreshDelay) await new Promise(resolve => setTimeout(resolve, this.refreshDelay));
      const token = this.refreshTokens.get(form.refresh_token ?? "");
      if (!token || token.client !== form.client_id) return json(400, { error: "invalid_grant" });
      if (form.scope) return json(400, { error: "invalid_scope" });
      if (token.state === "used") {
        // Reuse of a rotated token ends the whole session family.
        for (const t of this.refreshTokens.values()) if (t.client === token.client) t.state = "revoked";
        return json(400, { error: "refresh_token_reused" });
      }
      if (token.state === "revoked") return json(400, { error: "refresh_token_invalidated" });
      token.state = "used";
      return json(200, this.tokens(token.client, token.subject, token.scope));
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  /** Rejects anything the plan-usage preview does not accept, with the documented error shape. */
  static violation(body: Record<string, any> | undefined): string | undefined {
    if (!body) return "body";
    if (body.store !== false) return "store";
    if (body.stream !== true) return "stream";
    for (const key of FORBIDDEN) if (key in body) return key;
    if (!Array.isArray(body.input)) return "input";
    const namespaces = new Set<string>();
    for (const tool of body.tools ?? []) {
      if (tool.type !== "namespace") return HOSTED.includes(tool.type) ? `tools.${tool.type}` : "tools";
      if (!tool.name || !Array.isArray(tool.tools) || tool.tools.some((t: { type: string }) => !["function", "custom"].includes(t.type))) return "tools";
      namespaces.add(tool.name);
    }
    for (const item of body.input) {
      if (item.role === "system") return "input.role";
      if (item.type === "function_call" && !namespaces.has(item.namespace)) return "input.function_call.namespace";
      for (const part of Array.isArray(item.content) ? item.content : [])
        if (!["input_text", "input_image", "input_file", "output_text"].includes(part.type)) return `input.content.${part.type}`;
    }
    return undefined;
  }

  private responses(body: Record<string, any> | undefined, res: ServerResponse, json: (s: number, b: unknown) => void) {
    const failure = this.responseFailures.shift();
    if (failure) return json(failure.status, failure.body);
    const violation = OpenAIMock.violation(body);
    if (violation) return json(400, { error: { code: "subscription_sharing_unsupported_capability", param: violation, message: "Unsupported for ChatGPT plan usage." } });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: Record<string, unknown>) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: "response.created", response: { id: "resp_mock" } });
    if (this.streamFailure) {
      send({ type: "response.failed", response: { error: { code: this.streamFailure, message: "plan failure" } } });
      this.streamFailure = undefined;
      return res.end();
    }
    const last = body!.input.at(-1);
    if (body!.tools?.length && last?.type !== "function_call_output") {
      const item = { type: "function_call", call_id: "call_mock", namespace: body!.tools[0].name, name: "read", arguments: '{"path":"README.md"}' };
      send({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
      send({ type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments });
      send({ type: "response.output_item.done", output_index: 0, item });
    } else {
      send({ type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant" } });
      send({ type: "response.output_text.delta", output_index: 0, delta: "Plan request completed." });
      send({ type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Plan request completed." }] } });
    }
    send({ type: "response.completed", response: { id: "resp_mock", usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 20 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 10 } } } });
    res.end();
  }
}
