import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal, unseal } from "../src/auth";
import { CHECKPOINT_BUNDLE_MAX, CHECKPOINT_STATE_MAX, Checkpoints, checkpointSettings, type Checkpoint, type CheckpointKey, type CheckpointTree } from "../src/checkpoints";
import { openStore, type Store } from "../src/db";

const secret = "checkpoint-test-auth-secret-at-least-32-characters";
const DAY = 86_400_000;
const runId = (n: number) => `run_${n.toString(16).padStart(24, "0")}`;
const key = (n = 1, ownerId = "alice"): CheckpointKey => ({ runId: runId(n), ownerId, runnerVersion: "worker-v1" });
const tree: CheckpointTree = {
  baseSha: "d6b7814f2a9c3e058d16f9a7b304c85e2f6179ab",
  headSha: "4a8e91d6f3c027b9e15a682d7f0c439ab6d28e51",
  checkpointSha: "f19d4c7a8b3e620d59a170e6c4b8f2390a5d71ec",
};
const invalidTrees: unknown[] = [undefined, null, [], {}, "not-tree-metadata",
  ...Object.keys(tree).flatMap(pin => [undefined, null, 123, "", "a".repeat(39), "a".repeat(41), "g".repeat(40), `${tree.baseSha}\n`]
    .map(value => ({ ...tree, [pin]: value }))),
];
const bytes = (row: Checkpoint) => row.bundle_size + row.state_size;
let dir: string, db: Store, store: Checkpoints, now: number;
const rows = () => db.prepare("SELECT * FROM run_checkpoints ORDER BY seq").all() as Checkpoint[];
const root = () => join(dir, "checkpoints");
const exists = (path: string) => fs.existsSync(join(root(), path));
const save = (n = 1, state = "supplied-state") => store.save({ ...key(n), tree, bundle: Buffer.from("opaque-not-a-git-bundle"), state });
const seed = (database: Store, n: number, status = "idle", owner = "alice") => database.prepare(`INSERT INTO runs(id,user_id,repo,status,created_at,updated_at,data)
  VALUES(?,?,'org/repo',?,1,1,'{}')`).run(runId(n), owner, status);

