import type { PanelShot } from "../lib";

/** Project Files tree with expanded folders, git status colors, a selected row and an open file. */
const shot: PanelShot = {
  description:
    "Project Files panel (left): file tree expanded with git status colors (modified, untracked, deleted), a selected row, and src/server.ts open in the code editor beside it",
  run: async (ctx) => {
    const { page, fixture } = ctx;
    // Tree rows carry absolute paths.
    const row = (rel: string) => page.locator(`[data-tree-path="${fixture}/${rel}"]`).first();
    await page.locator('[title="Project Files"]').first().click();
    await row("src").waitFor({ state: "visible" });
    // The left zone opens narrow; widen it by dragging the sash between it and the center.
    const panel = page.locator(".dv-groupview", { has: row("src") }).first();
    const box = await panel.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width + 1, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 300, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
    }
    for (const dir of ["config", "docs", "scripts", "src"]) {
      if ((await row(dir).getAttribute("data-tree-expanded")) === null) await row(dir).click();
    }
    await row("src/cart.ts").waitFor({ state: "visible" });
    await row("docs/plan.md").waitFor({ state: "visible" });
    await ctx.open("src/server.ts");
    await page.locator(".monaco-editor .view-lines").first().waitFor({ state: "visible" });
    // Select a different row than the active file so both states show.
    await row("src/catalog.ts").click();
    await page.mouse.move(800, 990);
    await ctx.settle();
  },
};
export default shot;
