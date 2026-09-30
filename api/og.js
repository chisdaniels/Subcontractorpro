// Vercel Node.js serverless function that turns public/og-image.svg into
// a 1200×630 PNG so social preview clients (iMessage, WhatsApp, etc.)
// that don't render SVG can still show the branded card.

import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

let cachedPng = null;

export default async function handler(req, res) {
  try {
    if (!cachedPng) {
      const svgPath = join(process.cwd(), "public", "og-image.svg");
      const svg = await readFile(svgPath);
      cachedPng = await sharp(svg, { density: 300 })
        .resize(1200, 630)
        .png()
        .toBuffer();
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).send(cachedPng);
  } catch (err) {
    console.error("og render failed:", err);
    res.status(500).json({ error: String(err) });
  }
}
