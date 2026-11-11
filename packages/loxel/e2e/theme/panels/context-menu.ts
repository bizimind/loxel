import type { PanelShot } from "../lib";

/** The Project Files context menu on a file, with its "Open In" submenu open. */
const shot: PanelShot = {
  description:
    "Project Files tree (left) with a right-click context menu on src/server.ts: file label, New File/Folder, Rename, Cut/Copy/Paste with shortcut hints, separators, and the Open In submenu expanded with app icons; an editor is open in the center",
  run: async ({ page, fixture, open, settle }) => {
    await open("src/server.ts");
    await page.locator(".monaco-editor .view-lines").first().waitFor({ state: "visible" });
    await page.keyboard.press("Meta+Shift+E");
    const root = page.locator(`[data-tree-path="${fixture}"]`);
    await root.waitFor({ state: "visible" });

    // The tool panel opens narrow; drag its sash so file names are readable.
    const sash = page.locator(".dv-sash.dv-enabled").filter({ visible: true });
    const panelRight = await root.evaluate((el) => el.getBoundingClientRect().right);
    for (const handle of await sash.all()) {
      const box = await handle.boundingBox();
      if (!box || Math.abs(box.x - panelRight) > 12 || box.height < 200) continue;
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(340, y, { steps: 8 });
      await page.mouse.up();
      break;
    }

    const src = page.locator(`[data-tree-path="${fixture}/src"]`);
    if ((await src.getAttribute("data-tree-expanded")) === null) await src.click();
    const row = page.locator(`[data-tree-path="${fixture}/src/server.ts"]`);
    await row.waitFor({ state: "visible" });
    await row.click({ button: "right" });
    const openIn = page.getByRole("menuitem", { name: "Open In" });
    await openIn.waitFor({ state: "visible" });
    await openIn.hover();
    const submenu = page.getByRole("menu").nth(1);
    await submenu.waitFor({ state: "visible" });
    await submenu.getByText("Loading apps…").waitFor({ state: "hidden" });
    await settle();
  },
};
export default shot;
