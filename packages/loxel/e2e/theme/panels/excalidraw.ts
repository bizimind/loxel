import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { $ } from "bun";

import type { PanelShot } from "../lib";

/**
 * docs/architecture.excalidraw in the Excalidraw panel. Loxel rewrites a drawing when it opens it
 * (normalized elements, `source: "loxel"`), which would dirty the shared fixture and change every
 * other shot's "N modified" badge, so a fresh copy of the committed file outside the repo is opened
 * instead (it shows under the sidebar's Others section).
 */
const shot: PanelShot = {
  description:
    "Excalidraw drawing panel with an architecture diagram: the canvas with three colored hand-drawn boxes and labels, one box selected with its handles and the shape properties panel (stroke/background swatches, fill, stroke width, opacity, layers), the Excalidraw shape toolbar, the hamburger menu, Library button, zoom and undo/redo controls and help button inside the Loxel tab",
  run: async (ctx) => {
    const assets = resolve(ctx.fixture, "../../assets");
    mkdirSync(assets, { recursive: true });
    const copy = resolve(assets, "architecture.excalidraw");
    await $`git show HEAD:docs/architecture.excalidraw > ${copy}`.cwd(ctx.fixture).quiet();
    await ctx.open(copy);
    const canvas = ctx.page.locator(".excalidraw:visible canvas").first();
    await canvas.waitFor({ state: "visible" });
    await ctx.page
      .locator(".excalidraw:visible .App-toolbar")
      .first()
      .waitFor({ state: "visible" });
    await ctx.settle();
    // A previous shot's window can still flush its save of this copy after the copy above was
    // rewritten, which this window then sees as an external change. That is a staging race, not
    // the state this panel shows: take the disk version (the same drawing) so the banner goes.
    const acceptDisk = ctx.page.getByRole("button", { name: "Accept disk version" });
    if (await acceptDisk.isVisible()) {
      await acceptDisk.click();
      await acceptDisk.waitFor({ state: "hidden" });
      await ctx.settle();
    }
    // Select the "Catalog API" box so the selection handles and the shape properties panel show.
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas has no box");
    await ctx.page.mouse.click(box.x + 540, box.y + 175);
    await ctx.page
      .locator(".excalidraw:visible .App-menu__left")
      .first()
      .waitFor({ state: "visible" });
    await ctx.settle();
  },
};
export default shot;