beforeEach(() => {
  vi.stubEnv("GOND_AGENT_CHECKPOINT_MAX_MB", "1024");
  vi.stubEnv("GOND_AGENT_CHECKPOINT_RETENTION_DAYS", "7");
  dir = fs.mkdtempSync(join(tmpdir(), "gond-checkpoints-"));
  now = 10 * DAY;
  db = openStore(dir);
  for (let n = 1; n <= 6; n++) seed(db, n);
  store = new Checkpoints(db, dir, secret, { now: () => now });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it("adds the native schema idempotently to an existing database without changing run data", () => {
  const data = join(dir, "legacy");
  fs.mkdirSync(data);
  const old = new Database(join(data, "gond-agent.sqlite"));
  old.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,repo TEXT NOT NULL,status TEXT NOT NULL,
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER,data TEXT NOT NULL)`);
  seed(old, 1);
  old.close();
  const migrated = openStore(data);
  const before = migrated.prepare("SELECT * FROM runs").all();
  const saved = new Checkpoints(migrated, data, secret, { now: () => now }).save({ ...key(), tree, bundle: Buffer.from("raw"), state: "state" });
  migrated.close();
  const reopened = openStore(data);
  try {
    expect(reopened.prepare("SELECT * FROM runs").all()).toEqual(before);
    expect(reopened.prepare("SELECT * FROM run_checkpoints").all()).toEqual([saved]);
    expect(reopened.pragma("foreign_key_check")).toEqual([]);
    reopened.prepare("DELETE FROM runs WHERE id=?").run(runId(1));
    expect(reopened.prepare("SELECT * FROM run_checkpoints").all()).toEqual([]);
  } finally { reopened.close(); }
});

it("round-trips only supplied state, seals it with the auth secret, and stores opaque bundles with private permissions", () => {
  vi.stubEnv("CHECKPOINT_TEST_SECRET", "must-not-be-captured-from-the-api-environment");
  const evidenceKey = "07".repeat(32);
  const state = JSON.stringify({ messages: ["private conversation"], supplied_token: "caller-supplied-only", evidence: { key: evidenceKey } }) + "\n\0opaque runner state\n";
  const bundle = Buffer.from([0, 255, 1, 2, 3]);
  const saved = store.save({ ...key(), tree, bundle, state });
  expect(fs.readFileSync(join(root(), saved.bundle_path))).toEqual(bundle);
  const sealed = fs.readFileSync(join(root(), saved.state_path), "utf8");
  expect(sealed).not.toContain("private conversation");
  expect(sealed).not.toContain(evidenceKey);
  expect(JSON.stringify(rows())).not.toContain(evidenceKey);
  const plaintext = unseal(secret, sealed), split = plaintext.indexOf("\n");
  const envelope = JSON.parse(plaintext.slice(0, split));
  expect(plaintext.slice(split + 1)).toBe(state);
  expect(Object.keys(envelope).sort()).toEqual(["bundle_path", "bundle_sha256", "created_at", "owner_id", "run_id", "runner_version", "tree"]);
  expect(envelope.tree).toEqual(tree);
  expect(envelope.created_at).toBe(saved.created_at);
  expect(plaintext).not.toContain(process.env.CHECKPOINT_TEST_SECRET);
  expect(store.load(key())).toEqual({ checkpoint: saved, bundle, state, tree });
  expect(store.load(key())).not.toBeNull(); // Read does not consume.
  expect(new Checkpoints(db, dir, secret, { now: () => now }).load(key())?.tree).toEqual(tree);
  expect(saved.state_size).toBe(Buffer.byteLength(sealed));
  for (const path of [root(), join(root(), runId(1))]) expect(fs.statSync(path).mode & 0o777).toBe(0o700);
  for (const path of [saved.bundle_path, saved.state_path]) expect(fs.statSync(join(root(), path)).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(join(root(), runId(1))).sort()).toEqual([saved.bundle_path.split("/")[1], saved.state_path.split("/")[1]].sort());
});

it("never captures environment secrets in checkpoint files or sealed metadata", () => {
  const secrets = {
    GH_TOKEN: "ghp_checkpoint_environment_only_1234567890",
    GITHUB_TOKEN: "github_pat_checkpoint_environment_only_1234567890",
    GOND_AGENT_RELAY_TOKEN: "checkpoint-relay-environment-only-1234567890",
    BETTER_AUTH_SECRET: secret,
  };
  for (const [name, value] of Object.entries(secrets)) vi.stubEnv(name, value);
  const saved = save();
  for (const value of Object.values(secrets)) {
    // Search every file, including the unencrypted bundle; no shell expansion
    // or real inherited credentials are involved in this fixture-only probe.
    const grep = spawnSync("grep", ["-r", "-a", "-F", "-q", "--", value, root()]);
    expect(grep.error).toBeUndefined();
    expect(grep.status).toBe(1); // no matches, not a grep failure
    const plaintext = unseal(secret, fs.readFileSync(join(root(), saved.state_path), "utf8"));
    expect(plaintext).not.toContain(value);
    expect(JSON.stringify(rows())).not.toContain(value);
  }
  expect(store.load(key())?.state).toBe("supplied-state");
});

it("requires all three exact SHA-1 pins before writing any checkpoint files or metadata", () => {
  for (const invalid of invalidTrees) {
    expect(() => store.save({ ...key(), tree: invalid as CheckpointTree, bundle: Buffer.from("opaque"), state: "opaque" }))
      .toThrow("Invalid checkpoint data");
  }
  expect(rows()).toEqual([]);
  expect(fs.readdirSync(root())).toEqual([]);
});

it("rejects missing or invalid sealed pins and creation metadata even in authenticated envelopes", () => {
  const saved = save();
  const path = join(root(), saved.state_path);
  const plaintext = unseal(secret, fs.readFileSync(path, "utf8")), split = plaintext.indexOf("\n");
  const envelope = JSON.parse(plaintext.slice(0, split));
  const invalidEnvelopes = [
    ...invalidTrees.map(tree => ({ ...envelope, tree })),
    ...[undefined, null, String(saved.created_at), saved.created_at + 1].map(created_at => ({ ...envelope, created_at })),
  ];
  for (const invalid of invalidEnvelopes) {
    // Re-seal deliberately malformed fixtures so validation, not just encryption, is exercised.
    const sealed = seal(secret, `${JSON.stringify(invalid)}\n${plaintext.slice(split + 1)}`);
    fs.writeFileSync(path, sealed);
    db.prepare("UPDATE run_checkpoints SET state_size=? WHERE seq=?").run(Buffer.byteLength(sealed), saved.seq);
    expect(() => store.load(key())).toThrow("Checkpoint could not be read");
  }
});

it("rejects forged pins and replayed sealed metadata rather than returning untrusted trees", () => {
  const first = save();
  const original = fs.readFileSync(join(root(), first.state_path), "utf8");
  const plaintext = unseal(secret, original);
  const forged = seal("attacker-secret", plaintext.replace(tree.baseSha, tree.headSha));
  fs.writeFileSync(join(root(), first.state_path), forged);
  db.prepare("UPDATE run_checkpoints SET state_size=? WHERE seq=?").run(Buffer.byteLength(forged), first.seq);
  expect(() => store.load(key(), first.seq)).toThrow("Checkpoint could not be read");

  const second = store.save({ ...key(), tree: { ...tree, baseSha: tree.headSha }, bundle: Buffer.from("opaque-not-a-git-bundle"), state: "supplied-state" });
  const replay = fs.readFileSync(join(root(), second.state_path));
  fs.writeFileSync(join(root(), first.state_path), replay);
  db.prepare("UPDATE run_checkpoints SET state_size=? WHERE seq=?").run(replay.length, first.seq);
  expect(() => store.load(key(), first.seq)).toThrow("Checkpoint could not be read");
  expect(store.load(key(), second.seq)?.tree.baseSha).toBe(tree.headSha);
});

it("rejects altered creation timestamps and invalid load sequences", () => {
  const saved = save();
  for (const seq of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => store.load(key(), seq)).toThrow("Invalid checkpoint sequence");
  for (const createdAt of [saved.created_at + 1, saved.created_at + 0.5]) {
    db.prepare("UPDATE run_checkpoints SET created_at=? WHERE seq=?").run(createdAt, saved.seq);
    expect(() => store.load(key())).toThrow("Checkpoint could not be read");
  }
  db.prepare("UPDATE run_checkpoints SET created_at=? WHERE seq=?").run(saved.created_at, saved.seq);
  expect(store.load(key())?.tree).toEqual(tree);
});

it("rejects wrong run, owner, version and unsafe IDs before returning or changing data", () => {
  const saved = save();
  for (const bad of [key(1, "bob"), { ...key(), runId: "../../escape" }, { ...key(), runnerVersion: "worker-v2" }]) {
    expect(() => store.load(bad, saved.seq)).toThrow();
    expect(() => store.consume(bad, saved.seq)).toThrow();
  }
  expect(() => store.load(key(2), saved.seq)).toThrow();
  expect(() => store.consume(key(2), saved.seq)).toThrow();
  expect(() => store.save({ ...key(1, "bob"), tree, bundle: Buffer.from("x"), state: "x" })).toThrow();
  expect(() => store.save({ ...key(), tree, runId: "../escape", bundle: Buffer.from("x"), state: "x" })).toThrow();
  expect(rows()).toEqual([saved]);
  expect(fs.readdirSync(root())).toEqual([runId(1)]);
});

it("authenticates state, bundle contents, and the owner binding even after metadata changes", () => {
  const saved = save();
  const wrongSecret = new Checkpoints(db, dir, "wrong-auth-secret", { now: () => now });
  expect(() => wrongSecret.load(key())).toThrow("Checkpoint could not be read");
  fs.writeFileSync(join(root(), saved.bundle_path), Buffer.alloc(saved.bundle_size, 42));
  expect(() => store.load(key())).toThrow("Checkpoint could not be read");
  fs.writeFileSync(join(root(), saved.bundle_path), Buffer.from("opaque-not-a-git-bundle"));
  const sealed = fs.readFileSync(join(root(), saved.state_path));
  const tampered = Buffer.from(sealed);
  tampered[20] = tampered[20] === 65 ? 66 : 65;
  fs.writeFileSync(join(root(), saved.state_path), tampered);
  expect(() => store.load(key())).toThrow("Checkpoint could not be read");
  fs.writeFileSync(join(root(), saved.state_path), sealed);
  db.prepare("UPDATE runs SET user_id='bob' WHERE id=?").run(runId(1));
  expect(() => store.load(key(1, "bob"))).toThrow("Checkpoint could not be read");
});

it.each(["rename", "database"])("never publishes a partial pair or prunes the previous checkpoints after a %s failure", failure => {
  const first = save(), second = save();
  const originalRename = fs.renameSync;
  const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    expect(rows()).toEqual([first, second]);
    expect(fs.statSync(from).mode & 0o777).toBe(0o600);
    expect(store.load(key(), first.seq)?.state).toBe("supplied-state");
    if (failure === "rename" && String(to).endsWith(".state")) throw new Error("simulated rename failure");
    originalRename(from, to);
  });
  if (failure === "database") db.exec("CREATE TRIGGER fail_checkpoint BEFORE DELETE ON run_checkpoints BEGIN SELECT RAISE(ABORT,'simulated database failure'); END");
  expect(() => save()).toThrow("simulated");
  expect(rename).toHaveBeenCalledTimes(2);
  expect(rows()).toEqual([first, second]);
  expect(fs.readdirSync(join(root(), runId(1))).sort()).toEqual([first, second].flatMap(r => [r.bundle_path.split("/")[1], r.state_path.split("/")[1]]).sort());
});

it("enforces bundle and UTF-8 state caps before writing, accepts the exact boundaries, and rejects items larger than the total quota", () => {
  expect(() => store.save({ ...key(), tree, bundle: Buffer.allocUnsafe(CHECKPOINT_BUNDLE_MAX + 1), state: "" })).toThrow("size limit");
  expect(() => store.save({ ...key(), tree, bundle: Buffer.alloc(0), state: "é".repeat(CHECKPOINT_STATE_MAX / 2 + 1) })).toThrow("size limit");
  expect(rows()).toEqual([]);
  expect(fs.readdirSync(root())).toEqual([]);
  const limited = new Checkpoints(db, dir, secret, { maxBytes: 1, now: () => now });
  expect(() => limited.save({ ...key(), tree, bundle: Buffer.from("x"), state: "x" })).toThrow("storage limit");
  expect(fs.readdirSync(root())).toEqual([]);
  // Control characters must not introduce an accidental JSON-escaping size limit.
  const boundary = store.save({ ...key(), tree, bundle: Buffer.alloc(CHECKPOINT_BUNDLE_MAX), state: "\0".repeat(CHECKPOINT_STATE_MAX) });
  expect(boundary.bundle_size).toBe(CHECKPOINT_BUNDLE_MAX);
  expect(boundary.state_size).toBeGreaterThan(CHECKPOINT_STATE_MAX);
  expect(store.load(key())?.state.length).toBe(CHECKPOINT_STATE_MAX);
});

it("keeps only the last two per run, acknowledges consumption idempotently, and expires by creation time after seven days", () => {
  const first = save();
  now += DAY;
  const second = save();
  now += DAY;
  const third = save();
  expect(rows()).toEqual([second, third]);
  expect(exists(first.bundle_path)).toBe(false);
  expect(exists(first.state_path)).toBe(false);
  store.consume(key(), second.seq);
  const consumedAt = now;
  now += 100;
  store.consume(key(), second.seq);
  expect(rows()[0].consumed_at).toBe(consumedAt);
  expect(() => store.load(key(), second.seq)).toThrow("unavailable");
  expect(store.load(key())?.checkpoint.seq).toBe(third.seq);
  now = second.created_at + 7 * DAY - 1;
  store.cleanup();
  expect(rows()).toHaveLength(2);
  now++;
  store.cleanup();
  expect(rows()).toEqual([third]);
  expect(exists(second.bundle_path)).toBe(false);
  expect(exists(second.state_path)).toBe(false);
  now = third.created_at + 7 * DAY;
  expect(() => store.load(key())).toThrow("unavailable");
  store.cleanup();
  expect(rows()).toEqual([]);
  expect(fs.readdirSync(root())).toEqual([]);
});

it("evicts oldest consumed first across runs, then ordinary unconsumed before interrupted, deleting both files", () => {
  db.prepare("UPDATE runs SET status='interrupted' WHERE id=?").run(runId(1));
  const interrupted = save(1);
  now++;
  const ordinary = save(2);
  now++;
  const consumed = save(3);
  store.consume(key(3), consumed.seq);
  now++;
  const consumedLater = save(4);
  store.consume(key(4), consumedLater.seq);
  expect(bytes(interrupted)).toBe(bytes(consumed));
  store = new Checkpoints(db, dir, secret, { now: () => now, maxBytes: bytes(interrupted) * 3 });
  expect(rows().map(r => r.seq)).toEqual([interrupted.seq, ordinary.seq, consumedLater.seq]);
  expect(exists(consumed.bundle_path)).toBe(false);
  expect(exists(consumed.state_path)).toBe(false);
  const incoming = save(5);
  expect(rows().map(r => r.seq)).toEqual([interrupted.seq, ordinary.seq, incoming.seq]);
  expect(exists(consumedLater.bundle_path)).toBe(false);
  const newest = save(6);
  expect(rows().map(r => r.seq)).toEqual([interrupted.seq, incoming.seq, newest.seq]);
  expect(exists(ordinary.bundle_path)).toBe(false);
  expect(exists(ordinary.state_path)).toBe(false);
  expect(rows().reduce((total, r) => total + bytes(r), 0)).toBeLessThanOrEqual(bytes(interrupted) * 3);
});

it("deletes actual files only for the authorized run, including abandoned temporary files", () => {
  save(1);
  const other = save(2);
  fs.writeFileSync(join(root(), runId(1), "abandoned.tmp"), "partial");
  expect(() => store.deleteRun(runId(1), "bob")).toThrow("unavailable");
  expect(rows()).toHaveLength(2);
  store.deleteRun(runId(1), "alice");
  store.deleteRun(runId(1), "alice");
  expect(rows()).toEqual([other]);
  expect(fs.existsSync(join(root(), runId(1)))).toBe(false);
  expect(store.load(key(2))?.checkpoint).toEqual(other);
  expect(db.prepare("SELECT 1 FROM runs WHERE id=?").get(runId(1))).toBeDefined();
});

it("sweeps startup orphans, half-pairs, deleted-run files and symlinks without following them outside DATA/checkpoints", () => {
  const valid = save(1), half = save(2), deleted = save(3);
  fs.unlinkSync(join(root(), half.state_path));
  db.prepare("DELETE FROM runs WHERE id=?").run(runId(3));
  expect(exists(deleted.bundle_path)).toBe(true); // SQLite alone cannot unlink files.
  fs.writeFileSync(join(root(), runId(1), "crashed.state.tmp"), "partial");
  fs.mkdirSync(join(root(), runId(4)));
  fs.writeFileSync(join(root(), runId(4), "orphan.bundle"), "orphan");
  const outside = join(dir, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, "keep"), "untouched", { mode: 0o644 });
  fs.symlinkSync(outside, join(root(), runId(5)));
  fs.symlinkSync(join(outside, "keep"), join(root(), runId(1), "orphan-link"));
  fs.chmodSync(join(root(), runId(1)), 0o755);
  fs.chmodSync(join(root(), valid.state_path), 0o644);
  store = new Checkpoints(db, dir, secret, { now: () => now });
  expect(rows()).toEqual([valid]);
  expect(store.load(key())?.checkpoint).toEqual(valid);
  expect(fs.readdirSync(root())).toEqual([runId(1)]);
  expect(fs.readdirSync(join(root(), runId(1)))).toHaveLength(2);
  expect(fs.readFileSync(join(outside, "keep"), "utf8")).toBe("untouched");
  expect(fs.statSync(join(outside, "keep")).mode & 0o777).toBe(0o644);
  expect(fs.statSync(join(root(), runId(1))).mode & 0o777).toBe(0o700);
  expect(fs.statSync(join(root(), valid.state_path)).mode & 0o777).toBe(0o600);
});

it("rejects symlinked storage directories and tampered stored paths without touching their targets", () => {
  const saved = save();
  const outside = join(dir, "outside-state");
  fs.writeFileSync(outside, "do-not-touch", { mode: 0o644 });
  db.prepare("UPDATE run_checkpoints SET state_path='../../outside-state' WHERE seq=?").run(saved.seq);
  expect(() => store.load(key())).toThrow("could not be read");
  store.cleanup();
  expect(rows()).toEqual([]);
  expect(fs.readFileSync(outside, "utf8")).toBe("do-not-touch");
  expect(fs.statSync(outside).mode & 0o777).toBe(0o644);
  fs.rmSync(root(), { recursive: true });
  const target = join(dir, "outside-directory");
  fs.mkdirSync(join(target, runId(1)), { recursive: true });
  fs.writeFileSync(join(target, runId(1), "keep"), "untouched");
  fs.symlinkSync(target, root());
  expect(() => new Checkpoints(db, dir, secret)).toThrow("Unsafe checkpoint directory");
  expect(() => store.deleteRun(runId(1), "alice")).toThrow("Unsafe checkpoint directory");
  expect(fs.readFileSync(join(target, runId(1), "keep"), "utf8")).toBe("untouched");
});

it.each(["bundle", "state"] as const)("rejects a FIFO %s without blocking load or startup cleanup", kind => {
  const saved = save();
  // Synchronous FIFO opens block the event loop, so bound the entire probe in a killable child.
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { execFileSync } from "node:child_process";
    import { Checkpoints } from ${JSON.stringify(new URL("../src/checkpoints.ts", import.meta.url).href)};
    import { openStore } from ${JSON.stringify(new URL("../src/db.ts", import.meta.url).href)};
    const dir = ${JSON.stringify(dir)}, secret = ${JSON.stringify(secret)}, now = ${now};
    const db = openStore(dir);
    try {
      const store = new Checkpoints(db, dir, secret, { now: () => now });
      const path = ${JSON.stringify(join(root(), saved[`${kind}_path`]))};
      fs.unlinkSync(path);
      execFileSync("mkfifo", [path], { timeout: 1000 });
      assert(fs.lstatSync(path).isFIFO());
      assert.throws(() => store.load(${JSON.stringify(key())}), { code: "corrupt" });
      new Checkpoints(db, dir, secret, { now: () => now });
      assert.deepEqual(db.prepare("SELECT * FROM run_checkpoints").all(), []);
      assert.deepEqual(fs.readdirSync(${JSON.stringify(root())}), []);
    } finally { db.close(); }
  `], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
}, 10_000);

