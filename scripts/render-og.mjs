// Pre-render public/og-image.svg → public/og-image.png using local fonts.
// Run whenever the SVG changes: `node scripts/render-og.mjs`
import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = join(here, "..", "public", "og-image.svg");
const outPath = join(here, "..", "public", "og-image.png");

const svg = await readFile(svgPath);
const png = await sharp(svg, { density: 300 })
  .resize(1200, 630)
  .png({ compressionLevel: 9 })
  .toBuffer();

await writeFile(outPath, png);
console.log(`wrote ${outPath} — ${png.length} bytes`);
