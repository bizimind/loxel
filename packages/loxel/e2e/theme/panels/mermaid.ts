import type { PanelShot } from "../lib";

/** A Mermaid flowchart with long labels, in its markdown code block's preview panel. */
const shot: PanelShot = {
  description:
    "Markdown editor (Milkdown) with docs/checkout.md: a wide Mermaid flowchart with long, wrapped labels in its code block's preview panel, hovered so its toolbar (zoom, copy as SVG/PNG, open) shows",
  run: async (ctx) => {
    await ctx.open("docs/checkout.md");
    const editor = ctx.page.locator(".milkdown:visible").first();
    const diagram = editor.locator(".loxel-mermaid").first();
    await diagram.locator("svg:visible").first().waitFor({ state: "visible" });
    await diagram.hover();
    await ctx.settle();
    return editor.locator(".milkdown-code-block").first();
  },
};
export default shot;
