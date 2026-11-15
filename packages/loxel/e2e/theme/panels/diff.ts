import type { PanelShot } from "../lib";
import { widenLeftDock } from "./_dock";

/** The diff viewer for the uncommitted change to src/server.ts, opened from the Changes panel. */
const shot: PanelShot = {
  description:
    "Git diff viewer, side by side, for the modified src/server.ts: removed and added lines, intra-line change highlights, the diff gutter and line numbers, with the Changes panel (changed-file tree with +/- counts) on the left",
  run: async (ctx) => {
    const { page } = ctx;
    await page.locator('[title="Changes"]').first().click();
    const row = page.locator("button", { has: page.getByText("server.ts", { exact: true }) });
    await row.first().waitFor({ state: "visible" });
    await widenLeftDock(page, 320);
    // Double-click selects the file and opens the diff viewer.
    await row.first().dblclick();
    await page
      .locator(".monaco-editor:visible .view-line", { hasText: "Nebula Mug" })
      .first()
      .waitFor({ state: "visible" });
    await ctx.settle();
  },
};
export default shot;
