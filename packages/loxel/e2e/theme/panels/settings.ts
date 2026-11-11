import type { PanelShot } from "../lib";

/** The Settings modal scrolled to Appearance: the Theme control and the font rows. */
const shot: PanelShot = {
  description:
    "Settings modal (over the app shell) scrolled to the Appearance section: Theme radio group (Dark / Light / System, the current theme selected) and the Code, Terminal and Markdown font rows (font button and size field), followed by the Keybindings section; left section nav with scrollspy highlight",
  run: async ({ page, settle }) => {
    await page.keyboard.press("Meta+Comma");
    const appearance = page.locator("#settings-appearance");
    await appearance.waitFor({ state: "visible" });
    await page.locator('a.settings-nav-link[href="#settings-appearance"]').click();
    // The content pane scrolls smoothly; wait until the section reaches the top and stays there.
    await page.waitForFunction(() => {
      const el = document.getElementById("settings-appearance");
      const pane = el?.parentElement;
      if (!el || !pane) return false;
      return Math.abs(el.getBoundingClientRect().top - pane.getBoundingClientRect().top) < 30;
    });
    await page.getByRole("radio", { checked: true }).waitFor();
    await settle();
  },
};
export default shot;
