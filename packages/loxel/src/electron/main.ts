import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  Menu,
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  type WebFrameMain,
  webContents,
} from "electron";
import { z } from "zod";

import { DEFAULT_SERVER_PORT } from "../app-ports";
import { demoPort } from "../demo-instance";
import { getDek, initDek } from "./dek";
import {
  DEMO_INSTANCE,
  DEMO_WINDOW_SIZE,
  DEV_RENDERER_URL,
  IS_DEMO,
  IS_DEMO_HIDDEN,
  IS_DEV,
} from "./env";
const SERVER_PORT = IS_DEMO
  ? demoPort(DEMO_INSTANCE)
  : IS_DEV
    ? DEFAULT_SERVER_PORT.dev
    : DEFAULT_SERVER_PORT.production;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

/**
 * The server this process started, which lives exactly as long as the app. Null while a crashed
 * server waits to restart, and in dev when an already-running dev server is used.
 */
let serverProcess: ChildProcess | null = null;

/** Set once the app quits, so the server's exit is not taken for a crash. */
let stoppingServer = false;

/** Consecutive crash count for the restart backoff. */
let serverCrashCount = 0;

/** Pending delayed restart of a crashed server, so only one restart is ever in flight. */
let serverRestartTimer: ReturnType<typeof setTimeout> | null = null;

/** When the current server process was spawned. */
let serverStartedAt = 0;

const SERVER_MAX_CRASH_RESTARTS = 3;

/** A server that stayed up this long before crashing gets a fresh retry budget. */
const SERVER_STABLE_UPTIME_MS = 60_000;

/** How long launch waits for a server a previous run of the app left shutting down. */
const STALE_SERVER_WAIT_MS = 15_000;

/** Whether the Cmd (Meta) key is currently held. Tracked via before-input-event on all webContents. */
let metaKeyHeld = false;

import { requestOpen } from "../open-request";
import { isHttpUrl } from "../url-utils";
import { installAppUpdater, isInstallingUpdate, scheduleAutomaticUpdateCheck } from "./app-updater";
import { BROWSER_PARTITION } from "./browser-partition";
import {
  GET_WINDOW_FULL_SCREEN,
  OPEN_FOLDER_DIALOG,
  OPEN_IN_BROWSER_TAB,
  SET_DOCK_BADGE,
  WINDOW_FOCUS_CHANGE,
  WINDOW_FULL_SCREEN_CHANGE,
} from "./ipc-channels";
import {
  configureWebviewDialogs,
  installJavaScriptDialogs,
  trackWebviewDialogs,
} from "./javascript-dialogs";
import { localFontsCheckHandler } from "./local-fonts-permission";
import { startMainProcessMonitor } from "./main-perf-monitor";
import {
  type BrowserPanelFrame,
  configurePasskeys,
  installAccountChooser,
  installHybridQrCode,
} from "./webauthn";
import { installWebviewCopyImage } from "./webview-copy-image";
import { forwardWebviewKeystrokes, installWebviewKeystrokeForwarding } from "./webview-keystrokes";
import { handleWebviewWindowOpens } from "./webview-new-tabs";

/** Send a URL to the focused window's renderer to open in a browser panel tab. */
function openInBrowserTab(url: string): void {
  BrowserWindow.getFocusedWindow()?.webContents.send(OPEN_IN_BROWSER_TAB, url);
}

const VersionSchema = z.object({
  appOwned: z.boolean().optional(),
  shuttingDown: z.boolean().optional(),
});

/**
 * The Loxel server answering on the well-known port, or null when none does. `appOwned`: a desktop
 * app started it, so it goes away with that app. `shuttingDown`: it is about to exit.
 */
