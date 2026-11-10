import type { PanelShot } from "../lib";

/** The command palette filtered to several actions that have shortcuts. */
const shot: PanelShot = {
  description:
    'Command palette open over an editor with the query "new": a list of matching actions with categories, the first row highlighted, matched characters highlighted, and keyboard shortcut badges on the right',
  run: async ({ page, open, settle }) => {
    await open("src/server.ts");
    await page.locator(".monaco-editor .view-lines").first().waitFor({ state: "visible" });
    // Right after the editor mounts, Monaco can still swallow the first keystroke; retry.
    const input = page.getByPlaceholder("Run command");
    for (let attempt = 0; !(await input.isVisible()); attempt++) {
      if (attempt >= 5) throw new Error("command palette did not open");
      await page.keyboard.press("Meta+Shift+P");
      await input.waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
    }
    await input.fill("new");
    await page.getByText("Split Below").filter({ visible: true }).first().waitFor();
    await settle();
  },
};
export default shot;
