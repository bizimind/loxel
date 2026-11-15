import type { PanelShot } from "../lib";

/** Changes panel listing the fixture's uncommitted changes, with the modified file's diff open. */
const shot: PanelShot = {
  description:
    "Changes panel (left) listing uncommitted changes (modified src/server.ts, untracked src/cart.ts, deleted scripts/report.py) with +/- counts, src/server.ts selected and its diff open in the center diff viewer",
  run: async (ctx) => {
    const { page } = ctx;
    await page.locator('[title="Changes"]').first().click();
    const row = page.locator('[data-tree-path="src/server.ts"]').first();
    await row.waitFor({ state: "visible" });
    await page
      .locator('[data-tree-path="scripts/report.py"]')
      .first()
      .waitFor({ state: "visible" });
    // The left zone opens narrow; widen it by dragging the sash between it and the center.
    const box = await page.locator(".dv-groupview", { has: row }).first().boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width + 1, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 300, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
    }
    await row.dblclick();
    await page.locator(".monaco-editor .view-lines").first().waitFor({ state: "visible" });
    await page.mouse.move(800, 990);
    await ctx.settle();
  },
};
export default shot;
