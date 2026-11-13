/**
 * Loxel as the default web browser. `electron-builder.yml` declares the http and https URL
 * schemes, so macOS lists Loxel among the browsers it can make the default; Settings shows whether
 * it is and offers to make it so, which macOS confirms with its own prompt. Links then arrive as
 * `open-url` events (`main.ts`).
 */
import { app, ipcMain } from "electron";

import type { DefaultBrowserStatus } from "../api/default-browser-model";
import { DEFAULT_BROWSER_GET, DEFAULT_BROWSER_SET } from "./ipc-channels";

const WEB_SCHEMES = ["http", "https"] as const;

function defaultBrowserStatus(): DefaultBrowserStatus {
  const canSet = process.platform === "darwin" && app.isPackaged;
  return {
    canSet,
    isDefault: canSet && WEB_SCHEMES.every((scheme) => app.isDefaultProtocolClient(scheme)),
  };
}

export function installDefaultBrowser(): void {
  ipcMain.handle(DEFAULT_BROWSER_GET, () => defaultBrowserStatus());
  // macOS asks the user to confirm and answers later, so the status returned may not show it yet;
  // the renderer reads it again when its window is focused after the prompt.
  ipcMain.handle(DEFAULT_BROWSER_SET, () => {
    if (defaultBrowserStatus().canSet) {
      for (const scheme of WEB_SCHEMES) app.setAsDefaultProtocolClient(scheme);
    }
    return defaultBrowserStatus();
  });
}
