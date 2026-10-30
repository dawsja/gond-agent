import { describe, expect, it, vi } from "vitest";
import { command } from "../src/command";

describe("bounded service commands", () => {
  it("reports stderr during execution while preserving binary stdout", async () => {
    const progress: string[] = [];
    const out = await command(process.execPath, ["-e", "process.stderr.write('Receiving objects: 25%\\r');process.stdout.write(Buffer.from([0,255,1]))"], { onStderr: text => progress.push(text) });
    expect(out).toEqual(Buffer.from([0, 255, 1]));
    expect(progress.join("")).toContain("Receiving objects: 25%");
  });
  it("rejects output over a caller's limit", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(command(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { maxBuffer: 64 })).rejects.toThrow("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    } finally { log.mockRestore(); }
  });
});
