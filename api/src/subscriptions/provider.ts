import type { ApiError } from "../wire";

/** The vendor registration a sign-in created. Kept after sign-out so later sign-ins reuse it. */
export interface Registration { clientId: string; subject: string; email?: string }

/** One account's tokens. Stored only sealed with the auth secret, in the API service. */
export interface Tokens { accessToken: string; refreshToken?: string; idToken?: string; expiresAt: number; scopes: string[] }

export interface Grant { registration: Registration; tokens: Tokens }

export interface SubscriptionModel { id: string; name: string; contextWindow?: number; efforts?: string[]; images?: boolean }

/** How a failed request affects the account, besides the customer-facing error. */
export interface Failure { error: ApiError; effect?: "limited" | "not_eligible" | "reauth" }

/**
 * Model access through a consumer subscription instead of an API key. The account store owns
 * persistence, session binding, expiry, sealing and serialized refresh; a provider owns only the
 * vendor protocol, so another subscription can be added without changing callers.
 */
export interface SubscriptionProvider {
  readonly id: string;
  readonly name: string;
  /** Where customers review and manage plan usage. */
  readonly usageURL: string;
  /** Wire format the built-in runner's requests are translated to. */
  readonly format: "openai-responses";
  /** Starts a browser sign-in. `attempt` stays on the server and is passed back to `finish`. */
  start(input: { hostId: string; registration?: Registration; idTokenHint?: string }): { url: string; attempt: unknown };
  /** Completes a sign-in from the callback address the customer pasted. Never fetches that address. */
  finish(attempt: unknown, callbackURL: unknown): Promise<Grant>;
  /** Exchanges a refresh token. Throws `ReauthRequired` when the token can no longer be used. */
  refresh(registration: Registration, tokens: Tokens): Promise<Tokens>;
  /** Ends the renewable session. Resolves false when remote revocation could not be confirmed. */
  revoke(registration: Registration, tokens: Tokens): Promise<boolean>;
  planEnabled(tokens: Tokens): boolean;
  readonly baseURL: string;
  headers(tokens: Tokens): Record<string, string>;
  models(tokens: Tokens, signal: AbortSignal): Promise<SubscriptionModel[]>;
  /** Maps an upstream error status and body (or a streamed error object) to a plain message. */
  failure(status: number, body: unknown): Failure;
}

export class ReauthRequired extends Error {}
