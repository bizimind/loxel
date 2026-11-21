// A namespace, not `{ app }`: unit tests stand in for electron with mocks that may have no `app`.
import * as electron from "electron";

import { parseDemoInstance } from "../demo-instance";
import { withoutLoxelOverrides } from "../loxel-overrides";

/**
 * The environment main runs in, as far as Loxel's own variables go: a packaged app ignores the dev,
 * demo and test overrides (loxel-overrides.ts), and so does the server it starts with it, so a
 * packaged app always runs as itself, whatever environment it was launched in. A dev or demo app
 * from the source tree takes them as they are. Read Loxel's variables only through this.
 */
export function launchEnv(env: NodeJS.ProcessEnv, isPackaged: boolean): NodeJS.ProcessEnv {
  return isPackaged ? withoutLoxelOverrides(env) : env;
}

export const LAUNCH_ENV = launchEnv(process.env, electron.app?.isPackaged ?? false);

/**
 * Demo mode (`LOXEL_DEMO=1`): a Loxel with its own server port, state, data directory and
 * single-instance lock, so it runs beside the installed app without touching its projects, and
 * with no DEV badge or update checks. Used to stage screenshots; see docs/ELECTRON.md.
 */
export const IS_DEMO = LAUNCH_ENV.LOXEL_DEMO === "1";

/**
 * The Vite dev server a dev Electron's windows load the renderer from (`VITE_DEV_SERVER_URL`), in
 * dev mode only. Demo mode wins: a demo started from a dev Loxel's terminal inherits its
 * VITE_DEV_SERVER_URL, and would otherwise load (and drive) that dev Loxel's renderer and server.
 * Read only through this, never from the env.
 */
export const DEV_RENDERER_URL = IS_DEMO ? undefined : LAUNCH_ENV.VITE_DEV_SERVER_URL || undefined;
export const IS_DEV = DEV_RENDERER_URL !== undefined;

/** The demo window's size in points: the size of the site's screenshots, a large monitor's window. */
export const DEMO_WINDOW_SIZE = { width: 1920, height: 1200 };

/** Which demo this is (`LOXEL_DEMO_INSTANCE`, default 0), so several can run side by side. */
export const DEMO_INSTANCE = IS_DEMO ? parseDemoInstance(LAUNCH_ENV.LOXEL_DEMO_INSTANCE) : 0;

/**
 * A demo that never shows itself (`LOXEL_DEMO_HIDDEN=1`), for capturing screenshots without taking
 * over the screen: no Dock icon or menu bar, and windows that are fully transparent, let the mouse
 * through and never take focus, while still rendering for `capturePage()`.
 */
export const IS_DEMO_HIDDEN = IS_DEMO && LAUNCH_ENV.LOXEL_DEMO_HIDDEN === "1";
