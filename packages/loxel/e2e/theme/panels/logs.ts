import type { PanelShot } from "../lib";

type Level = "debug" | "info" | "warn" | "error";

const FIXTURE_LOGS: [Level, string, string, Record<string, unknown>?][] = [
  ["info", "server", "Loxel server listening", { port: 7434, pid: 4242 }],
  ["info", "server", "Project registered: orbit-shop"],
  ["debug", "watcher", "Watching 12 directories", { root: "orbit-shop", ignored: 3 }],
  ["info", "git", "Status refreshed", { modified: 2, untracked: 1, deleted: 1, ms: 18 }],
  ["debug", "files", "Read src/server.ts", { bytes: 1043 }],
  ["info", "ts-lsp", "TypeScript language server ready", { version: "5.9.3", ms: 812 }],
  ["warn", "yaml-lsp", "Schema not found for config/app.yaml, falling back to none"],
  ["info", "terminal", "Spawned zsh", { cols: 120, rows: 32 }],
  ["error", "git", "fetch origin failed: could not resolve host", { exitCode: 128 }],
  ["warn", "perf", "Slow request", { route: "/api/commits", ms: 640 }],
  ["debug", "search", "Indexed 9 files", { ms: 4 }],
  ["info", "format", "Formatted src/cart.ts with Prettier"],
  ["error", "python-lsp", "pyright exited unexpectedly", { code: 1, signal: null }],
  ["info", "worktrees", "Loaded 1 worktree"],
  ["debug", "ui", "Layout restored", { panels: 3 }],
];

/** Logs panel with fixed entries of every level and its filter sidebar open. */
const shot: PanelShot = {
  description:
    "Logs panel (bottom, enlarged) with debug/info/warn/error entries across categories, one entry expanded to its YAML context, and the level/category filter sidebar open",
  run: async (ctx) => {
    const { page } = ctx;
    // Serve a fixed log history. Ids start far above the live server's, so live entries streamed
    // over the WebSocket are dropped by the store's id dedup and the list stays the same each run.
    const base = 1_000_000_000;
    const entries = FIXTURE_LOGS.map(([level, cat, msg, logCtx], i) => ({
      id: base + i,
      ts: new Date(Date.UTC(2026, 9, 10, 11, 58, 2 + i * 3, 117 + i * 41)).toISOString(),
      level,
      cat,
      msg,
      ...(logCtx ? { ctx: logCtx } : {}),
    })).reverse();
    await page.route(/\/api\/logs(\?|$)/, (route) =>
      route.fulfill({ json: { entries, hasMore: false } }),
    );
    // The Logs panel loads its history when the app starts, so reload to pick up the fixed one.
    await page.reload();
    await page.locator('[title="Logs"]').first().waitFor({ state: "visible" });
    await ctx.settle();
    await page.locator('[title="Logs"]').first().click();
    const last = page.getByText("Layout restored").first();
    await last.waitFor({ state: "visible" });
    const group = page.locator(".dv-groupview", { has: last }).first();
    const box = await group.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y - 1);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, 420, { steps: 5 });
      await page.mouse.up();
    }
    // Open the filter sidebar (a persisted UI preference) only if it is closed.
    if (!(await page.getByText("Category", { exact: true }).first().isVisible())) {
      await page.locator('[title="Toggle filters"]').first().click();
    }
    await page.getByText("Category", { exact: true }).first().waitFor({ state: "visible" });
    // Expand one entry's context.
    const row = page.locator("div.group", { hasText: "TypeScript language server ready" }).first();
    await row.locator("button").first().click();
    await page.locator("div.group", { hasText: "Slow request" }).first().hover();
    await ctx.settle();
  },
};
export default shot;
