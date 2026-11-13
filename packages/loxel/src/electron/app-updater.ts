/**
 * Full-app updates through electron-updater: check the release manifest, download the new app's
 * zip, and let Squirrel.Mac replace the bundle and relaunch. Main keeps the `UpdateState` and
 * sends it to every window; the renderer drives it from Settings > General.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";

import type { RestartsTerminals, UpdateState } from "../api/update-model";
import type { ShutdownTerminals } from "../parent-channel-protocol";
import { isAutoCheckEnabled } from "../server/persisted-settings";
import {
  UPDATE_CHECK,
  UPDATE_DOWNLOAD,
  UPDATE_GET_STATUS,
  UPDATE_INSTALL,
  UPDATE_STATUS_CHANGED,
} from "./ipc-channels";
import { readSettingsRow } from "./settings-row";
import { ManifestProvider, terminalHostProtocolOf } from "./update-manifest";
import { terminalsForInstall, updateRestartsTerminals } from "./update-terminals";

/** How long after launch the automatic check runs. */
const AUTO_CHECK_DELAY_MS = 5000;

let status: UpdateState = { state: "idle" };
/** What the update found by the latest check does to the terminals, for when it is downloaded. */
let found: { version: string; restartsTerminals: RestartsTerminals } | null = null;
/** What the install under way does to the terminals, once Install & Restart is chosen. */
let installTerminals: ShutdownTerminals | null = null;

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
  installTerminals = terminalsForInstall(status.restartsTerminals);
  console.log(`[updater] Installing ${status.version}; terminals: ${installTerminals}`);
  setStatus({ state: "installing" });
  // Hands the zip to Squirrel.Mac, which replaces the app once it has quit and relaunches it.
  // A failure (for example an app it cannot write to) arrives as an error event.
  autoUpdater.quitAndInstall();
}

/** Whether Install & Restart is under way: Squirrel is quitting the app to replace it. */
export function isInstallingUpdate(): boolean {
  return status.state === "installing";
}

/**
 * What installing the downloaded update does to the terminals. They keep running, and the new
 * version's server reattaches them, since the terminal host they run in is not part of the app
 * bundle; unless the update's terminal host protocol has another major version, which its server
 * cannot talk to: then they end (see update-terminals.ts).
 */
export function terminalsForUpdateInstall(): ShutdownTerminals {
  return installTerminals ?? "keep";
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
  autoUpdater.on("update-available", (info) => {
    const restartsTerminals = updateRestartsTerminals(terminalHostProtocolOf(info));
    found = { version: info.version, restartsTerminals };
    setStatus({
      state: "available",
      version: info.version,
      releasedAt: info.releaseDate,
      restartsTerminals,
    });
  });
  autoUpdater.on("update-not-available", () => setStatus({ state: "idle" }));
  autoUpdater.on("download-progress", (progress) => {
    if (status.state !== "downloading") return;
    const percent = Math.floor(progress.percent);
    if (percent !== status.percent) setStatus({ ...status, percent });
  });
  autoUpdater.on("update-downloaded", (info) => {
    // The download is of the update the check found; should it not be, nothing is known about it.
    const restartsTerminals =
      found?.version === info.version ? found.restartsTerminals : ("unknown" as const);
    setStatus({ state: "ready", version: info.version, restartsTerminals });
  });
  autoUpdater.on("error", (err) => {
    installTerminals = null;
    setStatus({ state: "error", message: errorMessage(err) });
  });

  ipcMain.handle(UPDATE_GET_STATUS, () => status);
  ipcMain.handle(UPDATE_CHECK, () => checkForUpdates());
  ipcMain.handle(UPDATE_DOWNLOAD, () => downloadUpdate());
  ipcMain.on(UPDATE_INSTALL, () => installUpdate());
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
