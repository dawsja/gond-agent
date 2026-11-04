// Runtime bridge for containers/smoke-share-image.py; uses production storage/fold.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/db";
import { Runs } from "../../src/runs/service";
import { createTranscript } from "../../../web/src/features/run/transcript";
import type { Config } from "../../src/config";
import sharp from "sharp";
const dir = mkdtempSync(join(tmpdir(), "gond-share-store-"));
const db = openStore(dir);
const config: Config = { data: dir, secret: "share-image-runtime-fixture-only".repeat(2), origin: "http://localhost:8787", signup: false,
  port: 8787, dockerBin: "docker", workerImage: "unused", maxRuns: 1, runCPUs: 1, runMemoryMB: 2048 };
const runs = new Runs(db, config, async () => { throw new Error("No container needed"); });
try {
  db.prepare("INSERT INTO runs(id,user_id,repo,status,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?)")
    .run("fixture", "owner", "a/b", "ready", 1, 1, JSON.stringify({ id: "fixture", user_id: "owner", status: "ready" }));
  const events = JSON.parse(readFileSync(process.argv[2], "utf8"));
  for (const event of events) runs.append("fixture", event);
  const stored = runs.history("fixture", 0);
  const transcript = createTranscript()(stored);
  const item = transcript.items.find(i => i.kind === "shared-image");
  assert.ok(item && item.kind === "shared-image");
  assert.equal(item.caption, "Desktop pagination");
  assert.match(item.imageId, /^img_/);
  assert.ok(!JSON.stringify(stored).includes('"data":'));
  const blob = db.prepare("SELECT user_id,run_id,media_type,bytes FROM images WHERE id=?").get(item.imageId) as { user_id: string; run_id: string; media_type: string; bytes: Buffer };
  assert.equal(blob.user_id, "owner"); assert.equal(blob.run_id, "fixture");
  const metadata = await sharp(blob.bytes).metadata();
  assert.equal(metadata.width, 1568); assert.equal(metadata.height, 980);
  assert.equal(metadata.format, "jpeg"); assert.equal(metadata.exif, undefined);
  assert.ok(blob.bytes.length > 0 && blob.bytes.length <= 1024 * 1024);
  console.log(`share_image: ${metadata.width}x${metadata.height}, ${blob.bytes.length} bytes, ${blob.media_type}`);
  console.log(`transcript fold: shared-image, caption=${JSON.stringify(item.caption)}, owner-scoped stored image, no inline bytes`);
} finally {
  await runs.shutdown(); db.close(); rmSync(dir, { recursive: true, force: true });
}