async function probeServer(): Promise<{ appOwned: boolean; shuttingDown: boolean } | null> {
  try {
    const res = await fetch(`${SERVER_URL}/api/version`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
    const parsed = VersionSchema.safeParse(await res.json());
    return {
      appOwned: parsed.success && parsed.data.appOwned === true,
      shuttingDown: parsed.success && parsed.data.shuttingDown === true,
    };
  } catch {
    return null;
  }
}

async function isServerRunning(): Promise<boolean> {
  return (await probeServer()) !== null;
}

function startServer(): void {
  serverStartedAt = Date.now();
  // The server exits on its own if this process dies without stopping it.
  const env = { ...process.env, LOXEL_PARENT_PID: String(process.pid) };
  const child = IS_DEV
    ? // In dev, spawn bun running the server source directly
      spawn("bun", ["run", "src/server/index.ts"], {
        cwd: path.resolve(import.meta.dirname, "../.."),
        env: { ...env, LOXEL_DEV: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      })
    : IS_DEMO && !app.isPackaged
      ? // A demo from the source tree: the server's source, serving the renderer built beside this file
        spawn("bun", ["run", "src/server/index.ts"], {
          cwd: path.resolve(import.meta.dirname, "../.."),
          env: { ...env, LOXEL_STATIC_DIR: path.resolve(import.meta.dirname, "../renderer") },
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn(path.join(process.resourcesPath, "loxel-server"), [], {
          env: { ...env, LOXEL_STATIC_DIR: path.join(process.resourcesPath, "renderer") },
          stdio: ["pipe", "pipe", "pipe"],
        });
  serverProcess = child;

  // The demo server uses a fixed key (it holds no real secrets), so no keychain prompt.
  const dekBase64 = IS_DEMO ? null : getDek();
  child.stdin.on("error", () => {});
  // Closing stdin without a key tells the server that secret storage is unavailable.
  if (dekBase64) child.stdin.write(dekBase64 + "\n");
  child.stdin.end();

  child.stdout.on("data", (data: Buffer) => {
    process.stdout.write(data);
  });
  child.stderr.on("data", (data: Buffer) => {
    process.stderr.write(data);
  });
  child.on("exit", (code, signal) => {
    console.log(`[electron] Server exited with code ${code}${signal ? ` (${signal})` : ""}`);
    // Only the current server's exit counts: an earlier one's must not drop its replacement.
    if (serverProcess !== child) return;
    serverProcess = null;
    if (!stoppingServer) scheduleServerRestart();
  });
}

/**
 * Restart a crashed server with linear backoff (1s, 2s, 3s). After SERVER_MAX_CRASH_RESTARTS
 * consecutive quick crashes, give up and quit: the app cannot work without its server.
 */
function scheduleServerRestart(): void {
  if (serverRestartTimer) return;
  if (Date.now() - serverStartedAt >= SERVER_STABLE_UPTIME_MS) serverCrashCount = 0;

  serverCrashCount++;
  if (serverCrashCount > SERVER_MAX_CRASH_RESTARTS) {
    console.error(`[electron] Server crashed ${SERVER_MAX_CRASH_RESTARTS} times, giving up`);
    dialog.showErrorBox(
      "Loxel Stopped Working",
      `Loxel's server crashed ${SERVER_MAX_CRASH_RESTARTS} times in a row. Open Loxel again to restart it.`,
    );
    app.quit();
    return;
  }

  const delayMs = serverCrashCount * 1000;
  console.log(
    `[electron] Server crashed (attempt ${serverCrashCount}/${SERVER_MAX_CRASH_RESTARTS}), restarting in ${delayMs}ms...`,
  );
  serverRestartTimer = setTimeout(() => {
    serverRestartTimer = null;
    if (stoppingServer || serverProcess) return;
    startServer();
  }, delayMs);
}

function cancelServerRestart(): void {
  if (!serverRestartTimer) return;
  clearTimeout(serverRestartTimer);
  serverRestartTimer = null;
}

function waitForServer(url: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      fetch(url)
        .then((res) => {
          if (res.ok || res.status === 404) resolve();
          else retry();
        })
        .catch(retry);
    }
    function retry() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Server did not start within ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 100);
    }
    check();
  });
}

const APP_ORIGIN = new URL(DEV_RENDERER_URL ?? SERVER_URL).origin;

function isLocal(url: string): boolean {
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Tracks in-flight promote calls so window creation can await them — prevents the
 * race where a new (now-solo) window opens and reads stale canonical before the
 * previous window's promote lands.
 */
const pendingPromotes = new Set<Promise<unknown>>();

/** Tell the server this window's session-scoped layouts are now canonical. */
function promoteLayoutForWindow(windowId: string): void {
  const p = (async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/layout/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windowId }),
      });
      if (!res.ok) {
        console.warn(`[electron] Layout promote returned HTTP ${res.status} for ${windowId}`);
      }
    } catch (err) {
      // Server's orphan recovery on next boot will clean this up.
      console.warn(`[electron] Layout promote failed for ${windowId}:`, err);
    }
  })();
  pendingPromotes.add(p);
  void p.finally(() => pendingPromotes.delete(p));
}

