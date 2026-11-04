import { randomBytes } from "node:crypto";
import type { Store } from "../db";

// Mirror runner/src/tools/share_image.rs. Durable limits are derived from saved
// transcript events, not worker/checkpoint state, so fallback cannot reset them.
export const MAX_SHARED_PER_TURN = 4;
export const MAX_SHARED_PER_RUN = 32;
export const MAX_SHARED_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 1024 * 1024;

export function storeSharedImage(db: Store, runId: string, ownerId: string, input: Record<string, unknown>) {
  const image = input.image as { media_type?: unknown; data?: unknown } | undefined;
  if (input.agent_id !== "main" || !image || !["image/jpeg", "image/png"].includes(String(image.media_type)) ||
      typeof image.data !== "string" || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      (input.caption !== undefined && (typeof input.caption !== "string" || [...input.caption].length > 1000))) return;
  const bytes = Buffer.from(image.data, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== image.data) return;
  const usage = db.prepare(`SELECT count(*) AS count, coalesce(sum(length(i.bytes)),0) AS bytes,
    coalesce(sum(e.seq > coalesce((SELECT max(seq) FROM events WHERE run_id=? AND json_extract(data,'$.type')='turn.start' AND json_extract(data,'$.agent_id')='main'),0)),0) AS turn
    FROM events e JOIN images i ON i.id=json_extract(e.data,'$.image_id') AND i.run_id=e.run_id
    WHERE e.run_id=? AND json_extract(e.data,'$.type')='image.shared'`).get(runId, runId) as { count: number; bytes: number; turn: number };
  if (usage.count >= MAX_SHARED_PER_RUN || usage.turn >= MAX_SHARED_PER_TURN || usage.bytes + bytes.length > MAX_SHARED_BYTES) {
    return { type: "image.share_rejected", agent_id: "main" };
  }
  const imageId = `img_${randomBytes(16).toString("hex")}`;
  db.prepare("INSERT INTO images(id,user_id,run_id,media_type,bytes,created_at) VALUES(?,?,?,?,?,?)")
    .run(imageId, ownerId, runId, image.media_type, bytes, Date.now());
  return { type: "image.shared", agent_id: "main", image_id: imageId, media_type: image.media_type,
    caption: typeof input.caption === "string" ? input.caption.replace(/[\u0000-\u001f\u007f]/g, "") : "" };
}
