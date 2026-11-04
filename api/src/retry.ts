export type RetryClass = "network" | "tls" | "timeout" | "server" | "rate_limit" | "auth" | "client" | "rejected" | "unknown";
export interface RetryFailure {
  class: RetryClass;
  retryable: boolean;
  reason: string;
  retryAfterMs?: number;
  /** Positive evidence that an API mutation can be replayed without an ambiguous outcome. */
  safeToReplay?: boolean;
}
export interface RetryOptions {
  /** Total attempts, including the first; never more than five. */
  maxAttempts?: number;
  /** Shared budget for attempts and waits; callbacks must bound their work by remainingMs. */
  totalTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/** Safe classified command failure, before an operation's retry budget is applied. */
export class ClassifiedRetryFailure extends Error implements RetryFailure {
  readonly class: RetryClass;
  readonly retryable: boolean;
  readonly reason: string;
  readonly retryAfterMs?: number;
  readonly safeToReplay?: boolean;
  constructor(failure: RetryFailure) {
    super(failure.reason);
    this.name = "ClassifiedRetryFailure";
    this.class = failure.class;
    this.retryable = failure.retryable;
    this.reason = failure.reason;
    this.retryAfterMs = failure.retryAfterMs;
    this.safeToReplay = failure.safeToReplay;
  }
}

/** Contains only classified, customer-safe information; never retains the original error. */
export class RetryError extends Error {
  readonly step: string;
  readonly class: RetryClass;
  readonly attempts: number;
  readonly reason: string;
  readonly retryable: boolean;
  constructor(step: string, failure: RetryFailure, attempts: number) {
    super(failure.reason);
    this.name = "RetryError";
    this.step = step;
    this.class = failure.class;
    this.attempts = attempts;
    this.reason = failure.reason;
    this.retryable = failure.retryable;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString() : "";
function retryAfter(value: unknown, now: number): number | undefined {
  const raw = text(value).trim();
  if (!raw) return undefined;
  const ms = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now;
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}
function header(headers: unknown, name: string): unknown {
  if (headers instanceof Headers) return headers.get(name);
  return Object.entries(record(headers)).find(([key]) => key.toLowerCase() === name)?.[1];
}

/** Inspect raw failures here only. No raw message, URL, stderr or cause escapes classification. */
export function classifyRetryFailure(error: unknown, now = Date.now()): RetryFailure {
  if (error instanceof ClassifiedRetryFailure) return {
    class: error.class, retryable: error.retryable, reason: error.reason,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    ...(error.safeToReplay === undefined ? {} : { safeToReplay: error.safeToReplay }),
  };
  const e = record(error), response = record(e.response);
  const detail = [text(e.message), text(e.stderr)].join("\n").slice(-64 * 1024);
  const explicitStatus = e.status ?? e.statusCode ?? response.status;
  const matchedStatus = detail.match(/\bHTTP(?:\/\d(?:\.\d)?)?\s+(\d{3})\b|(?:returned error:|status(?: code)?:?)\s*(\d{3})\b/i);
  const status = Number(explicitStatus ?? matchedStatus?.[1] ?? matchedStatus?.[2]);
  const code = text(e.code);
  const timedOut = e.timedOut === true || /^(?:ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)$/.test(code) || /timed? out|\btimeout\b|deadline exceeded|operation too slow/i.test(detail);
  const failure = (kind: RetryClass, retryable: boolean, reason: string): RetryFailure => ({ class: kind, retryable, reason });
  // Permanent outcomes win even if accompanying diagnostics also mention a connection failure.
  if (status === 401 || status === 403 || /authentication failed|bad credentials|could not read (?:username|password)|permission denied|repository not found|terminal prompts disabled|invalid (?:username|password|token)|access denied/i.test(detail))
    return failure("auth", false, status === 401 || status === 403 ? `GitHub request failed (HTTP ${status}). Check your GitHub connection.` : "GitHub access was refused. Check your GitHub connection.");
  if (/non-fast-forward|\[rejected\]|\[remote rejected\]|fetch first|protected branch|pre-receive hook declined/i.test(detail))
    return failure("rejected", false, "The remote rejected the branch update. Check the branch before trying again.");
  if (status === 429 || status === 503) {
    const fromHeader = header(e.headers ?? response.headers, "retry-after");
    const fromText = detail.match(/^retry-after:\s*(.+)$/im)?.[1];
    const retryAfterMs = retryAfter(fromHeader ?? fromText, now);
    return {
      ...failure(status === 429 ? "rate_limit" : "server", true, status === 429 ? "GitHub is temporarily limiting requests. Try again shortly." : "GitHub returned 503"),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs, safeToReplay: !timedOut }),
    };
  }
  if (status >= 400 && status < 500) return failure("client", false, `GitHub request failed (HTTP ${status}). Check the request before trying again.`);
  if (status >= 500 && status <= 599) return failure("server", true, `GitHub returned ${status}`);
  if (timedOut)
    return failure("timeout", true, "The connection timed out. Try again shortly.");
  if (/^(?:ERR_SSL_|ERR_TLS_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(code) || /TLS|SSL (?:connection|connect|certificate)|certificate|gnutls_handshake/i.test(detail))
    return {
      ...failure("tls", true, "A secure connection could not be established. Try again shortly."),
      // A generic TLS read/write failure may happen after the request was sent.
      safeToReplay: /^(?:CERT_|ERR_TLS_CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(code) || /x509:|certificate (?:has expired|verify failed|verification failed|is (?:not |valid for)|signed by unknown authority)|SSL certificate problem|gnutls_handshake|(?:TLS|SSL) handshake|tls: (?:handshake failure|failed to verify)|SSL connect error/i.test(detail),
    };
  if (/^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_SOCKET)$/.test(code) || /socket hang up|could not resolve (?:host|proxy)|lookup .*: (?:no such host|server misbehaving)|temporary failure in name resolution|failed to connect|connection (?:reset|refused|closed|aborted)|network is unreachable|remote end hung up|unexpected (?:disconnect|EOF)|early EOF|empty reply from server|recv failure|send failure|HTTP\/2 stream .* (?:closed|cancel|error)|RPC failed; curl (?:5|6|7|18|28|35|52|55|56|92)\b/i.test(detail))
    return {
      ...failure("network", true, "The connection was interrupted. Try again shortly."),
      safeToReplay: /^(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN)$/.test(code) || /could not resolve (?:host|proxy)|lookup .*: (?:no such host|server misbehaving)|temporary failure in name resolution|connection refused/i.test(detail),
    };
  // fetch/undici commonly nests the useful system error in cause (or AggregateError.errors).
  const nested = [e.cause, ...(Array.isArray(e.errors) ? e.errors.slice(0, 8) : [])];
  const classifications: RetryFailure[] = [];
  for (const cause of nested) {
    if (cause && cause !== error) {
      const c = record(cause);
      classifications.push(classifyRetryFailure({ code: c.code, message: c.message, stderr: c.stderr, status: c.status, statusCode: c.statusCode, response: c.response, headers: c.headers, timedOut: c.timedOut }, now));
    }
  }
  const known = classifications.find(c => !c.retryable && c.class !== "unknown") ?? classifications.find(c => c.retryable);
  if (known) return { ...known, safeToReplay: classifications.every(c => c.safeToReplay === true) };
  return failure("unknown", false, "The operation could not be completed. Check the connection and try again.");
}

export function retryDelayMs(attempt: number, sample: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1)) * Math.max(0, Math.min(1, Number.isFinite(sample) ? sample : 0));
}

