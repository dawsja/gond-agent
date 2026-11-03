import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { MARK_SVG } from "../../shared/brand-mark";

const check = process.argv.includes("--check");
const assets = new Map<string, Buffer>([["favicon.svg", Buffer.from(MARK_SVG)]]);
const sizes = [16, 32, 48, 180, 192, 512];
for (const size of sizes) {
  assets.set(size === 180 ? "apple-touch-icon.png" : `favicon-${size}.png`,
    await sharp(Buffer.from(MARK_SVG)).resize(size, size).png().toBuffer());
}

// ICO directory entries can contain PNG payloads, preserving alpha at every size.
const iconSizes = [16, 32, 48];
const header = Buffer.alloc(6 + 16 * iconSizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(iconSizes.length, 4);
let offset = header.length;
const images = iconSizes.map((size, i) => {
  const image = assets.get(`favicon-${size}.png`)!;
  const entry = 6 + 16 * i;
  header[entry] = header[entry + 1] = size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.length;
  return image;
});
assets.set("favicon.ico", Buffer.concat([header, ...images]));

for (const [name, bytes] of assets) {
  const target = new URL(`../../web/public/${name}`, import.meta.url);
  if (check) {
    if (!bytes.equals(await readFile(target))) throw new Error(`web/public/${name} is stale; run npm run brand:build`);
  } else {
    await writeFile(target, bytes);
  }
}
console.log(`${check ? "Verified" : "Generated"} ${assets.size} Logo C assets (SVG, PNG ${sizes.join("/")}, ICO 16/32/48)`);
