import { describe, expect, it, vi } from "vitest";
import { command } from "../src/command";
import { inspect } from "node:util";
import { ClassifiedRetryFailure } from "../src/retry";

describe("bounded service commands", () => {
  it("reports stderr during execution while preserving binary stdout", async () => {
    const progress: string[] = [];
    const out = await command(process.execPath, ["-e", "process.stderr.write('Receiving objects: 25%\\r');process.stdout.write(Buffer.from([0,255,1]))"], { onStderr: text => progress.push(text) });
    expect(out).toEqual(Buffer.from([0, 255, 1]));
    expect(progress.join("")).toContain("Receiving objects: 25%");
  });
  it.each([
    ["gh: request failed (HTTP 500)", "server"],
    ["gnutls_handshake() failed: TLS connection interrupted", "tls"],
    ["bad credentials (HTTP 401), connection reset", "auth"],
  ])("classifies raw stderr safely: %s", async (diagnostic, kind) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "https://user:private-token@private.example.test/path?key=private-secret";
    try {
      const script = `process.stdout.write(${JSON.stringify(secret)});process.stderr.write(${JSON.stringify(`${diagnostic} ${secret}`)});process.exit(1)`;
      const error = await command(process.execPath, ["-e", script, secret]).catch(error => error);
      expect(error).toBeInstanceOf(ClassifiedRetryFailure);
      expect(error).toMatchObject({ class: kind, retryable: kind !== "auth" });
      expect(error.stderr).toBeUndefined();
      expect(error.stdout).toBeUndefined();
      expect(error.cause).toBeUndefined();
      for (const rendered of [String(error), inspect(error), JSON.stringify(error), inspect(log.mock.calls)]) {
        expect(rendered).not.toMatch(/private-token|private-secret|private\.example|process\.stderr|key=/);
      }
      expect(log).toHaveBeenCalledWith("command failed", { operation: "node", class: kind, reason: error.reason });
    } finally { log.mockRestore(); }
  });

  it("classifies a killed command as a timeout without retaining its arguments", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(command(process.execPath, ["-e", "setInterval(() => {}, 1000)", "private-token"], { timeout: 50 }))
        .rejects.toMatchObject({ class: "timeout", retryable: true });
      expect(inspect(log.mock.calls)).not.toContain("private-token");
    } finally { log.mockRestore(); }
  });

  it.each(["12", "Thu, 01 Jan 1970 00:00:12 GMT"])("classifies stdout HTTP headers and Retry-After %s", async retryAfter => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const response = `HTTP/2.0 429 Too Many Requests\r\nrEtRy-AfTeR: ${retryAfter}\r\n\r\n{\"secret\":\"private-token\"}`;
      const error = await command(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(response)});process.exit(1)`]).catch(error => error);
      expect(error).toBeInstanceOf(ClassifiedRetryFailure);
      expect(error).toMatchObject({ class: "rate_limit", retryAfterMs: 12_000 });
      expect(inspect(error)).not.toContain("private-token");
    } finally { clock.mockRestore(); log.mockRestore(); }
  });

  it("rejects output over a caller's limit", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(command(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { maxBuffer: 64 })).rejects.toThrow("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    } finally { log.mockRestore(); }
  });
});
