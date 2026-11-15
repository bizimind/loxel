import type { PanelShot } from "../lib";

/** The full-size Mermaid viewer, opened by clicking a diagram in the markdown editor. */
const shot: PanelShot = {
  description:
    "Full-size Mermaid diagram viewer over the markdown editor: the flowchart from docs/checkout.md fitted to the window, with the zoom toolbar (zoom out/in, percentage, fit, actual size, auto-fit), Copy as SVG/PNG and close",
  run: async (ctx) => {
    await ctx.open("docs/checkout.md");
    const diagram = ctx.page.locator(".milkdown:visible .loxel-mermaid").first();
    await diagram.locator("svg:visible").first().waitFor({ state: "visible" });
    await diagram.locator('[data-mermaid-action="open"]').click({ force: true });
    await ctx.page.locator("dialog[open] svg[aria-roledescription]").waitFor({ state: "visible" });
    await ctx.settle();
  },
};
export default shot;