/** step must be a fixed internal label, never a URL, credential or request-supplied text. */
export async function withRetry<T>(step: string, fn: (attempt: number, remainingMs: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.min(5, Math.max(1, Math.floor(options.maxAttempts ?? 5) || 1));
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now, random = options.random ?? Math.random;
  const deadline = options.totalTimeoutMs === undefined ? Infinity : now() + Math.max(1, options.totalTimeoutMs);
  let lastFailure: RetryFailure | undefined;
  for (let attempt = 1; ; attempt++) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw new RetryError(step, lastFailure ?? classifyRetryFailure({ timedOut: true }), attempt - 1);
    try { return await fn(attempt, remainingMs); }
    catch (error) {
      // Nested named operations already exhausted their own budget; never multiply retries.
      if (error instanceof RetryError) throw error;
      if (record(error).cause instanceof RetryError) throw record(error).cause;
      const failure = classifyRetryFailure(error, now());
      lastFailure = failure;
      if (!failure.retryable || attempt >= attempts) throw new RetryError(step, failure, attempt);
      const jitter = retryDelayMs(attempt, random());
      // Retry-After is a server minimum, not subject to the exponential backoff cap.
      const delay = Math.max(jitter, failure.retryAfterMs ?? 0);
      // Never shorten a server wait or sleep beyond the caller's total budget.
      if (delay >= deadline - now()) throw new RetryError(step, failure, attempt);
      await sleep(delay);
    }
  }
}
