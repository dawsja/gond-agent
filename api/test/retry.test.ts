import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { classifyRetryFailure, retryDelayMs, RetryError, withRetry } from "../src/retry";

describe("bounded safe retries", () => {
  it("bounds full jitter and caps exponential backoff at 30 seconds", () => {
    for (let attempt = 1; attempt < 20; attempt++) {
      const bound = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      expect(retryDelayMs(attempt, 0)).toBe(0);
      expect(retryDelayMs(attempt, 0.5)).toBe(bound / 2);
      expect(retryDelayMs(attempt, 1)).toBe(bound);
    }
  });
  it("retries a certificate mismatch without retaining the credential URL", async () => {
    const fn = vi.fn(async (attempt: number) => {
      if (attempt < 3) throw new Error("x509: certificate is valid for another host, not https://secret@private.test");
      return "connected";
    });
    await expect(withRetry("github_api", fn, {sleep:async () => {},random:() => 0})).resolves.toBe("connected");
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it("uses five total attempts and full-jitter exponential delays, with injectable timing", async () => {
    const calls: number[] = [], sleep = vi.fn(async (_ms: number) => {});
    const result = await withRetry("push", async attempt => {
      calls.push(attempt);
      if (attempt < 5) throw Object.assign(new Error("private https://secret@example.test"), { code: "ECONNRESET" });
      return "saved";
    }, { sleep, random: () => 0.5, now: () => 123 });
    expect(result).toBe("saved");
    expect(calls).toEqual([1, 2, 3, 4, 5]);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000, 2000, 4000]);
  });

  it("exhausts at five, exposes structured safe fields, and never retains raw errors", async () => {
    const fn = vi.fn(async () => { throw { status: 503, message: "https://token:password@private.test/path?key=secret", stderr: "Bearer secret" }; });
    const error = await withRetry("github_api", fn, { maxAttempts: 99, sleep: async () => {}, random: () => 0 }).catch(error => error);
    expect(fn).toHaveBeenCalledTimes(5);
    expect(error).toBeInstanceOf(RetryError);
    expect(error).toMatchObject({ step: "github_api", class: "server", attempts: 5, retryable: true });
    expect(inspect(error)).not.toMatch(/private\.test|password|Bearer|key=|secret/);
    expect(JSON.stringify(error)).not.toMatch(/private\.test|password|Bearer|key=|secret/);
    expect(error.cause).toBeUndefined();
  });

  it.each([
    [{ status: 401, message: "connection reset" }, "auth"],
    [{ status: 403, headers: { "Retry-After": "2" } }, "auth"],
    [{ status: 404 }, "client"],
    [{ status: 422 }, "client"],
    [new Error("! [rejected] HEAD -> main (non-fast-forward) connection reset"), "rejected"],
    [new Error("remote: pre-receive hook declined"), "rejected"],
    [new Error("bad credentials; TLS connection failed"), "auth"],
    [new Error("arbitrary application failure"), "unknown"],
  ])("does not retry permanent or unclassified failures (%s)", async (failure, kind) => {
    const fn = vi.fn(async () => { throw failure; }), sleep = vi.fn(async () => {});
    await expect(withRetry("push", fn, { sleep })).rejects.toMatchObject({ class: kind, attempts: 1, retryable: false });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: "EAI_AGAIN" }, "network"],
    [{ cause: { code: "ECONNRESET" } }, "network"],
    [{ code: "CERT_HAS_EXPIRED" }, "tls"],
    [new Error("gnutls_handshake() failed"), "tls"],
    [{ code: "UND_ERR_HEADERS_TIMEOUT" }, "timeout"],
    [{ timedOut: true }, "timeout"],
    [new Error("fatal: unable to access 'https://private.test': The requested URL returned error: 502"), "server"],
    [new Error("gh: temporary failure (HTTP 503)"), "server"],
  ])("centrally classifies transient failures (%s)", (failure, kind) => {
    expect(classifyRetryFailure(failure)).toMatchObject({ class: kind, retryable: true });
  });

  it.each(["12", "Thu, 01 Jan 1970 00:00:12 GMT"])("honors Retry-After %s as a minimum with an injected clock", async retryAfter => {
    const sleep = vi.fn(async (_ms: number) => {});
    await withRetry("github_api", async attempt => {
      if (attempt === 1) throw { status: 429, headers: new Headers({ "Retry-After": retryAfter }) };
      return true;
    }, { sleep, now: () => 0, random: () => 0.5 });
    expect(sleep).toHaveBeenCalledWith(12_000);
  });

  it("does not multiply nested retry budgets", async () => {
    const fn = vi.fn(async () => { throw { status: 502 }; });
    const options = { sleep: async () => {}, random: () => 0 };
    await expect(withRetry("publication", () => withRetry("push", fn, options), options)).rejects.toMatchObject({ step: "push", attempts: 5 });
    expect(fn).toHaveBeenCalledTimes(5);
  });
});
