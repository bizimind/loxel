import type { PanelShot } from "../lib";

/** Worktree sidebar expanded, showing the project and its worktree. */
const shot: PanelShot = {
  description:
    "Worktree sidebar (left) expanded: the orbit-shop project with its main worktree (branch, change counts), the add-project control, next to the app shell",
  run: async (ctx) => {
    const { page } = ctx;
    // Whether the sidebar is expanded is a persisted, cross-window preference; keep this window's
    // change local so other shots (sharing the server) still start with it collapsed.
    await page.route(/\/api\/stores\/projects$/, (route) =>
      route.request().method() === "GET" ? route.fallback() : route.fulfill({ json: {} }),
    );
    await page.locator('[title="Expand sidebar"]').first().click();
    await page.locator('[title="Collapse sidebar"]').first().waitFor({ state: "visible" });
    await ctx.settle();
    await page.mouse.move(800, 600);
    await ctx.settle();
  },
};
export default shot;
