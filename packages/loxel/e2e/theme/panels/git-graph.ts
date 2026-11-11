import type { Page } from "@playwright/test";

import type { PanelShot } from "../lib";

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 5 });
  await page.mouse.up();
}

/** Git panel: branches list, commit graph with a merge and labels, a selected commit's files. */
const shot: PanelShot = {
  description:
    "Git panel (bottom, enlarged): branches list, commit graph with the merged feature/search branch, HEAD/main/feature/search branch and v1.4.0 tag labels, an uncommitted-changes row, and the selected feat(search) commit; its changed files are listed in the Changes panel (left) and one file's diff is open in the center",
  run: async (ctx) => {
    const { page } = ctx;
    await page.locator('[title="Git"]').first().click();
    const merge = page.getByText("Merge branch 'feature/search'").first();
    await merge.waitFor({ state: "visible" });
    const gitGroup = page.locator(".dv-groupview", {
      has: page.locator('[title="Hide branches"]'),
    });
    // The bottom zone opens short; drag the sash above it up so the graph has room.
    const box = await gitGroup.first().boundingBox();
    if (box) await drag(page, [box.x + box.width / 2, box.y - 1], [box.x + box.width / 2, 520]);
    // The branches column inside the Git panel starts at zero width when the panel first opens;
    // hiding and showing it again restores its default width (and leaves the setting as it was).
    // The zero-width Hide button can't take a pointer click, so dispatch one.
    await page.locator('[title="Hide branches"]').first().dispatchEvent("click");
    await page.locator('[title="Show branches"]').first().dispatchEvent("click");
    await page.locator('[title="Hide branches"]').first().waitFor({ state: "attached" });
    // It comes back at its collapsed width; drag its sash out to a readable width.
    const sash = await gitGroup.first().locator(".dv-sash").first().boundingBox();
    if (sash) {
      const y = sash.y + sash.height / 2;
      await drag(page, [sash.x + sash.width / 2, y], [330, y]);
    }
    await page.locator('[title="Hide branches"]').first().waitFor({ state: "visible" });
    await page.getByText("feat(search): substring product search").first().click();
    await ctx.settle();
    // Show the selected commit's files and open one of them.
    await page.locator('[title="Changes"]').first().click();
    const file = page.locator('[data-tree-path="src/search.ts"]').first();
    await file.waitFor({ state: "visible" });
    const left = await page.locator(".dv-groupview", { has: file }).first().boundingBox();
    if (left) {
      const y = left.y + left.height / 2;
      await drag(page, [left.x + left.width + 1, y], [left.x + 280, y]);
    }
    await file.dblclick();
    await page.locator(".monaco-editor .view-lines").first().waitFor({ state: "visible" });
    await page.mouse.move(1000, 700);
    await ctx.settle();
  },
};
export default shot;
