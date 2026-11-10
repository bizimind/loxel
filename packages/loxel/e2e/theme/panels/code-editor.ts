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
    // hold it ("TypeScript in another window"): take it back through the status bar item (a click
    // restarts it here) and wait again, a few times; shoot without it rather than fail.
    const hints = editor.locator(".view-line", { hasText: /PORT\W*number/ }).first();
    const stolen = ctx.page.getByRole("button", { name: /in another window/ });
    const attachTypeScript = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await Promise.race([
          hints.waitFor({ state: "visible", timeout: 20_000 }),
          stolen.waitFor({ state: "visible", timeout: 20_000 }),
        ]).catch(() => {});
        if (await hints.isVisible()) return;
        if (!(await stolen.isVisible())) continue;
        await stolen.click();
        await stolen.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
      }
    };
    await attachTypeScript();
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
    // the selection shows in its focused color. Monaco takes input through its EditContext element
    // (the textarea is only for IME), and marks the editor root `.focused` once that has focus.
    await editor.locator(".native-edit-context").first().focus();
    await ctx.page.locator(".monaco-editor.focused").first().waitFor({ state: "attached" });
    // A shot that opened meanwhile can have taken the server again.
    if (!(await hints.isVisible())) {
      await attachTypeScript();
      await editor.locator(".native-edit-context").first().focus();
    }
  },
};
export default shot;
