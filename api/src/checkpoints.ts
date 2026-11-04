import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { seal, unseal } from "./auth";
import type { Store } from "./db";

export const CHECKPOINT_BUNDLE_MAX = 64 * 1024 * 1024;
/** Limit on supplied UTF-8 state; encryption overhead counts toward the total quota. */
export const CHECKPOINT_STATE_MAX = 4 * 1024 * 1024;
const RUN_ID = /^run_[a-f0-9]{24}$/;
const SHA1 = /^[a-fA-F0-9]{40}$/;
const SEALED_MAX = CHECKPOINT_STATE_MAX * 2;

export interface CheckpointKey {
  runId: string;
  ownerId: string;
  runnerVersion: string;
}
export interface CheckpointTree {
  baseSha: string;
  headSha: string;
  checkpointSha: string;
}
export interface Checkpoint {
  seq: number;
  run_id: string;
  created_at: number;
  bundle_path: string;
  state_path: string;
  bundle_size: number;
  state_size: number;
  consumed_at: number | null;
  runner_version: string;
  claimed_by?: string | null;
}
interface Envelope {
  run_id: string;
  owner_id: string;
  runner_version: string;
  bundle_path: string;
  bundle_sha256: string;
  created_at: number;
  tree: CheckpointTree;
}
export class CheckpointError extends Error {
  constructor(readonly code: "invalid" | "limit" | "unavailable" | "corrupt", message: string) {
    super(message);
  }
}
const unavailable = () => new CheckpointError("unavailable", "Checkpoint is unavailable.");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const validTree = (value: unknown): value is CheckpointTree => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tree = value as Partial<CheckpointTree>;
  return [tree.baseSha, tree.headSha, tree.checkpointSha].every(sha => typeof sha === "string" && sha.length === 40 && SHA1.test(sha));
};
const treePins = ({ baseSha, headSha, checkpointSha }: CheckpointTree): CheckpointTree => ({ baseSha, headSha, checkpointSha });

export function checkpointSettings(env: NodeJS.ProcessEnv = process.env) {
  const read = (name: string, fallback: number, unit: number) => {
    const raw = env[name] ?? String(fallback), n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n * unit) || n < 1)
      throw new Error(`Invalid ${name}`);
    return n * unit;
  };
  return {
    maxBytes: read("GOND_AGENT_CHECKPOINT_MAX_MB", 1024, 1024 * 1024),
    retentionMs: read("GOND_AGENT_CHECKPOINT_RETENTION_DAYS", 7, 86_400_000),
  };
}

/**
 * API-host storage only: bundles are opaque bytes, never executed, imported or unpacked here.
 * Construct once after openStore, before accepting writers: construction sweeps crash orphans.
 * Call cleanup periodically and deleteRun before deleting a run/account; FK cascades alone
 * remove metadata, not files (the next cleanup/startup sweep reclaims those files).
 * Operations are synchronous and do not yield between authorization and publication.
 */
export class Checkpoints {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(private readonly db: Store, data: string, private readonly secret: string,
    options: { maxBytes?: number; retentionMs?: number; now?: () => number } = {}) {
    const settings = checkpointSettings();
    this.maxBytes = options.maxBytes ?? settings.maxBytes;
    this.retentionMs = options.retentionMs ?? settings.retentionMs;
    this.now = options.now ?? Date.now;
    if (![this.maxBytes, this.retentionMs].every(n => Number.isSafeInteger(n) && n > 0))
      throw new Error("Invalid checkpoint storage limits");
    if (!secret) throw new Error("Checkpoint encryption requires the auth secret");
    this.root = resolve(data, "checkpoints");
    this.directory(this.root);
    this.cleanup();
  }

