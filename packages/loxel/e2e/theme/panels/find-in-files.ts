import type { PanelShot } from "../lib";

/** Find in files (⇧⌘F) with matches in several files and the second result selected. */
const shot: PanelShot = {
  description:
    'Find-in-files search modal (⇧⌘F) over an open editor with the query "priceCents": match lines with the match highlighted, file icons and paths, scope filter row, option toggles, and the second result selected',
  run: async ({ page, open, settle }) => {
    await open("src/catalog.ts");
    await page.locator(".monaco-editor .view-lines").first().waitFor({ state: "visible" });
    await page.keyboard.press("Meta+Shift+F");
    const input = page.getByPlaceholder("Search in files...");
    await input.waitFor({ state: "visible" });
    await input.fill("priceCents");
    const results = page.locator("dialog[open] button:has(mark)");
    await page.waitForFunction(
      () => document.querySelectorAll("dialog[open] button mark").length >= 4,
    );
    await settle();
    // Results stream in; wait for the count to settle before selecting.
    let count = -1;
    while (count !== (await results.count())) {
      count = await results.count();
      await settle();
    }
    await input.press("ArrowDown");
    await settle();
  },
};
export default shot;
