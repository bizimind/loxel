import type { PanelShot } from "../lib";

/** Settings > Appearance's code font picker, open over the Settings modal. */
const shot: PanelShot = {
  description:
    "The code font picker dialog (opened from Settings > Appearance > Code Font) over the Settings modal: a search field, the Show all fonts switch, and the list of fonts, each in its own typeface, with the bundled default first",
  run: async ({ page, settle }) => {
    await page.keyboard.press("Meta+Comma");
    await page.locator("#settings-appearance").waitFor({ state: "visible" });
    await page.getByRole("button", { name: /^Code Font:/ }).click();
    const dialog = page.locator("dialog[open]").first();
    await dialog.waitFor({ state: "visible" });
    await settle();
  },
};
export default shot;
