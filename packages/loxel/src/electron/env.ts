import { parseDemoInstance } from "../demo-instance";

/**
 * Demo mode (`LOXEL_DEMO=1`): a Loxel with its own server port, state, data directory and
 * single-instance lock, so it runs beside the installed app without touching its projects, and
 * with no DEV badge or update checks. Used to stage screenshots; see docs/ELECTRON.md.
 */
export const IS_DEMO = process.env.LOXEL_DEMO === "1";

/**
 * The Vite dev server the window loads its renderer from, in dev mode only. Demo mode wins: a demo
 * started from a dev Loxel's terminal inherits its VITE_DEV_SERVER_URL, and would otherwise load
 * (and drive) that dev Loxel's renderer and server. Read only through this, never from the env.
 */
export const DEV_RENDERER_URL = IS_DEMO ? undefined : process.env.VITE_DEV_SERVER_URL || undefined;
export const IS_DEV = DEV_RENDERER_URL !== undefined;

/** The demo window's size in points: the size of the site's screenshots, a large monitor's window. */
export const DEMO_WINDOW_SIZE = { width: 1920, height: 1200 };

/** Which demo this is (`LOXEL_DEMO_INSTANCE`, default 0), so several can run side by side. */
export const DEMO_INSTANCE = IS_DEMO ? parseDemoInstance(process.env.LOXEL_DEMO_INSTANCE) : 0;

/**
 * A demo that never shows itself (`LOXEL_DEMO_HIDDEN=1`), for capturing screenshots without taking
 * over the screen: no Dock icon or menu bar, and windows that are fully transparent, let the mouse
 * through and never take focus, while still rendering for `capturePage()`.
 */
export const IS_DEMO_HIDDEN = IS_DEMO && process.env.LOXEL_DEMO_HIDDEN === "1";
