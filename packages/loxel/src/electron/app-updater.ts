/**
 * Full-app updates through electron-updater: check the release manifest, download the new app's
 * zip, and let Squirrel.Mac replace the bundle and relaunch. Main keeps the `UpdateState` and
 * sends it to every window; the renderer drives it from Settings > General.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import { z } from "zod";

import type { UpdateState } from "../api/update-model";
import { isAutoCheckEnabled, SETTINGS_STORE_KEY } from "../server/persisted-settings";
import {
  UPDATE_CHECK,
  UPDATE_DOWNLOAD,
  UPDATE_GET_STATUS,
  UPDATE_INSTALL,
  UPDATE_STATUS_CHANGED,
} from "./ipc-channels";
import { ManifestProvider } from "./update-manifest";

/** How long after launch the automatic check runs. */
const AUTO_CHECK_DELAY_MS = 5000;

let status: UpdateState = { state: "idle" };

function setStatus(next: UpdateState): void {
  status = next;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(UPDATE_STATUS_CHANGED, next);
  }
}

/** The first line of an updater error: electron-updater appends stack traces and response bodies. */
function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n", 1)[0] ?? message;
}

async function checkForUpdates(): Promise<void> {
  if (status.state === "checking" || status.state === "downloading") return;
  if (status.state === "installing") return;
  if (!app.isPackaged) {
    setStatus({ state: "error", message: "Updates work only in the installed app" });
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // The updater's error event already set the status.
    console.error("[updater] Update check failed:", err);
  }
}

async function downloadUpdate(): Promise<void> {
  if (status.state !== "available") return;
  setStatus({ state: "downloading", version: status.version, percent: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    console.error("[updater] Update download failed:", err);
  }
}

function installUpdate(): void {
  if (status.state !== "ready") return;
  setStatus({ state: "installing" });
  // Hands the zip to Squirrel.Mac, which replaces the app once it has quit and relaunches it.
  // A failure (for example an app it cannot write to) arrives as an error event.
  autoUpdater.quitAndInstall();
}

/** Whether Install & Restart is under way: Squirrel is quitting the app to replace it. */
export function isInstallingUpdate(): boolean {
  return status.state === "installing";
}

/** Set up the updater and the IPC the renderer drives it with. Call once, at startup. */
export function installAppUpdater(): void {
  autoUpdater.logger = {
    info: (message: unknown) => console.log("[updater]", message),
    warn: (message: unknown) => console.warn("[updater]", message),
    error: (message: unknown) => console.error("[updater]", message),
  };
  autoUpdater.autoDownload = false;
  // Install only when the user picks Install & Restart, never on an ordinary quit.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.setFeedURL({ provider: "custom", updateProvider: ManifestProvider });

  autoUpdater.on("checking-for-update", () => setStatus({ state: "checking" }));
  autoUpdater.on("update-available", (info) =>
    setStatus({ state: "available", version: info.version, releasedAt: info.releaseDate }),
  );
  autoUpdater.on("update-not-available", () => setStatus({ state: "idle" }));
  autoUpdater.on("download-progress", (progress) => {
    if (status.state !== "downloading") return;
    const percent = Math.floor(progress.percent);
    if (percent !== status.percent) setStatus({ ...status, percent });
  });
  autoUpdater.on("update-downloaded", (info) =>
    setStatus({ state: "ready", version: info.version }),
  );
  autoUpdater.on("error", (err) => setStatus({ state: "error", message: errorMessage(err) }));

  ipcMain.handle(UPDATE_GET_STATUS, () => status);
  ipcMain.handle(UPDATE_CHECK, () => checkForUpdates());
  ipcMain.handle(UPDATE_DOWNLOAD, () => downloadUpdate());
  ipcMain.on(UPDATE_INSTALL, () => installUpdate());
}

const StoreRowSchema = z.object({ value: z.string().nullable() });

/** The persisted settings row, read from the server that stores it. */
async function readSettingsRow(serverUrl: string): Promise<string | null> {
  const res = await fetch(`${serverUrl}/api/stores/${SETTINGS_STORE_KEY}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return StoreRowSchema.parse(await res.json()).value;
}

/**
 * The check the app runs on its own shortly after launch, unless "Check for updates automatically"
 * is off. The setting is read when the check is due, so turning it off right after launch counts.
 */
export function scheduleAutomaticUpdateCheck(serverUrl: string): void {
  if (!app.isPackaged) return;
  setTimeout(() => {
    void (async () => {
      let raw: string | null;
      try {
        raw = await readSettingsRow(serverUrl);
      } catch (err) {
        console.error("[updater] Skipping the automatic update check: cannot read settings", err);
        return;
      }
      if (!isAutoCheckEnabled(raw)) {
        console.log("[updater] Automatic update check is turned off");
        return;
      }
      await checkForUpdates();
    })();
  }, AUTO_CHECK_DELAY_MS);
}
