import { Menu, app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IS_DEV = !!process.env.VITE_DEV_SERVER_URL;
const SERVER_PORT = IS_DEV ? 7434 : 7433;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

/** External resources directory — updated versions live here instead of inside the .app bundle. */
const EXTERNAL_RESOURCES = path.join(os.homedir(), ".local", "share", "loxel", "loxel");
const UPDATES_DIR = path.join(os.homedir(), ".local", "state", "loxel", "loxel", "updates");

let serverProcess: ChildProcess | null = null;

/** Whether this Electron process spawned the server (and should handle updates). */
let isServerOwner = false;

/** Whether the Cmd (Meta) key is currently held. Tracked via before-input-event on all webContents. */
let metaKeyHeld = false;

import {
  OPEN_FOLDER_DIALOG,
  OPEN_IN_BROWSER_TAB,
  SET_DOCK_BADGE,
  WINDOW_FOCUS_CHANGE,
} from "./ipc-channels";
import { startMainProcessMonitor } from "./main-perf-monitor";

/** Send a URL to the focused window's renderer to open in a browser panel tab. */
function openInBrowserTab(url: string): void {
  BrowserWindow.getFocusedWindow()?.webContents.send(OPEN_IN_BROWSER_TAB, url);
}

/** Check if a loxel server is already running on the well-known port. */
async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER_URL}/api/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA !== numB) return numA - numB;
  }
  return 0;
}

/** Resolve server binary and renderer paths. Prefer external resources only when newer than bundled. */
function getServerPaths(): { serverBin: string; rendererDir: string } {
  if (!IS_DEV) {
    const extServer = path.join(EXTERNAL_RESOURCES, "loxel-server");
    const extRenderer = path.join(EXTERNAL_RESOURCES, "renderer");
    const extVersionFile = path.join(EXTERNAL_RESOURCES, "version");
    if (fs.existsSync(extServer) && fs.existsSync(extRenderer) && fs.existsSync(extVersionFile)) {
      try {
        const extVersion = fs.readFileSync(extVersionFile, "utf-8").trim();
        if (compareVersions(extVersion, app.getVersion()) > 0) {
          return { serverBin: extServer, rendererDir: extRenderer };
        }
        console.log(
          `[electron] Ignoring external resources (v${extVersion}) — bundled v${app.getVersion()} is newer or equal`,
        );
      } catch {
        console.warn("[electron] Failed to read version file, falling back to bundled resources");
      }
    }
  }
  return {
    serverBin: path.join(process.resourcesPath, "loxel-server"),
    rendererDir: path.join(process.resourcesPath, "renderer"),
  };
}

