import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PanelShot } from "../lib";

/** A partly transparent badge, so the viewer's checkerboard shows around and through it. */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6366f1"/>
      <stop offset="1" stop-color="#ec4899"/>
    </linearGradient>
  </defs>
  <rect x="40" y="40" width="400" height="240" rx="36" fill="url(#g)"/>
  <circle cx="150" cy="160" r="70" fill="#ffffff" fill-opacity="0.35"/>
  <circle cx="330" cy="160" r="70" fill="none" stroke="#ffffff" stroke-width="14"/>
  <rect x="200" y="20" width="80" height="280" fill="#facc15" fill-opacity="0.5"/>
  <text x="240" y="300" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="700" fill="#111827" text-anchor="middle">orbit-shop</text>
</svg>
`;

/**
 * The media viewer with an SVG. It is written outside the repo (the fixture is read-only), which
 * Loxel opens like any file and lists under the sidebar's Others section.
 */
const shot: PanelShot = {
  description:
    "Media viewer showing a partly transparent SVG badge on the transparency checkerboard, with the viewer toolbar (file name, zoom out/in, zoom percentage, fit to panel, actual size, auto-fit toggle)",
  run: async (ctx) => {
    const assets = resolve(ctx.fixture, "../../assets");
    mkdirSync(assets, { recursive: true });
    const file = resolve(assets, "badge.svg");
    writeFileSync(file, SVG);
    await ctx.open(file);
    await ctx.page.locator('[title="Fit to panel (0)"]:visible').first().waitFor();
    const frame = ctx.page.frameLocator("iframe:visible").first();
    await frame.locator("svg").first().waitFor({ state: "visible" });
    await ctx.settle();
  },
};
export default shot;
