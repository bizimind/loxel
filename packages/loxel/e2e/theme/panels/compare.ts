import type { PanelShot } from "../lib";
import { widenLeftDock } from "./_dock";

/** Compare Files: src/catalog.ts against src/search.ts, started from the Project Files menu. */
const shot: PanelShot = {
  description:
    "Compare Files view: src/catalog.ts (left) against src/search.ts (right) side by side, both editable, with added/removed lines, intra-line highlights and the diff gutter, plus the Project Files tree on the left",
  run: async (ctx) => {
    const { page } = ctx;
    await ctx.open("src/catalog.ts");
    await page.locator('[title="Project Files"]').first().click();
    const tree = page.locator(".dv-groupview:visible", { hasText: "package.json" }).first();
    await tree.waitFor({ state: "visible" });
    await widenLeftDock(page, 320);
    const search = tree.getByText("search.ts", { exact: true });
    // Expand src/ unless the tree already revealed the open file.
    if (!(await search.first().isVisible())) {
      await tree.getByText("src", { exact: true }).first().click();
      await search.first().waitFor({ state: "visible" });
    }
    // The file focused in the tree is the left side of the comparison, the right-clicked one the right.
    await tree.getByText("catalog.ts", { exact: true }).first().click();
    await search.first().click({ button: "right" });
    await page.getByText("Compare Files", { exact: false }).first().click();
    await page
      .locator(".monaco-editor:visible .view-line", { hasText: "needle" })
      .first()
      .waitFor({ state: "visible" });
    await ctx.settle();
  },
};
export default shot;
