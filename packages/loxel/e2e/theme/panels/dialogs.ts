import type { PanelShot } from "../lib";

/** The New Worktree dialog with a name typed in (never submitted). */
const shot: PanelShot = {
  description:
    'New Worktree dialog (⌃⌥N) over the app with an editor open: heading, name input filled with "checkout-flow" and focused, helper text, and the Create / Cancel buttons over a dimmed backdrop',
  run: async ({ page, open, settle }) => {
    await open("src/server.ts");
    await page.locator(".monaco-editor .view-lines").first().waitFor({ state: "visible" });
    await page.keyboard.press("Control+Alt+KeyN");
    const name = page.getByPlaceholder("worktree-name");
    await name.waitFor({ state: "visible" });
    await name.fill("checkout-flow");
    await name.focus();
    await settle();
  },
};
export default shot;
