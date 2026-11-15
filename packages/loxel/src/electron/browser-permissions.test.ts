import { describe, expect, mock, test } from "bun:test";

import type { Session } from "electron";

import {
  type BrowserPermission,
  browserPermissionGranted,
  installBrowserPermissions,
} from "./browser-permissions";

type CheckHandler = Parameters<Session["setPermissionCheckHandler"]>[0];
type RequestHandler = Parameters<Session["setPermissionRequestHandler"]>[0];

/** The handlers `installBrowserPermissions` gives a session. */
function installedHandlers(): {
  check: NonNullable<CheckHandler>;
  request: NonNullable<RequestHandler>;
} {
  let check: CheckHandler = null;
  let request: RequestHandler = null;
  const browserSession = {
    setPermissionCheckHandler: (handler: CheckHandler) => {
      check = handler;
    },
    setPermissionRequestHandler: (handler: RequestHandler) => {
      request = handler;
    },
  };
  installBrowserPermissions(browserSession);
  if (!check || !request) throw new Error("installBrowserPermissions set no handler");
  return { check, request };
}

const ALLOWED: BrowserPermission[] = [
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
  "fileSystem",
  "openExternal",
];

const REFUSED: BrowserPermission[] = [
  "notifications",
  "geolocation",
  "geolocation-approximate",
  "media",
  "display-capture",
  "midi",
  "midiSysex",
  "clipboard-read",
  "deprecated-sync-clipboard-read",
  "local-fonts",
  "window-management",
  "idle-detection",
  "persistent-storage",
  "screen-wake-lock",
  "automatic-fullscreen",
  "keyboardLock",
  "storage-access",
  "hid",
  "serial",
  "usb",
  "unknown",
];

describe("browserPermissionGranted", () => {
  test("grants the allowlist", () => {
    for (const permission of ALLOWED) expect(browserPermissionGranted(permission)).toBe(true);
  });

  test("refuses everything else", () => {
    for (const permission of REFUSED) expect(browserPermissionGranted(permission)).toBe(false);
  });

  test("refuses a permission name a newer Electron adds", () => {
    expect(browserPermissionGranted("some-new-permission" as BrowserPermission)).toBe(false);
  });
});

describe("installBrowserPermissions", () => {
  const { check, request } = installedHandlers();

  test("checks report the policy", () => {
    expect(check(null, "notifications", "https://example.com/", { isMainFrame: true })).toBe(false);
    expect(check(null, "fullscreen", "https://example.com/", { isMainFrame: false })).toBe(true);
  });

  test("requests are answered with the policy", () => {
    const webContents = {} as Parameters<typeof request>[0];
    const details = { isMainFrame: true, requestingUrl: "https://example.com/" };
    const callback = mock((_granted: boolean) => {});
    request(webContents, "geolocation", callback, details);
    request(webContents, "clipboard-sanitized-write", callback, details);
    expect(callback.mock.calls).toEqual([[false], [true]]);
  });
});