async function createWindow(): Promise<BrowserWindow> {
  // Drain any in-flight promotes so the new window's first read sees fresh canonical state.
  if (pendingPromotes.size > 0) {
    await Promise.allSettled(pendingPromotes);
  }

  const windowId = crypto.randomUUID();
  // Whether *no other* loxel windows are alive at the moment of creation.
  // The renderer uses this to decide whether to restore the canonical layout
  // (first window) or start with the default (additional window).
  const isFirstWindow = BrowserWindow.getAllWindows().length === 0;

  const win = new BrowserWindow({
    // A demo window has the size of the site's screenshots.
    // Larger than a laptop's screen is fine: a demo window is captured, not looked at.
    ...(IS_DEMO
      ? { ...DEMO_WINDOW_SIZE, enableLargerThanScreen: true }
      : { width: 1400, height: 900 }),
    ...(IS_DEMO_HIDDEN ? { show: false, opacity: 0 } : {}),
    title: "Loxel",
    titleBarStyle: "hiddenInset",
    tabbingIdentifier: "loxel",
    trafficLightPosition: { x: 12, y: 9 },
    // A click on a backgrounded window also reaches the renderer, so the clicked panel takes
    // focus on the same click that activates the window.
    acceptFirstMouse: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      preload: path.join(import.meta.dirname, "preload.cjs"),
      additionalArguments: [
        `--loxel-window-id=${windowId}`,
        `--loxel-is-first-window=${isFirstWindow ? "1" : "0"}`,
      ],
    },
  });

  if (IS_DEMO_HIDDEN) {
    win.setIgnoreMouseEvents(true);
    win.showInactive();
  }

  // When the BrowserWindow is gone, ask the server to promote this window's
  // session-scoped layout to canonical so the next solo window restores it.
  win.on("closed", () => {
    promoteLayoutForWindow(windowId);
  });

  // Reset meta key tracking when the window loses focus (e.g. Cmd+Tab away).
  // Without this, metaKeyHeld stays true because the keyUp never fires.
  win.on("blur", () => {
    metaKeyHeld = false;
    win.webContents.send(WINDOW_FOCUS_CHANGE, false);
  });
  win.on("focus", () => {
    win.webContents.send(WINDOW_FOCUS_CHANGE, true);
  });
  win.on("enter-full-screen", () => {
    win.webContents.send(WINDOW_FULL_SCREEN_CHANGE, true);
  });
  win.on("leave-full-screen", () => {
    win.webContents.send(WINDOW_FULL_SCREEN_CHANGE, false);
  });

  const loadUrl = DEV_RENDERER_URL ?? SERVER_URL;
  win.loadURL(loadUrl);

  // Intercept external link clicks at the document level. Chromium 134+ blocks
  // <a target="_blank" rel="noopener"> before setWindowOpenHandler fires when the
  // opener can't be cleared ("Opening link blocked as opener could not be cleared").
  // Converting clicks into same-window navigations routes them through will-navigate
  // which opens them in the system browser.
  win.webContents.on("dom-ready", () => {
    win.webContents.executeJavaScript(`
      if (!window.__externalLinkHandlerInstalled) {
        window.__externalLinkHandlerInstalled = true;
        document.addEventListener('click', (e) => {
          const link = e.target.closest('a[href]');
          if (!link) return;
          try {
            const url = new URL(link.href, window.location.href);
            if (url.origin !== window.location.origin) {
              e.preventDefault();
              e.stopPropagation();
              window.location.assign(url.href);
            }
          } catch { /* best-effort cleanup */ }
        }, true);
      }
    `);
  });

  // Open external URLs in system browser (or browser panel tab when Cmd is held).
  // Allow local URLs as new Electron windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocal(url)) {
      return { action: "allow" };
    }
    if (isHttpUrl(url)) {
      if (metaKeyHeld) {
        openInBrowserTab(url);
      } else {
        shell.openExternal(url);
      }
    }
    return { action: "deny" };
  });

  // Prevent the window from navigating away — open external URLs in the browser instead.
  // When Cmd is held, open in a browser panel tab instead of the system browser.
  win.webContents.on("will-navigate", (event, url) => {
    if (!isLocal(url)) {
      event.preventDefault();
      if (isHttpUrl(url)) {
        if (metaKeyHeld) {
          openInBrowserTab(url);
        } else {
          shell.openExternal(url);
        }
      }
    }
  });

  return win;
}

