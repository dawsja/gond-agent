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
import { CHECKPOINT_MIN_INTERVAL_MS, ContainerPool } from "../src/containers";

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
    const save = vi.fn().mockImplementationOnce(() => { throw new Error("save failed"); });
    await workspace.enableCheckpoints!({ owner_id: "owner", base_sha: "base", identity: { name: "Name", email: "n@example.com" } }, save);
    await expect(workspace.captureCheckpoint!()).rejects.toThrow("save failed");
    await expect(workspace.flushCheckpoints!()).rejects.toThrow("save failed");
    expect(calls.at(-1)).toBe("checkpoint.release");
    await expect(workspace.captureCheckpoint!()).resolves.toBeUndefined();
    await expect(workspace.flushCheckpoints!()).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledTimes(2);
  } finally {
    await workspace.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

it("throttles ordinary captures, skips unchanged pairs, and forces publication captures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gond-checkpoint-throttle-"));
  const stdout = new PassThrough();
  const calls: Record<string, any>[] = [];
  let now = 1000, boundary = 0, fingerprint = "first";
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const emit = (value: unknown) => stdout.write(JSON.stringify(value) + "\n");
  const ready = () => emit({ checkpoint: { boundary_id: (++boundary).toString(16).padStart(32, "0") } });
  mocks.spawn.mockReturnValue(Object.assign(new EventEmitter(), {
    stdout, stderr: new PassThrough(), exitCode: 0,
    stdin: new Writable({ write(chunk, _encoding, done) {
      const frame = JSON.parse(chunk.toString());
      calls.push(frame);
      queueMicrotask(() => {
        if (frame.method === "export_state" && frame.hold) ready();
        emit({ id: frame.id, result: frame.method === "checkpoint"
          ? frame.previous_fingerprint === fingerprint ? { unchanged: true }
            : { fingerprint, state: { runner_state_version: "test" } }
          : true });
      });
      done();
    } }),
  }));
  const workspace = await new ContainerPool({ data: dir, maxRuns: 1 } as Config)
    .start("run_0123456789abcdef01234567", async () => new Response());
  try {
    const save = vi.fn();
    await workspace.enableCheckpoints!({ owner_id: "owner", base_sha: "base", identity: { name: "Name", email: "n@example.com" } }, save);
    ready();
    await workspace.flushCheckpoints!();
    expect(save).toHaveBeenCalledTimes(1);
    now += CHECKPOINT_MIN_INTERVAL_MS - 1;
    ready();
    await workspace.flushCheckpoints!();
    expect(calls.filter(call => call.method === "checkpoint")).toHaveLength(1);
    expect(calls.at(-1)?.method).toBe("checkpoint.release");
    now++;
    ready();
    await workspace.flushCheckpoints!();
    expect(calls.filter(call => call.method === "checkpoint")).toHaveLength(2);
    expect(save).toHaveBeenCalledTimes(1); // Identical tree and history: no persistence.
    fingerprint = "changed";
    now += CHECKPOINT_MIN_INTERVAL_MS;
    ready();
    await workspace.flushCheckpoints!();
    expect(save).toHaveBeenCalledTimes(2);
    fingerprint = "published";
    await workspace.captureCheckpoint!({ head_sha: "published-head" }); // No clock advance.
    expect(save).toHaveBeenCalledTimes(3);
    expect(calls.filter(call => call.method === "checkpoint").at(-1)).toMatchObject({ head_sha: "published-head", previous_fingerprint: "changed" });
    expect(calls.filter(call => call.method === "checkpoint.release")).toHaveLength(5);
  } finally {
    clock.mockRestore();
    await workspace.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});
