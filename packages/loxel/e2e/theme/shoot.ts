/**
 * Capture one theme screenshot: `bun e2e/theme/shoot.ts <panel> <out.png> [work-dir] [--dark]`.
 * `<panel>` names a file in `panels/` (without `.ts`). The stack from `stack.sh` must be running.
 * `--dark` shows this one page in the dark theme (the shared setting stays Light), to check that
 * a light-theme fix leaves dark mode alone.
 */
import { resolve } from "node:path";

import { chromium } from "@playwright/test";

import type { PanelShot, ShotContext } from "./lib";
import { api, fixturePath, settle, trackRequests, waitForLoxel } from "./lib";

const args = process.argv.slice(2);
const dark = args.includes("--dark");
const [panel, out, workDirArg] = args.filter((a) => a !== "--dark");
if (!panel || !out) throw new Error("usage: bun e2e/theme/shoot.ts <panel> <out.png> [work-dir]");
const workDir = workDirArg ?? process.env.THEME_WORK_DIR;
if (!workDir) throw new Error("pass a work dir or set THEME_WORK_DIR (the dir given to stack.sh)");

const mod = (await import(resolve(import.meta.dirname, "panels", `${panel}.ts`))) as {
  default: PanelShot;
};
const shot = mod.default;
const fixture = fixturePath(workDir);

/** Notifications live on the server; drop leftovers from earlier shots so no bell badge shows. */
async function clearNotifications(): Promise<void> {
  const ws = new WebSocket("ws://127.0.0.1:7434/ws");
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "notifications_clear" }));
      ws.close();
      res();
    });
    ws.addEventListener("error", () => rej(new Error("could not reach the server WebSocket")));
  });
}
await clearNotifications();

/** Every shot starts with the worktree sidebar collapsed, whatever an earlier shot persisted. */
async function collapseSidebar(): Promise<void> {
  const { value } = (await api("/api/stores/projects")) as { value: string | null };
  if (!value) return;
  const stored = JSON.parse(value) as { state: Record<string, unknown>; version: number };
  if (stored.state.sidebarExpanded !== true) return;
  stored.state.sidebarExpanded = false;
  await api("/api/stores/projects", { method: "PUT", body: { value: JSON.stringify(stored) } });
}
await collapseSidebar();

/**
 * A server restart promotes the newest shot's window layout to the canonical "last closed window"
 * layout, which every later fresh window would restore. Blank it so each shot starts from the
 * default layout (an empty value is skipped on restore).
 */
async function resetCanonicalLayouts(): Promise<void> {
  for (const scope of ["outer", "center"]) {
    const key = encodeURIComponent(`layout:canonical:${scope}:${fixture}`);
    await api(`/api/stores/${key}`, { method: "PUT", body: { value: "" } });
  }
}
await resetCanonicalLayouts();

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: dark ? "dark" : "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  trackRequests(page);
  if (dark) {
    // Serve this page a dark theme setting and keep its settings writes off the shared server.
    await page.route("**/api/stores/settings", async (route) => {
      if (route.request().method() !== "GET") return route.fulfill({ json: { success: true } });
      const res = await route.fetch();
      const body = (await res.json()) as { value: string | null };
      const stored = body.value
        ? (JSON.parse(body.value) as { state: object; version: number })
        : null;
      const value = JSON.stringify({
        version: stored?.version ?? 14,
        state: { ...stored?.state, theme: "dark" },
      });
      await route.fulfill({ json: { value } });
    });
  }
  // Relative dates ("3 days ago") stay the same between runs.
  await page.clock.setFixedTime(new Date("2026-10-10T12:00:00Z"));
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent =
      "*,*::before,*::after{transition:none!important;animation-duration:0s!important;caret-color:transparent!important}";
    document.addEventListener("DOMContentLoaded", () => document.head.append(style));
  });
  await waitForLoxel(page);
  const windowId = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.endsWith("-window-id"));
    return key ? (localStorage.getItem(key) ?? "") : "";
  });

  const ctx: ShotContext = {
    page,
    fixture,
    windowId,
    api,
    settle: () => settle(page),
    open: async (relativePath) => {
      await api("/api/open", { body: { filePath: resolve(fixture, relativePath), windowId } });
      await settle(page);
    },
    openTerminal: async (command) => {
      await api("/api/open", {
        body: { terminal: { cwd: fixture, ...(command ? { command } : {}) }, windowId },
      });
      await page.locator(".xterm-screen:visible").first().waitFor({ state: "visible" });
      await settle(page);
    },
    runCommand: async (name) => {
      await page.keyboard.press("Meta+Shift+P");
      await page.keyboard.type(name);
      await page.waitForTimeout(150);
      await page.keyboard.press("Enter");
      await settle(page);
    },
  };

  const clip = await shot.run(ctx);
  await settle(page);
  await (clip ?? page).screenshot({ path: resolve(out), animations: "disabled" });
  console.log(resolve(out));
} finally {
  await browser.close();
}
