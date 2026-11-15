import type { APIRoute } from "astro";
import sharp from "sharp";

import faviconSvg from "../../public/favicon.svg?raw";

// Home-screen icon for iOS and others that don't take SVG icons, rendered from the favicon at build time.
const SIZE = 180;
// The SVG is 100 units wide and renders at 100px at sharp's default 72 DPI; rasterize at twice the
// target size and downscale for smooth edges.
const DENSITY = 72 * (SIZE / 100) * 2;

export const GET: APIRoute = async () => {
  const png = await sharp(Buffer.from(faviconSvg), { density: DENSITY })
    .resize(SIZE, SIZE)
    .png()
    .toBuffer();
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
};
