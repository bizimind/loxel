import { resolve } from "node:path";

import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import { $ } from "bun";

import { withoutAgentEnv } from "../../src/coding-agent-env";
import { DEMO_WINDOW_SIZE } from "../../src/electron/env";
import {
  demoEnv,
  demoServer,
  demoStateDir,
  LOXEL_ROOT,
  MAIN_JS,
  registerDemoProjects,
} from "./demo-app";
import { demoWorktree } from "./demo-projects";

const CLI = resolve(LOXEL_ROOT, "src/cli.ts");
/** The real window capture that every shot's content is composited into (`capture-frame.ts`). */
export const FRAME_FILE = resolve(import.meta.dirname, "window-frame.png");
export const SCREENSHOTS_DIR = resolve(LOXEL_ROOT, "../site/src/assets/screenshots");

export interface DemoSession {
  app: ElectronApplication;
  page: Page;
  /** Which demo app this is (`LOXEL_DEMO_INSTANCE`). */
  instance: number;
  /** Run the `loxel` CLI against the demo, from inside a task's worktree. */
  loxel(project: string, task: string, ...args: string[]): Promise<void>;
  /** The worktree directory of a task. */
  worktree(project: string, task: string): string;
  /** The window's content at device resolution, as PNG bytes. */
  captureContent(): Promise<Buffer>;
  close(): Promise<void>;
}

/**
 * Start the demo app (built by `vite build` with ELECTRON=1) through Playwright's Electron driver,
 * with the demo projects registered and trusted. Hidden, it renders without ever showing itself.
 */
export async function launchDemo({
  hidden,
  instance = 0,
}: {
  hidden: boolean;
  instance?: number;
}): Promise<DemoSession> {
  const app = await _electron.launch({
    args: [MAIN_JS],
    cwd: LOXEL_ROOT,
    env: demoEnv(instance, hidden),
  });
  // A hidden app that failed to start would keep running unseen.
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    // Loxel's default zoom, whatever an earlier run left in the demo's data (Chromium keeps it).
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.setZoomLevel(0);
    });
    await registerDemoProjects(instance);
    // The window loaded its project list before these were added. Reload once its requests are
    // done, so none is cut off (and logged as an error).
    await page.waitForLoadState("networkidle");
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const cliEnv = {
      ...withoutAgentEnv(process.env),
      LOXEL: "1",
      LOXEL_PORT: new URL(demoServer(instance)).port,
    };
    return {
      app,
      page,
      instance,
      worktree: demoWorktree,
      loxel: async (project, task, ...args) => {
        await $`bun ${CLI} ${args}`.cwd(demoWorktree(project, task)).env(cliEnv).quiet();
      },
      captureContent: async () => {
        const png = await app.evaluate(async ({ BrowserWindow }) => {
          const [win] = BrowserWindow.getAllWindows();
          if (!win) throw new Error("The demo app has no window");
          const image = await win.webContents.capturePage();
          return image.toPNG().toString("base64");
        });
        return Buffer.from(png, "base64");
      },
      close: () => app.close(),
    };
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}

/** Composite a content capture into the window frame and save it as a site screenshot. */
export async function saveShot(name: string, content: Buffer, instance: number): Promise<string> {
  // The PNG's width (in its IHDR chunk) over the window's width in points.
  const scale = Math.round(content.readUInt32BE(16) / DEMO_WINDOW_SIZE.width);
  // The bare capture goes in the instance's state, never into the site's assets.
  const contentFile = resolve(demoStateDir(instance), `${name}.content.png`);
  const out = resolve(SCREENSHOTS_DIR, `${name}.png`);
  try {
    await Bun.write(contentFile, content);
    await $`swift ${resolve(import.meta.dirname, "composite.swift")} ${FRAME_FILE} ${contentFile} ${out} ${scale}`.quiet();
  } finally {
    await $`rm -f ${contentFile}`.quiet();
  }
  return out;
}
