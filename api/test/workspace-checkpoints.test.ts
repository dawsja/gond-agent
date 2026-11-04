// Transport-level ordering tests, not Docker lifecycle verification.
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

it("flushes final persistence before snapshot and captures the new published HEAD while idle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gond-checkpoint-order-"));
  const stdout = new PassThrough();
  const calls: string[] = [];
  const pins: unknown[] = [];
  let boundary = 0;
  const emit = (frame: unknown) => stdout.write(JSON.stringify(frame) + "\n");
  const ready = () => emit({ checkpoint: { boundary_id: (++boundary).toString(16).padStart(32, "0") } });
  const child = Object.assign(new EventEmitter(), {
    stdout, stderr: new PassThrough(), exitCode: 0,
    stdin: new Writable({ write(chunk, _encoding, done) {
      const frame = JSON.parse(chunk.toString());
      calls.push(frame.method);
      queueMicrotask(() => {
        if (frame.method === "export_state" && frame.hold) ready();
        if (frame.method === "checkpoint") pins.push(frame.head_sha);
        emit({ id: frame.id, result: frame.method === "checkpoint"
          ? { boundary_id: frame.boundary_id, state: { runner_state_version: "test" }, head_sha: frame.head_sha }
          : true });
      });
      done();
    } }),
  });
  mocks.spawn.mockReturnValue(child);
  const workspace = await new ContainerPool({ data: dir, maxRuns: 1 } as Config)
    .start("run_0123456789abcdef01234567", async () => new Response());
  try {
    let savedHead: string | undefined;
    let saveStarted = deferred();
    let saveDone = deferred();
    await workspace.enableCheckpoints!({ owner_id: "owner", base_sha: "base", head_sha: "prepublish", identity: { name: "Name", email: "n@example.com" } }, async (cp) => {
      saveStarted.resolve();
      await saveDone.promise;
      savedHead = cp.head_sha;
    });
    ready(); // Final main round: turn.end is delivered by the runner after release.
    await saveStarted.promise;
    let flushed = false;
    const flush = workspace.flushCheckpoints!().then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false);
    expect(calls).not.toContain("checkpoint.release");
    saveDone.resolve();
    await flush;
    expect(savedHead).toBe("prepublish");
    expect(pins).toEqual(["prepublish"]);
    expect(calls.at(-1)).toBe("checkpoint.release");
    await workspace.rpc("snapshot");

    saveStarted = deferred();
    saveDone = deferred();
    const capture = workspace.captureCheckpoint!({ head_sha: "published" });
    await saveStarted.promise; // Ready can arrive before hold export's acknowledgement.
    let captured = false;
    const completed = capture.then(() => { captured = true; });
    await Promise.resolve();
    expect(captured).toBe(false);
    expect(savedHead).toBe("prepublish");
    await expect(workspace.captureCheckpoint!({ head_sha: "must-not-replace" })).rejects.toThrow("already pending");
    saveDone.resolve();
    await completed;
    expect(savedHead).toBe("published");
    expect(pins).toEqual(["prepublish", "published"]);
    expect(calls.slice(-3)).toEqual(["export_state", "checkpoint", "checkpoint.release"]);

    await workspace.captureCheckpoint!();
    expect(pins).toEqual(["prepublish", "published", "published"]);
  } finally {
    await workspace.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

it("flush and explicit capture reject failed persistence, but still release the hold", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gond-checkpoint-failure-"));
  const stdout = new PassThrough();
  const calls: string[] = [];
  mocks.spawn.mockReturnValue(Object.assign(new EventEmitter(), {
    stdout, stderr: new PassThrough(), exitCode: 0,
    stdin: new Writable({ write(chunk, _encoding, done) {
      const frame = JSON.parse(chunk.toString());
      calls.push(frame.method);
      queueMicrotask(() => {
        if (frame.hold) stdout.write(JSON.stringify({ checkpoint: { boundary_id: "a".repeat(32) } }) + "\n");
        stdout.write(JSON.stringify({ id: frame.id, result: {} }) + "\n");
      });
      done();
    } }),
  }));
  const workspace = await new ContainerPool({ data: dir, maxRuns: 1 } as Config)
    .start("run_0123456789abcdef01234567", async () => new Response());
  try {
    await expect(workspace.captureCheckpoint!()).rejects.toThrow("not enabled");
    await workspace.enableCheckpoints!({ owner_id: "owner", base_sha: "base", identity: { name: "Name", email: "n@example.com" } }, () => { throw new Error("save failed"); });
    await expect(workspace.captureCheckpoint!()).rejects.toThrow("save failed");
    await expect(workspace.flushCheckpoints!()).rejects.toThrow("save failed");
    expect(calls.at(-1)).toBe("checkpoint.release");
  } finally {
    await workspace.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});
