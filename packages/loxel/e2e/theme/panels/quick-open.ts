import type { PanelShot } from "../lib";

/** Quick Open (⌘P) filtered to several fixture files. */
const shot: PanelShot = {
  description:
    'Quick Open file picker (⌘P) over an open editor with the query "src": several fixture files with file-type icons, matched characters highlighted, paths, and the first row selected',
  run: async ({ page, open, settle }) => {
    await open("src/search.ts");
    await page.locator(".monaco-editor .view-lines").first().waitFor({ state: "visible" });
    await page.keyboard.press("Meta+P");
    const input = page.getByPlaceholder("Open file");
    await input.waitFor({ state: "visible" });
    await input.fill("src");
    await page.getByRole("dialog").getByText("server.ts").first().waitFor();
    await settle();
  },
};
export default shot;