it.each(["symlink", "hardlink"])("rejects a %s checkpoint file without reading or chmodding its target", kind => {
  const saved = save();
  const path = join(root(), saved.state_path), outside = join(dir, "outside-state");
  fs.copyFileSync(path, outside);
  fs.chmodSync(outside, 0o644);
  const original = fs.readFileSync(outside);
  fs.unlinkSync(path);
  if (kind === "symlink") fs.symlinkSync(outside, path);
  else fs.linkSync(outside, path);
  expect(() => store.load(key())).toThrow("could not be read");
  store.cleanup();
  expect(rows()).toEqual([]);
  expect(fs.readdirSync(root())).toEqual([]);
  expect(fs.readFileSync(outside)).toEqual(original);
  expect(fs.statSync(outside).mode & 0o777).toBe(0o644);
});

describe("checkpoint configuration", () => {
  it("defaults to 1024 MiB total and seven days, and validates explicit configuration", () => {
    expect(checkpointSettings({})).toEqual({ maxBytes: 1024 ** 3, retentionMs: 7 * DAY });
    expect(checkpointSettings({ GOND_AGENT_CHECKPOINT_MAX_MB: "12", GOND_AGENT_CHECKPOINT_RETENTION_DAYS: "2" }))
      .toEqual({ maxBytes: 12 * 1024 ** 2, retentionMs: 2 * DAY });
    for (const value of ["0", "-1", "NaN", "1.5", "1e3", "99999999999999999999"])
      expect(() => checkpointSettings({ GOND_AGENT_CHECKPOINT_MAX_MB: value })).toThrow("Invalid GOND_AGENT_CHECKPOINT_MAX_MB");
    expect(() => checkpointSettings({ GOND_AGENT_CHECKPOINT_RETENTION_DAYS: "0" })).toThrow("Invalid GOND_AGENT_CHECKPOINT_RETENTION_DAYS");
  });
});
