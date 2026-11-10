import type { PanelShot } from "../lib";
import { waitForLoxel } from "../lib";

/** Whether a server WebSocket frame is a cross-window update of the projects store. */
function isProjectsStoreUpdate(message: string | Buffer): boolean {
  if (typeof message !== "string" || !message.includes("store_updated")) return false;
  try {
    const parsed: unknown = JSON.parse(message);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      parsed.type === "store_updated" &&
      "key" in parsed &&
      parsed.key === "projects"
    );
  } catch {
    return false;
  }
}

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
    // Other shots running at the same time persist the projects store (collapsed) and the server
    // relays that to every window, which would collapse this one mid-shot. Drop those relays here;
    // the route applies to new connections, so reload once to reconnect through it.
    await page.routeWebSocket(/\/ws$/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((message) => {
        if (!isProjectsStoreUpdate(message)) ws.send(message);
      });
    });
    await waitForLoxel(page);
    await page.locator('[title="Expand sidebar"]').first().click();
    await page.locator('[title="Collapse sidebar"]').first().waitFor({ state: "visible" });
    await ctx.settle();
    await page.mouse.move(800, 600);
    await ctx.settle();
  },
};
export default shot;