function startServer(): void {
  if (IS_DEV) {
    // In dev, spawn bun running the server source directly
    serverProcess = spawn("bun", ["run", "src/server/index.ts"], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: { ...process.env, LOXEL_DEV: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    // In production, spawn the server binary (external or bundled)
    const { serverBin, rendererDir } = getServerPaths();
    serverProcess = spawn(serverBin, [], {
      env: {
        ...process.env,
        LOXEL_STATIC_DIR: rendererDir,
        LOXEL_RESOURCES_DIR: EXTERNAL_RESOURCES,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  serverProcess.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(data);
  });
  serverProcess.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(data);
  });
  serverProcess.on("exit", (code) => {
    console.log(`[electron] Server exited with code ${code}`);
    serverProcess = null;

    // Exit code 42 signals an update is ready to install
    if (code === 42 && !IS_DEV) {
      handlePendingUpdateSync();
      return;
    }

    // Server failed to start (e.g., EADDRINUSE from spawn race) — drop ownership
    if (isServerOwner && code !== 0) {
      isServerOwner = false;
    }
  });
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

const APP_ORIGIN = new URL(process.env.VITE_DEV_SERVER_URL ?? SERVER_URL).origin;

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
    width: 1400,
    height: 900,
    title: "Loxel",
    titleBarStyle: "hiddenInset",
    tabbingIdentifier: "loxel",
    trafficLightPosition: { x: 12, y: 9 },
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

  const loadUrl = process.env.VITE_DEV_SERVER_URL ?? SERVER_URL;
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
    if (metaKeyHeld) {
      openInBrowserTab(url);
    } else {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Prevent the window from navigating away — open external URLs in the browser instead.
  // When Cmd is held, open in a browser panel tab instead of the system browser.
  win.webContents.on("will-navigate", (event, url) => {
    if (!isLocal(url)) {
      event.preventDefault();
      if (metaKeyHeld) {
        openInBrowserTab(url);
      } else {
        shell.openExternal(url);
      }
    }
  });

  return win;
}

function killServer(): void {
  if (serverProcess) {
    try {
      serverProcess.kill("SIGTERM");
    } catch {
      // Already dead
    }
    serverProcess = null;
  }
}

// --- Update handling ---

interface PendingUpdate {
  version: string;
  archivePath: string;
  targetDir: string;
  sha256: string;
}

/** Parse and validate pending.json contents at runtime. */
function parsePendingUpdate(raw: string): PendingUpdate {
  const data: unknown = JSON.parse(raw);
  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as Record<string, unknown>).version !== "string" ||
    typeof (data as Record<string, unknown>).archivePath !== "string" ||
    typeof (data as Record<string, unknown>).targetDir !== "string" ||
    typeof (data as Record<string, unknown>).sha256 !== "string"
  ) {
    throw new Error("Invalid pending.json: missing or invalid fields");
  }
  return data as PendingUpdate;
}

/** Compute SHA256 hash of a file synchronously. */
function sha256File(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Apply a pending update after the server exits with code 42.
 * All operations are synchronous to avoid race conditions with Electron lifecycle events.
 */
function handlePendingUpdateSync(): void {
  const pendingPath = path.join(UPDATES_DIR, "pending.json");
  const backupDir = path.join(UPDATES_DIR, "backup");

  try {
    if (!fs.existsSync(pendingPath)) {
      console.error("[electron] No pending.json found after exit code 42");
      startServer();
      return;
    }

    const pending = parsePendingUpdate(fs.readFileSync(pendingPath, "utf-8"));
    const { archivePath, targetDir, sha256 } = pending;

    if (!fs.existsSync(archivePath)) {
      throw new Error(`Archive not found: ${archivePath}`);
    }

    // Re-verify archive integrity before extraction (closes TOCTOU window)
    const actualHash = sha256File(archivePath);
    if (actualHash !== sha256) {
      throw new Error(`Archive integrity check failed: expected ${sha256}, got ${actualHash}`);
    }

    console.log(`[electron] Installing update v${pending.version}...`);

    // Backup current resources (if they exist)
    fs.mkdirSync(backupDir, { recursive: true });
    for (const file of [
      "loxel-server",
      "yaml-language-server",
      "docker-language-server",
      "terraform-ls",
      "version",
    ]) {
      const src = path.join(targetDir, file);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, file));
    }
    const rendererDir = path.join(targetDir, "renderer");
    if (fs.existsSync(rendererDir)) {
      fs.cpSync(rendererDir, path.join(backupDir, "renderer"), { recursive: true });
    }
    const tsgoLibDir = path.join(targetDir, "tsgo-lib");
    if (fs.existsSync(tsgoLibDir)) {
      fs.cpSync(tsgoLibDir, path.join(backupDir, "tsgo-lib"), { recursive: true });
    }

    // Delete old renderer/ and tsgo-lib/ so stale files from previous build don't persist
    if (fs.existsSync(rendererDir)) {
      fs.rmSync(rendererDir, { recursive: true });
    }
    if (fs.existsSync(tsgoLibDir)) {
      fs.rmSync(tsgoLibDir, { recursive: true });
    }
    fs.mkdirSync(targetDir, { recursive: true });

    // Extract archive (use execFileSync to avoid shell injection)
    execFileSync("tar", ["xzf", archivePath, "-C", targetDir]);

    // Sign binaries on macOS
    if (process.platform === "darwin") {
      const signTargets = [
        path.join(targetDir, "loxel-server"),
        path.join(targetDir, "yaml-language-server"),
        path.join(targetDir, "docker-language-server"),
        path.join(targetDir, "terraform-ls"),
        path.join(targetDir, "tsgo-lib/tsgo"),
      ];
      for (const binPath of signTargets) {
        if (!fs.existsSync(binPath)) continue;
        try {
          execFileSync("codesign", ["-s", "-", "-f", binPath]);
        } catch {
          // Non-fatal — ad-hoc signing may fail but the binary can still run
          console.warn(`[electron] Ad-hoc code signing failed for ${binPath} (non-fatal)`);
        }
      }
    }

    // Ensure executables
    for (const bin of [
      "loxel-server",
      "yaml-language-server",
      "docker-language-server",
      "terraform-ls",
      "tsgo-lib/tsgo",
    ]) {
      const binPath = path.join(targetDir, bin);
      if (fs.existsSync(binPath)) fs.chmodSync(binPath, 0o755);
    }

    // Write version marker so getServerPaths() can compare versions
    fs.writeFileSync(path.join(targetDir, "version"), pending.version);

    // Clean up pending marker and archive (keep backup until next successful startup)
    fs.unlinkSync(pendingPath);
    try {
      fs.unlinkSync(archivePath);
    } catch (err) {
      console.error("[electron] Failed to clean up archive:", err);
    }

    console.log(`[electron] Update v${pending.version} installed, relaunching...`);
    app.relaunch();
    app.exit(0);
  } catch (err) {
    console.error("[electron] Update failed:", err);

    // Restore from backup
    try {
      if (fs.existsSync(pendingPath)) {
        const { targetDir } = parsePendingUpdate(fs.readFileSync(pendingPath, "utf-8"));
        for (const file of [
          "loxel-server",
          "yaml-language-server",
          "docker-language-server",
          "terraform-ls",
          "version",
        ]) {
          const backup = path.join(backupDir, file);
          if (fs.existsSync(backup)) fs.copyFileSync(backup, path.join(targetDir, file));
        }
        for (const dir of ["renderer", "tsgo-lib"]) {
          const backup = path.join(backupDir, dir);
          if (!fs.existsSync(backup)) continue;
          const dest = path.join(targetDir, dir);
          if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
          fs.cpSync(backup, dest, { recursive: true });
        }
      }
    } catch (restoreErr) {
      console.error("[electron] Failed to restore backup:", restoreErr);
    }

    // Delete pending.json to prevent boot loop
    try {
      fs.unlinkSync(pendingPath);
    } catch (err) {
      console.error("[electron] Failed to clean up pending marker:", err);
    }

    dialog.showErrorBox("Update Failed", `Failed to install update: ${err}`);

    // Restart server with old version
    startServer();
  }
}

