import type { PanelShot } from "../lib";

/** The markdown editor's code block previews: a Mermaid diagram and a diff fence. */
const shot: PanelShot = {
  description:
    "Markdown editor (Milkdown) with docs/review.md: a Mermaid flowchart rendered in its code block's preview panel, and a diff fence rendered as a diff view with its file header, Unified/Split toggle and Open in diff panel button",
  run: async (ctx) => {
    await ctx.open("docs/review.md");
    const editor = ctx.page.locator(".milkdown:visible").first();
    await editor.locator(".loxel-mermaid svg:visible").first().waitFor({ state: "visible" });
    await editor.locator(".loxel-diff-block").first().waitFor({ state: "visible" });
    await ctx.settle();
  },
};
export default shot;
