// Convert public/og-image.source.webp → public/og-image.png (1200×630)
// Run whenever the source art changes: `node scripts/render-og.mjs`
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = join(here, "..", "public", "og-image.source.webp");
const outPath = join(here, "..", "public", "og-image.png");

const png = await sharp(srcPath)
  .resize(1200, 630, { fit: "cover", position: "center" })
  .png({ compressionLevel: 9 })
  .toBuffer();

await writeFile(outPath, png);
console.log(`wrote ${outPath} — ${png.length} bytes`);