/** Stop the server as the app quits. It finishes shutting down on its own after the app exits. */
function stopServer(): void {
  stoppingServer = true;
  cancelServerRestart();
  try {
    serverProcess?.kill("SIGTERM");
  } catch {
    // Already dead
  }
  serverProcess = null;
}

/**
 * Squirrel can replace only an app it can write to. One opened straight from the disk image, or
 * one macOS runs from a read-only copy because it was never moved after downloading, cannot be.
 */
function canReplaceAppBundle(): boolean {
  const bundle = path.resolve(app.getPath("exe"), "../../..");
  try {
    fs.accessSync(bundle, fs.constants.W_OK);
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Offer to move an app that could not update itself into /Applications. True when it moved:
 * Electron then quits this copy and launches the moved one, so startup must stop here.
 */
async function offerMoveToApplications(): Promise<boolean> {
  if (process.platform !== "darwin" || !app.isPackaged) return false;
  if (app.isInApplicationsFolder() || canReplaceAppBundle()) return false;
  const { response } = await dialog.showMessageBox({
    type: "question",
    message: "Move Loxel to the Applications folder?",
    detail: "Loxel can install updates only from a folder it can change.",
    buttons: ["Move to Applications", "Not Now"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return false;
  try {
    return app.moveToApplicationsFolder();
  } catch (err) {
    dialog.showErrorBox("Cannot Move Loxel", String(err));
    return false;
  }
}

// --- Custom menu ---
// Replace Electron's default menu to control which accelerators Electron intercepts.
// Cmd+W is left out so the renderer's keybinding system handles it (close tab, not window).

/** Zoom level step of Electron's zoomIn/zoomOut roles; one level is a factor of 1.2. */
const ZOOM_STEP = 0.5;
/** Chromium's zoom range, 25%..500%, as zoom levels. */
const ZOOM_LEVEL_MIN = Math.log(0.25) / Math.log(1.2);
const ZOOM_LEVEL_MAX = Math.log(5) / Math.log(1.2);

/** Zoom the focused window's page by `delta` levels, or reset it when `delta` is null. */
function setAppZoom(delta: number | null): void {
  const contents = BrowserWindow.getFocusedWindow()?.webContents;
  if (!contents) return;
  const next = delta === null ? 0 : contents.getZoomLevel() + delta;
  contents.setZoomLevel(Math.min(ZOOM_LEVEL_MAX, Math.max(ZOOM_LEVEL_MIN, next)));
}

function buildAppMenu(): void {
  const isMac = process.platform === "darwin";

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => {
            openNewWindow();
          },
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        // Not the forceReload role: its ⇧⌘R is Rename Tab, or a focused browser panel's hard refresh,
        // in the renderer, and macOS menus take their keys before the page
        // (`registerAccelerator: false` is ignored there).
        ...(IS_DEV
          ? [
              { role: "reload" as const },
              {
                label: "Force Reload",
                click: () => BrowserWindow.getFocusedWindow()?.webContents.reloadIgnoringCache(),
              },
            ]
          : []),
        { role: "toggleDevTools" },
        { type: "separator" },
        // Not the zoom roles: those act on the focused webContents, which is a browser panel's
        // <webview> whenever one has keyboard focus, so Cmd+/- would zoom that page instead of
        // the app. Always zoom the focused window's own page.
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => setAppZoom(null) },
        { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: () => setAppZoom(ZOOM_STEP) },
        // Cmd+= is the unshifted key of Cmd+Plus; a hidden duplicate makes it work too.
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+=",
          visible: false,
          click: () => setAppZoom(ZOOM_STEP),
        },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => setAppZoom(-ZOOM_STEP) },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      // The window role makes this the app's Windows menu (NSApp.windowsMenu), where macOS adds
      // its window tiling items (Fill, Move & Resize) and their fn⌃ shortcuts. Without it the
      // system shortcuts match no menu item and do nothing.
      role: "window",
      submenu: [{ role: "minimize" }, ...(isMac ? [{ role: "zoom" as const }] : [])],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Webview error handling ---
// Webview navigation can produce ERR_ABORTED (-3) rejections in the main process when a load
// is interrupted (redirects, user navigating away, webview destroyed during layout changes).
// These are benign — suppress them instead of letting them appear as unhandled rejections.
process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error && "errno" in reason && (reason as { errno: number }).errno === -3) {
    return;
  }
  console.error("[electron] Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[electron] Uncaught exception:", err);
});