  /** onPublish joins replay acknowledgement/claim consumption to metadata publication.
   * Call outside any outer transaction: obsolete files are unlinked only after this commit. */
  save(input: CheckpointKey & { bundle: Buffer; state: string; tree: CheckpointTree }, onPublish?: () => void): Checkpoint {
    this.authorize(input);
    if (!Buffer.isBuffer(input.bundle) || typeof input.state !== "string" || !validTree(input.tree))
      throw new CheckpointError("invalid", "Invalid checkpoint data.");
    if (input.bundle.length > CHECKPOINT_BUNDLE_MAX || Buffer.byteLength(input.state) > CHECKPOINT_STATE_MAX)
      throw new CheckpointError("limit", "Checkpoint exceeds the size limit.");
    const createdAt = this.now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0)
      throw new CheckpointError("invalid", "Invalid checkpoint creation time.");
    const name = randomBytes(16).toString("hex");
    const bundlePath = `${input.runId}/${name}.bundle`, statePath = `${input.runId}/${name}.state`;
    const envelope: Envelope = { run_id: input.runId, owner_id: input.ownerId, runner_version: input.runnerVersion,
      bundle_path: bundlePath, bundle_sha256: digest(input.bundle), created_at: createdAt, tree: treePins(input.tree) };
    // A one-line binding header avoids JSON-escaping (and expanding) the opaque UTF-8 state.
    const sealed = Buffer.from(seal(this.secret, `${JSON.stringify(envelope)}\n${input.state}`));
    if (sealed.length > SEALED_MAX || input.bundle.length + sealed.length > this.maxBytes)
      throw new CheckpointError("limit", "Checkpoint exceeds the storage limit.");
    const dir = join(this.root, input.runId);
    this.directory(dir);
    let published = false;
    try {
      this.atomicWrite(join(this.root, bundlePath), input.bundle);
      this.atomicWrite(join(this.root, statePath), sealed);
      this.syncDirectory(dir);
      this.syncDirectory(this.root);
      const { row, removed } = this.db.transaction(() => {
        this.authorize(input);
        onPublish?.();
        const row = this.db.prepare(`INSERT INTO run_checkpoints(run_id,created_at,bundle_path,state_path,bundle_size,state_size,runner_version)
          VALUES(?,?,?,?,?,?,?) RETURNING *`).get(input.runId, createdAt, bundlePath, statePath, input.bundle.length, sealed.length, input.runnerVersion) as Checkpoint;
        return { row, removed: this.prune(row.seq) };
      }).immediate();
      published = true;
      // Metadata commits before unlinking old files. A crash here leaves only reclaimable orphans.
      for (const old of removed) this.removeFiles(old);
      return row;
    } finally {
      if (!published) {
        fs.rmSync(join(this.root, bundlePath), { force: true });
        fs.rmSync(join(this.root, statePath), { force: true });
        this.removeEmptyDirectory(dir);
      }
    }
  }

  /** Latest unconsumed checkpoint by default, including claimed ones for inspection. */
  load(key: CheckpointKey, seq?: number): { checkpoint: Checkpoint; bundle: Buffer; state: string; tree: CheckpointTree } | null {
    this.authorize(key);
    if (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 1))
      throw new CheckpointError("invalid", "Invalid checkpoint sequence.");
    const row = seq === undefined
      ? this.db.prepare("SELECT * FROM run_checkpoints WHERE run_id=? AND consumed_at IS NULL ORDER BY seq DESC LIMIT 1").get(key.runId) as Checkpoint | undefined
      : this.db.prepare("SELECT * FROM run_checkpoints WHERE run_id=? AND seq=?").get(key.runId, seq) as Checkpoint | undefined;
    if (!row && seq === undefined) return null;
    if (!row || row.consumed_at !== null || row.runner_version !== key.runnerVersion || row.created_at <= this.now() - this.retentionMs)
      throw unavailable();
    try {
      if (row.run_id !== key.runId || !Number.isSafeInteger(row.seq) || row.seq < 1 ||
          !Number.isSafeInteger(row.created_at) || row.created_at < 0)
        throw new Error("Invalid checkpoint metadata");
      const bundle = this.readFile(row, "bundle");
      const sealed = this.readFile(row, "state");
      const plaintext = unseal(this.secret, sealed.toString("utf8"));
      const split = plaintext.indexOf("\n");
      if (split < 0) throw new Error("Invalid checkpoint state");
      const value = JSON.parse(plaintext.slice(0, split)) as Envelope, state = plaintext.slice(split + 1);
      if (value.run_id !== key.runId || value.owner_id !== key.ownerId || value.runner_version !== key.runnerVersion ||
          value.bundle_path !== row.bundle_path || value.bundle_sha256 !== digest(bundle) ||
          value.created_at !== row.created_at || !validTree(value.tree) || Buffer.byteLength(state) > CHECKPOINT_STATE_MAX)
        throw new Error("Invalid checkpoint binding");
      return { checkpoint: row, bundle, state, tree: treePins(value.tree) };
    } catch {
      throw new CheckpointError("corrupt", "Checkpoint could not be read.");
    }
  }

  /** Validate and exclusively claim the latest checkpoint, never an older fallback. */
  claim(key: CheckpointKey): (NonNullable<ReturnType<Checkpoints["load"]>> & { claimToken: string }) | null {
    return this.db.transaction(() => {
      this.authorize(key);
      const latest = this.db.prepare("SELECT * FROM run_checkpoints WHERE run_id=? ORDER BY seq DESC LIMIT 1")
        .get(key.runId) as Checkpoint | undefined;
      if (!latest || latest.consumed_at !== null || latest.claimed_by != null) return null;
      const loaded = this.load(key, latest.seq)!;
      const claimToken = randomBytes(32).toString("hex");
      if (!this.db.prepare(`UPDATE run_checkpoints SET claimed_by=?
        WHERE run_id=? AND seq=? AND runner_version=? AND consumed_at IS NULL AND claimed_by IS NULL`)
        .run(claimToken, key.runId, loaded.checkpoint.seq, key.runnerVersion).changes) return null;
      return { ...loaded, checkpoint: { ...loaded.checkpoint, claimed_by: claimToken }, claimToken };
    }).immediate();
  }

  /** Release a failed restore. A stale token cannot release a newer attempt's claim. */
  release(key: CheckpointKey, seq: number, claimToken: string): void {
    this.authorize(key);
    if (!this.db.prepare(`UPDATE run_checkpoints SET claimed_by=NULL
      WHERE run_id=? AND seq=? AND runner_version=? AND consumed_at IS NULL AND claimed_by=?`)
      .run(key.runId, seq, key.runnerVersion, claimToken).changes) throw unavailable();
  }

  /** Acknowledge successful restore only for the current claim. Idempotent for that token. */
  consumeClaim(key: CheckpointKey, seq: number, claimToken: string): void {
    this.authorize(key);
    if (!this.db.prepare(`UPDATE run_checkpoints SET consumed_at=coalesce(consumed_at,?)
      WHERE run_id=? AND seq=? AND runner_version=? AND claimed_by=?`)
      .run(this.now(), key.runId, seq, key.runnerVersion, claimToken).changes) throw unavailable();
  }

  /** Service recovery only, after disposable workers have been cleaned up; never on construction. */
  resetClaims(): void {
    this.db.prepare("UPDATE run_checkpoints SET claimed_by=NULL WHERE claimed_by IS NOT NULL").run();
  }

  /** Caller acknowledges a successful restore, not merely a successful read. Idempotent. */
  consume(key: CheckpointKey, seq: number): void {
    this.authorize(key);
    if (!this.db.prepare(`UPDATE run_checkpoints SET consumed_at=coalesce(consumed_at,?)
      WHERE run_id=? AND seq=? AND runner_version=? AND claimed_by IS NULL`).run(this.now(), key.runId, seq, key.runnerVersion).changes)
      throw unavailable();
  }

  deleteRun(runId: string, ownerId: string): void {
    this.authorizeOwner(runId, ownerId);
    const rows = this.db.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM run_checkpoints WHERE run_id=?").all(runId) as Checkpoint[];
      this.db.prepare("DELETE FROM run_checkpoints WHERE run_id=?").run(runId);
      return rows;
    }).immediate();
    for (const row of rows) this.removeFiles(row);
    // Includes abandoned temporary files, without following a symlink outside the store.
    fs.rmSync(join(this.root, runId), { recursive: true, force: true });
  }

  /** Retention/quota cleanup plus actual orphan-file deletion, also run at startup. */
  cleanup(): void {
    this.directory(this.root);
    for (const row of this.db.transaction(() => this.prune()).immediate()) this.removeFiles(row);
    const rows = this.db.prepare("SELECT * FROM run_checkpoints").all() as Checkpoint[];
    const live = new Set<string>();
    for (const row of rows) {
      try {
        // Check regular files and recorded sizes without decrypting state or parsing bundles.
        for (const kind of ["bundle", "state"] as const) {
          const fd = this.openFile(row, kind);
          fs.closeSync(fd);
        }
        live.add(row.bundle_path);
        live.add(row.state_path);
      } catch {
        this.db.prepare("DELETE FROM run_checkpoints WHERE seq=?").run(row.seq);
      }
    }
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      const dir = join(this.root, entry.name);
      if (!RUN_ID.test(entry.name) || !entry.isDirectory()) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      for (const file of fs.readdirSync(dir)) {
        if (!live.has(`${entry.name}/${file}`)) fs.rmSync(join(dir, file), { recursive: true, force: true });
      }
      this.removeEmptyDirectory(dir);
    }
  }

  private authorize(key: CheckpointKey) {
    this.authorizeOwner(key.runId, key.ownerId);
    if (typeof key.runnerVersion !== "string" || !key.runnerVersion.length || key.runnerVersion.length > 128)
      throw new CheckpointError("invalid", "Invalid checkpoint version.");
  }
  private authorizeOwner(runId: string, ownerId: string) {
    if (!RUN_ID.test(runId) || !this.db.prepare("SELECT 1 FROM runs WHERE id=? AND user_id=? AND deleted_at IS NULL").get(runId, ownerId))
      throw unavailable();
    this.directory(this.root);
  }
  private directory(path: string) {
    fs.mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe checkpoint directory");
    fs.chmodSync(path, 0o700);
  }
  private syncDirectory(path: string) {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  private atomicWrite(path: string, bytes: Buffer) {
    const temp = `${path}.tmp`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, path);
    } finally { fs.rmSync(temp, { force: true }); }
  }
  private validPaths(row: Checkpoint) {
    return RUN_ID.test(row.run_id) &&
      new RegExp(`^${row.run_id}/[a-f0-9]{32}\\.bundle$`).test(row.bundle_path) &&
      row.state_path === row.bundle_path.replace(/\.bundle$/, ".state");
  }
  private openFile(row: Checkpoint, kind: "bundle" | "state") {
    if (!this.validPaths(row)) throw new Error("Unsafe checkpoint path");
    const dir = join(this.root, row.run_id);
    if (!fs.lstatSync(dir).isDirectory()) throw new Error("Unsafe checkpoint directory");
    fs.chmodSync(dir, 0o700);
    const fd = fs.openSync(join(this.root, row[`${kind}_path`]), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd), size = row[`${kind}_size`];
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== size || size < 0 || size > (kind === "bundle" ? CHECKPOINT_BUNDLE_MAX : SEALED_MAX))
        throw new Error("Invalid checkpoint file");
      fs.fchmodSync(fd, 0o600);
      return fd;
    } catch (error) { fs.closeSync(fd); throw error; }
  }
  private readFile(row: Checkpoint, kind: "bundle" | "state") {
    const fd = this.openFile(row, kind);
    try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
  }
  private removeFiles(row: Checkpoint) {
    // Never trust stored paths for deletion: only exact generated names inside a real run dir.
    if (!this.validPaths(row)) return;
    const dir = join(this.root, row.run_id);
    if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) return;
    fs.rmSync(join(this.root, row.bundle_path), { recursive: true, force: true });
    fs.rmSync(join(this.root, row.state_path), { recursive: true, force: true });
    this.removeEmptyDirectory(dir);
  }
  private removeEmptyDirectory(dir: string) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
  private prune(protectedSeq?: number): Checkpoint[] {
    const rows = this.db.prepare(`SELECT c.*,r.status,r.deleted_at FROM run_checkpoints c JOIN runs r ON r.id=c.run_id
      ORDER BY c.seq DESC`).all() as (Checkpoint & { status: string; deleted_at: number | null })[];
    const removed = new Set<Checkpoint>();
    const counts = new Map<string, number>();
    let total = 0;
    for (const row of rows) {
      const count = (counts.get(row.run_id) ?? 0) + 1;
      counts.set(row.run_id, count);
      if (row.seq !== protectedSeq && !(row.claimed_by && row.consumed_at === null) && (count > 2 || row.deleted_at !== null || row.created_at <= this.now() - this.retentionMs)) removed.add(row);
      else total += row.bundle_size + row.state_size;
    }
    // Oldest consumed first, then ordinary unconsumed, interrupted unconsumed last.
    const priority = (row: typeof rows[number]) => row.consumed_at !== null ? 0 : row.status === "interrupted" ? 2 : 1;
    for (const row of [...rows].sort((a, b) => priority(a) - priority(b) || a.created_at - b.created_at || a.seq - b.seq)) {
      if (total <= this.maxBytes) break;
      if (removed.has(row) || row.seq === protectedSeq || (row.claimed_by && row.consumed_at === null)) continue;
      removed.add(row);
      total -= row.bundle_size + row.state_size;
    }
    if (protectedSeq !== undefined && total > this.maxBytes)
      throw new CheckpointError("limit", "Checkpoint storage is busy. Try again after the current restore.");
    for (const row of removed) this.db.prepare("DELETE FROM run_checkpoints WHERE seq=?").run(row.seq);
    return [...removed];
  }
}
