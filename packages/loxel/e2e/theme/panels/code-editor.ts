import type { PanelShot } from "../lib";

/** Monaco with src/server.ts: TypeScript syntax, inlay hints, a selected word, current line. */
const shot: PanelShot = {
  description:
    "Code editor (Monaco) with src/server.ts: TypeScript syntax highlighting, inlay type hints, diagnostics squiggles, line numbers, a selected identifier with its other occurrences highlighted, the current-line highlight, the overview ruler and the tab bar",
  run: async (ctx) => {
    await ctx.open("src/server.ts");
    const editor = ctx.page.locator(".monaco-editor:visible").first();
    const word = editor.locator(".view-line", { hasText: "export function findProduct" });
    await word.waitFor({ state: "visible" });
    // Wait for the TypeScript server's inlay hints (`PORT: number`) so semantic colors, hints and
    // diagnostics are in. The server attaches to one window per worktree, so a concurrent shot can
    // hold it ("TypeScript in another window"); shoot without it then rather than fail.
    await editor
      .locator(".view-line", { hasText: /PORT\W*number/ })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => {});
    // Double-click `findProduct` so the selection and its occurrence highlights show.
    await word
      .getByText("findProduct")
      .first()
      .dblclick()
      .catch(async () => {
        await word.dblclick({ position: { x: 150, y: 8 } });
      });
    await editor.locator(".selected-text").first().waitFor({ state: "attached" });
    await ctx.settle();
    // Late async work (language server, notifications) can take focus; keep the editor focused so
    // the selection shows in its focused color.
    await editor.locator("textarea").first().focus();
    await editor.locator(".monaco-editor.focused, .focused").first().waitFor({ state: "attached" });
  },
};
export default shot;