// --- Webview security ---
// Lock down all web contents (including webviews spawned by pages in the browser panel).
// See: https://www.electronjs.org/docs/latest/tutorial/security#12-verify-webview-options-before-creation
app.on("web-contents-created", (_, contents) => {
  // Track Cmd key state across all webContents (main window + webviews).
  contents.on("before-input-event", (_, input) => {
    if (input.key === "Meta") {
      metaKeyHeld = input.type === "keyDown";
    }
  });
  forwardWebviewKeystrokes(contents);
  trackWebviewDialogs(contents);

  if (contents.getType() === "webview") {
    // New tabs and windows a browser panel's page opens become browser tabs next to it, and its
    // popups child windows. Each webview gets its own webContents, so mainWindow's handler
    // doesn't cover them.
    handleWebviewWindowOpens(contents);
  } else {
    // Never let other web contents create windows: open their links in the system browser
    // (or a browser panel tab when Cmd is held). createWindow replaces this for app windows, and
    // webview-new-tabs.ts for browser panel popups.
    contents.setWindowOpenHandler(({ url }) => {
      if (!isLocal(url) && isHttpUrl(url)) {
        if (metaKeyHeld) {
          openInBrowserTab(url);
        } else {
          shell.openExternal(url);
        }
      }
      return { action: "deny" };
    });
  }

  // Strip dangerous preferences from any dynamically-created webview, then load Loxel's own
  // sandboxed preload (which also runs in subframes, without Node.js).
  contents.on("will-attach-webview", (_, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.contextIsolation = true;
    configureWebviewDialogs(webPreferences);
  });
});

// --- App lifecycle ---

/** The server start in flight, which every caller joins so the app never spawns two servers. */
let serverStarting: Promise<void> | null = null;

/**
 * Start the app's server and wait until it answers, or join the start already in flight. A server
 * already answering on the port that an app started is one a previous run left shutting down (in
 * dev, also the one an Electron that just restarted on a main-process rebuild leaves behind), so
 * launch waits for it to go. Any other server on the port was not started by an app: in dev, a dev
 * server started by hand (`pnpm run dev:server`), which the app uses instead; in production, one
 * from an earlier version or started by hand, which can stay up for minutes, so launch fails.
 */
function startAppServer(): Promise<void> {
  serverStarting ??= (async () => {
    const running = await probeServer();
    if (running && !running.appOwned && !running.shuttingDown) {
      if (IS_DEV) {
        console.log(`[electron] Using the dev server already running on port ${SERVER_PORT}`);
        return;
      }
      throw new Error(
        `A Loxel server this app did not start is running on port ${SERVER_PORT}: one from an earlier version, which shuts down within 5 minutes of its last window closing, or one started by hand. Open Loxel again once it has stopped.`,
      );
    }
    if (running) await waitForServerToStop();
    startServer();
    await waitForServer(SERVER_URL);
  })().finally(() => {
    serverStarting = null;
  });
  return serverStarting;
}

async function waitForServerToStop(): Promise<void> {
  const deadline = Date.now() + STALE_SERVER_WAIT_MS;
  while (await isServerRunning()) {
    if (Date.now() > deadline) {
      throw new Error(
        `Another Loxel server is running on port ${SERVER_PORT}. Quit it, then open Loxel again.`,
      );
    }
    await sleep(250);
  }
}

// macOS: "New Window" in dock right-click menu
if (process.platform === "darwin") {
  app.dock?.setMenu(
    Menu.buildFromTemplate([
      {
        label: "New Window",
        click: () => {
          openNewWindow();
        },
      },
    ]),
  );
}

