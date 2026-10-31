import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "../../web/src/lib/id";

afterEach(() => vi.unstubAllGlobals());

describe("browser UI identifiers", () => {
  it("creates distinct provider-safe identifiers without secure-context APIs", () => {
    let entropy = 1;
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(entropy++);
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });
    const first = randomId(), second = randomId();
    expect(first).toMatch(/^[a-zA-Z0-9_-]{1,80}$/);
    expect(second).toMatch(/^[a-zA-Z0-9_-]{1,80}$/);
    expect(second).not.toBe(first);
    expect(getRandomValues).toHaveBeenCalledTimes(2);
  });
});
