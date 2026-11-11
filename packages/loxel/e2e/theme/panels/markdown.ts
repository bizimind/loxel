import type { PanelShot } from "../lib";

/** The Milkdown markdown editor with docs/plan.md. */
const shot: PanelShot = {
  description:
    "Markdown editor (Milkdown WYSIWYG) with docs/plan.md: expanded frontmatter (YAML) block, headings, paragraph with inline code, a task list with checked and unchecked boxes, a blockquote, a table, a TypeScript code block, a link and bold/italic text",
  run: async (ctx) => {
    await ctx.open("docs/plan.md");
    const editor = ctx.page.locator(".milkdown:visible").first();
    await editor.getByText("Recommendations rollout").first().waitFor({ state: "visible" });
    // The code block (CodeMirror) and table render after the prose.
    await editor.locator(".cm-content", { hasText: "RecommendationRequest" }).first().waitFor();
    await editor.getByText("Data pipeline").first().waitFor({ state: "visible" });
    // Expand the collapsed frontmatter block so its YAML shows.
    const panel = ctx.page.locator(".dv-groupview:visible", { has: editor }).first();
    await panel.getByText("Frontmatter", { exact: true }).first().click();
    await panel.getByText("in-progress").first().waitFor({ state: "visible" });
    await ctx.settle();
  },
};
export default shot;