// Native folder picker — invoked by renderer when running in Electron
ipcMain.handle(OPEN_FOLDER_DIALOG, async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory"],
    title: "Select Project Folder",
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

installWebviewKeystrokeForwarding();
installWebviewCopyImage();
installJavaScriptDialogs();

// Sync so the first render is right: a window can open straight into a fullscreen space.
ipcMain.on(GET_WINDOW_FULL_SCREEN, (event) => {
  event.returnValue = BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false;
});

// macOS: show notification count on dock icon
ipcMain.on(SET_DOCK_BADGE, (_event, count: unknown) => {
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return;
  app.dock?.setBadge(count > 0 ? String(count) : "");
});

// macOS: support native window tabbing (View > Merge All Windows / "+" tab button)
app.on("new-window-for-tab", () => {
  openNewWindow();
});

/**
 * Wait until the server answers. One restarting after a crash is waited for; in dev, a dev server
 * started by hand that has since shut down (it does when idle) is replaced by one this app starts.
 */
async function serverReady(): Promise<void> {
  if (serverStarting) {
    await serverStarting;
    return;
  }
  if (serverProcess || serverRestartTimer || (await isServerRunning())) {
    await waitForServer(SERVER_URL);
    return;
  }
  await startAppServer();
}

/**
 * Open one more window (New Window, a native window tab) once the server answers. Before startup
 * has opened the first window there is nothing to add to: startup opens it.
 */
function openNewWindow(): void {
  if (launchPaths !== null) return;
  serverReady()
    .then(() => createWindow())
    .catch((err: unknown) => dialog.showErrorBox("Cannot Open a Window", String(err)));
}

let windowStarting: Promise<void> | null = null;

/**
 * Open a window if none is (macOS keeps running with all windows closed), once the server answers:
 * it may be restarting after a crash. Concurrent callers share the one window.
 */
function ensureWindow(): Promise<void> {
  if (BrowserWindow.getAllWindows().length > 0) return Promise.resolve();
  windowStarting ??= (async () => {
    await serverReady();
    await createWindow();
  })().finally(() => {
    windowStarting = null;
  });
  return windowStarting;
}

// --- Files and folders opened with Loxel ---
// macOS hands the app files and folders opened with it (Finder "Open With", drops on the Dock
// icon, `open -a Loxel <path>`) as open-file events. Those that launch the app arrive before it is
// ready, so they wait for the startup window. The server sends each to the window in use.

/** Paths received before the startup window exists; null once it does. */
let launchPaths: string[] | null = [];
/** Opens run one at a time so several files open in the order macOS sent them. */
let openQueue = Promise.resolve();

function openPathFromOS(filePath: string): void {
  openQueue = openQueue.then(async () => {
    try {
      await ensureWindow();
      await requestOpen(SERVER_URL, { filePath });
    } catch (err) {
      console.error(`[electron] Failed to open ${filePath}:`, err);
      void dialog.showMessageBox({
        type: "error",
        message: `Cannot open ${path.basename(filePath)}`,
        detail: `${filePath}\n\n${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (launchPaths) launchPaths.push(filePath);
  else openPathFromOS(filePath);
});

/** The window showing a webview frame, or the best guess once the frame is gone. */
function windowForFrame(frame: WebFrameMain | null): BrowserWindow | undefined {
  const contents = frame ? webContents.fromFrame(frame) : undefined;
  const host = contents?.hostWebContents ?? contents;
  return (
    (host && BrowserWindow.fromWebContents(host)) ??
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows()[0]
  );
}

/** The browser panel showing a frame: its webview and the window renderer hosting it. */
function browserPanelFrame(frame: WebFrameMain): BrowserPanelFrame | null {
  const contents = webContents.fromFrame(frame);
  const host = contents?.hostWebContents;
  if (!contents || !host) return null;
  return {
    webContentsId: contents.id,
    send: (channel, payload) => {
      if (!host.isDestroyed()) host.send(channel, payload);
    },
    isGone: () => contents.isDestroyed(),
    onGone: (callback) => {
      contents.once("destroyed", callback);
      return () => contents.removeListener("destroyed", callback);
    },
  };
}

/** Ask which passkey to use when a site matches several. */
async function promptForAccount(
  frame: WebFrameMain | null,
  relyingPartyId: string,
  labels: string[],
): Promise<number | null> {
  const win = windowForFrame(frame);
  const options: Electron.MessageBoxOptions = {
    type: "question",
    title: "Choose a passkey",
    message: `Which account do you want to use for ${relyingPartyId}?`,
    buttons: [...labels, "Cancel"],
    cancelId: labels.length,
  };
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return response < labels.length ? response : null;
}

// One Electron process per installed app: it owns the server, and Squirrel can replace only a bundle
// no other process runs from. A second launch (`open -n`, or the binary run directly) hands over and
// exits. Packaged builds only: vite-plugin-electron starts a rebuilt dev Electron before the old
// one has exited, which a lock would turn into a quit.
// A dev run keeps its own data directory (Chromium profile and cookies): sharing the installed
// app's while both run makes their databases lock each other and breaks sites in browser panels.
if (IS_DEV) app.setPath("userData", `${app.getPath("userData")}-dev`);
// A demo keeps its data directory apart, so its lock, cookies and settings don't meet the app's.
if (IS_DEMO)
  app.setPath(
    "userData",
    `${app.getPath("userData")} Demo${DEMO_INSTANCE ? ` ${DEMO_INSTANCE}` : ""}`,
  );
// A hidden demo is a background app: no Dock icon, no menu bar, never activated.
if (IS_DEMO_HIDDEN) app.setActivationPolicy("accessory");
const isPrimaryInstance = !app.isPackaged || app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();

/**
 * Tell the user that Loxel could not start or open its window. A hidden demo has no one to read a
 * dialog, and a modal one would wait forever for a click its driver can't send: it logs the error
 * and exits instead, which its driver sees.
 */
function showStartupError(err: unknown): void {
  if (!IS_DEMO_HIDDEN) {
    dialog.showErrorBox("Startup Error", String(err));
    return;
  }
  console.error("[electron] Startup error:", err);
  stopServer();
  app.exit(1);
}

app.on("second-instance", () => {
  // Startup opens the first window; until it has, there is nothing to show.
  if (launchPaths !== null) return;
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win) {
    ensureWindow().catch(showStartupError);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
});

installAppUpdater();

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return;
  try {
    if (await offerMoveToApplications()) return;
    // Every server spawn reads the key synchronously, so load it before the first one.
    if (!IS_DEMO) await initDek();
    await startAppServer();

    // After `ready`: with a prompt reason, configureWebAuthn writes to Chromium's
    // resource bundle, which only exists once the browser process has started.
    // A no-op unless this is a provisioned macOS build.
    const passkeysEnabled = configurePasskeys({
      platform: process.platform,
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      configureWebAuthn: (options) => app.configureWebAuthn(options),
    });
    if (passkeysEnabled) console.log("[electron] Passkeys enabled for browser panels");
    const browserSession = session.fromPartition(BROWSER_PARTITION);
    installAccountChooser(browserSession, promptForAccount);
    installHybridQrCode(browserSession, browserPanelFrame);
    // Installed fonts are for Loxel's own window (the font pickers), never for browser panels.
    session.defaultSession.setPermissionCheckHandler(localFontsCheckHandler(isLocal));
    browserSession.setPermissionCheckHandler(localFontsCheckHandler(() => false));

    buildAppMenu();
    await createWindow();
    const pathsOpenedAtLaunch = launchPaths;
    launchPaths = null;
    for (const filePath of pathsOpenedAtLaunch ?? []) openPathFromOS(filePath);
    startMainProcessMonitor(SERVER_URL);
    if (!IS_DEMO) scheduleAutomaticUpdateCheck(SERVER_URL);

    // On macOS, clicking the dock icon after all windows are closed re-activates.
    app.on("activate", () => {
      ensureWindow().catch(showStartupError);
    });
  } catch (err) {
    showStartupError(err);
    stopServer();
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

/** How long quitting waits for the windows' layout promotes to reach the server. */
const QUIT_PROMOTE_WAIT_MS = 2000;
let promotesSettledForQuit = false;

// The server lives as long as the app. Windows are closed by now, and each sent its layout promote
// on close; quitting waits for those before stopping the server, which then finishes the API
// requests it has received before exiting. Not while Squirrel quits to install an update: a promote
// that did not land is recovered when the next server starts.
app.on("will-quit", (event) => {
  if (promotesSettledForQuit || pendingPromotes.size === 0 || isInstallingUpdate()) {
    stopServer();
    return;
  }
  event.preventDefault();
  promotesSettledForQuit = true;
  void Promise.race([Promise.allSettled(pendingPromotes), sleep(QUIT_PROMOTE_WAIT_MS)]).then(() =>
    app.quit(),
  );
});
