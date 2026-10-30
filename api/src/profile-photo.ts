import sharp from "sharp";
import { randomBytes } from "node:crypto";
import type { Store } from "./db";
import { ApiError } from "./wire";

export function photoFor(db: Store, user: { id: string; image?: string | null }) {
  const row = db.prepare("SELECT revision FROM profile_photos WHERE user_id=?").get(user.id) as { revision: string } | undefined;
  return { image: row ? `/api/v1/users/${encodeURIComponent(user.id)}/photo?v=${row.revision}` : user.image ?? null, has_photo: !!row };
}

export async function savePhoto(db: Store, user: string, input: Buffer) {
  if (!input.length || input.length > 2 * 1024 * 1024) throw new ApiError(400, "photo_size", "Choose a photo under 2 MiB.");
  let bytes: Buffer;
  try {
    const image = sharp(input, { limitInputPixels: 16_000_000, animated: false }).timeout({ seconds: 5 });
    const metadata = await image.metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format ?? "")) throw new Error("Unsupported format");
    bytes = await image.rotate().resize(256, 256, { fit: "cover" }).ensureAlpha()
      .composite([{ input: Buffer.from('<svg width="256" height="256"><circle cx="128" cy="128" r="128" fill="white"/></svg>'), blend: "dest-in" }])
      .png().toBuffer();
  } catch {
    throw new ApiError(400, "invalid_photo", "Choose a valid PNG, JPEG or WebP photo up to 16 megapixels.");
  }
  db.prepare("INSERT INTO profile_photos(user_id,revision,bytes) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,bytes=excluded.bytes")
    .run(user, randomBytes(12).toString("hex"), bytes);
}