/** Clean up leftover backup from a previously successful update. */
function cleanupUpdateBackup(): void {
  const backupDir = path.join(UPDATES_DIR, "backup");
  if (fs.existsSync(backupDir)) {
    try {
      fs.rmSync(backupDir, { recursive: true });
      console.log("[electron] Cleaned up update backup");
    } catch (err) {
      console.error("[electron] Failed to clean up backup:", err);
    }
  }
}

// --- Custom menu ---
// Replace Electron's default menu to control which accelerators Electron intercepts.
// Cmd+W is left out so the renderer's keybinding system handles it (close tab, not window).

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
            void createWindow();
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
        ...(IS_DEV ? [{ role: "reload" as const }, { role: "forceReload" as const }] : []),
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
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

  // Redirect window.open() from webview contents to the system browser
  // (or browser panel tab when Cmd is held).
  // Each webview gets its own webContents, so mainWindow's handler doesn't cover them.
  contents.setWindowOpenHandler(({ url }) => {
    if (!isLocal(url)) {
      if (metaKeyHeld) {
        openInBrowserTab(url);
      } else {
        shell.openExternal(url);
      }
    }
    return { action: "deny" };
  });

  // Strip dangerous preferences from any dynamically-created webview.
  contents.on("will-attach-webview", (_, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
  });
});

// --- App lifecycle ---

/** Ensure the shared server is running, spawning it if needed. */
async function ensureServer(): Promise<void> {
  const running = await isServerRunning();
  if (running) return;

  // If a pending update exists (left by a previous server exit code 42 whose owner
  // Electron already quit), apply it before spawning the new server. This ensures
  // updates are installed regardless of which Electron process spawns next.
  if (!IS_DEV) {
    const pendingPath = path.join(UPDATES_DIR, "pending.json");
    if (fs.existsSync(pendingPath)) {
      handlePendingUpdateSync();
      // handlePendingUpdateSync may relaunch the app — if it didn't,
      // the update either failed or there was no archive, so continue to spawn.
    }
  }

  startServer();
  isServerOwner = true;

  // Wait for the Bun server to be ready before creating the window.
  // In dev, vite proxies /api and /ws to this server.
  await waitForServer(SERVER_URL);

  // If our server process died during waitForServer but the port is up
  // (another instance won the spawn race), we're not the owner.
  if (!serverProcess) isServerOwner = false;

  // Server started successfully — clean up backup from any previous update
  if (isServerOwner) cleanupUpdateBackup();
}

// macOS: "New Window" in dock right-click menu
if (process.platform === "darwin") {
  app.dock?.setMenu(
    Menu.buildFromTemplate([
      {
        label: "New Window",
        click: () => {
          void createWindow();
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

// macOS: show notification count on dock icon
ipcMain.on(SET_DOCK_BADGE, (_event, count: unknown) => {
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return;
  app.dock?.setBadge(count > 0 ? String(count) : "");
});

// macOS: support native window tabbing (View > Merge All Windows / "+" tab button)
app.on("new-window-for-tab", () => {
  void createWindow();
});

/** When we didn't spawn the server, poll for liveness so we can recover if it dies. */
function startServerHealthCheck(): void {
  setInterval(async () => {
    if (isServerOwner) return; // owner has the exit handler, no need to poll
    if (await isServerRunning()) return;

    console.log("[electron] Server unreachable (non-owner), attempting recovery...");
    try {
      await ensureServer();
      // Server is back — reload all windows so they connect to the fresh server
      for (const win of BrowserWindow.getAllWindows()) {
        win.reload();
      }
    } catch (err) {
      console.error("[electron] Server recovery failed:", err);
    }
  }, 5000);
}

app.whenReady().then(async () => {
  try {
    await ensureServer();

    buildAppMenu();
    await createWindow();
    startMainProcessMonitor(SERVER_URL);

    // If we didn't spawn the server, monitor it so we can recover from unexpected death
    if (!isServerOwner) startServerHealthCheck();

    // On macOS, clicking the dock icon after all windows are closed re-activates.
    // The server may have shut down via idle timer, so ensure it's running first.
    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        try {
          await ensureServer();
          await createWindow();
        } catch (err) {
          dialog.showErrorBox("Startup Error", String(err));
        }
      }
    });
  } catch (err) {
    dialog.showErrorBox("Startup Error", String(err));
    if (isServerOwner) killServer();
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  // Server self-terminates via idle shutdown when all clients disconnect.
  // Don't kill it here — other Electron windows may still be connected.
});
