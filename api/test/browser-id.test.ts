import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "../../web/src/lib/id";

afterEach(() => vi.unstubAllGlobals());

describe("browser UI identifiers", () => {
  it("works without the secure-context-only randomUUID API", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.set(Array.from({ length: bytes.length }, (_, i) => i));
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });
    expect(randomId()).toBe("000102030405060708090a0b0c0d0e0f");
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it("creates unique provider-safe identifiers", () => {
    const ids = Array.from({ length: 1000 }, randomId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => /^[a-f0-9]{32}$/.test(id))).toBe(true);
  });
});
