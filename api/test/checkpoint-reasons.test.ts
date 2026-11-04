// Exercise real transport parsing; no Docker lifecycle claims.
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { Config } from "../src/config";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), command: vi.fn(async () => Buffer.from("")) }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/command", () => ({ command: mocks.command }));
import { ContainerPool } from "../src/containers";

it.each(["tree_too_large", "state_too_large", "timeout", "background_shells_active", "staged_ignored_files", "private/path?secret=123"])(
  "preserves only an allow-listed checkpoint reason across transport: %s", async reason => {
    const dir = await mkdtemp(join(tmpdir(), "gond-checkpoint-reason-"));
    const stdout = new PassThrough(), calls: string[] = [];
    mocks.spawn.mockReturnValue(Object.assign(new EventEmitter(), {
      stdout, stderr: new PassThrough(), exitCode: 0,
      stdin: new Writable({ write(chunk, _encoding, done) {
        const frame = JSON.parse(chunk.toString());
        calls.push(frame.method);
        queueMicrotask(() => {
          if (frame.hold) stdout.write(JSON.stringify({ checkpoint: { boundary_id: "a".repeat(32) } }) + "\n");
          stdout.write(JSON.stringify(frame.method === "checkpoint"
            ? { id: frame.id, error: "The workspace request failed.", checkpoint_reason: reason }
            : { id: frame.id, result: {} }) + "\n");
        });
        done();
      } }),
    }));
    const workspace = await new ContainerPool({ data: dir, maxRuns: 1 } as Config)
      .start("run_0123456789abcdef01234567", async () => new Response());
    try {
      const onError = vi.fn(), save = vi.fn();
      await workspace.enableCheckpoints!({ owner_id: "owner", base_sha: "base", identity: { name: "Name", email: "n@example.com" } }, save, onError);
      const expected = reason.includes("private") ? "unknown" : reason;
      await expect(workspace.captureCheckpoint!()).rejects.toMatchObject({ reason: expected });
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ reason: expected }));
      expect(save).not.toHaveBeenCalled();
      expect(calls.at(-1)).toBe("checkpoint.release");
    } finally {
      await workspace.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  });
