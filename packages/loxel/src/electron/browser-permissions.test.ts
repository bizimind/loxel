import { describe, expect, mock, test } from "bun:test";

import type { Session } from "electron";

import {
  type BrowserPermission,
  browserPermissionGranted,
  installBrowserPermissions,
} from "./browser-permissions";

type CheckHandler = Parameters<Session["setPermissionCheckHandler"]>[0];
type RequestHandler = Parameters<Session["setPermissionRequestHandler"]>[0];

/** What the camera and microphone module was handed, standing in for `browser-media.ts`. */
const mediaCheck = mock((..._args: unknown[]) => true);
const mediaRequest = mock((..._args: unknown[]) => {});

/** The handlers `installBrowserPermissions` gives a session. */
function installedHandlers(): {
  check: NonNullable<CheckHandler>;
  request: NonNullable<RequestHandler>;
} {
  let check: CheckHandler = null;
  let request: RequestHandler = null;
  installBrowserPermissions(
    {
      setPermissionCheckHandler: (handler) => {
        check = handler;
      },
      setPermissionRequestHandler: (handler) => {
        request = handler;
      },
    },
    { check: mediaCheck, request: mediaRequest },
  );
  if (!check || !request) throw new Error("installBrowserPermissions set no handler");
  return { check, request };
}

/**
 * What a page's own (main) frame gets, for every permission Electron names. A name a new Electron
 * adds fails the typecheck here until it is decided.
 */
const MAIN_FRAME: Record<BrowserPermission, boolean> = {
  "clipboard-sanitized-write": true,
  fileSystem: true,
  fullscreen: true,
  keyboardLock: true,
  openExternal: true,
  pointerLock: true,
  "screen-wake-lock": true,

  ar: false,
  "automatic-fullscreen": false,
  "background-fetch": false,
  "background-sync": false,
  "captured-surface-control": false,
  "clipboard-read": false,
  "deprecated-sync-clipboard-read": false,
  "display-capture": false,
  geolocation: false,
  "geolocation-approximate": false,
  "hand-tracking": false,
  hid: false,
  "idle-detection": false,
  "local-fonts": false,
  "local-network": false,
  "local-network-access": false,
  "loopback-network": false,
  media: false,
  mediaKeySystem: false,
  midi: false,
  midiSysex: false,
  nfc: false,
  notifications: false,
  "payment-handler": false,
  "periodic-background-sync": false,
  "persistent-storage": false,
  sensors: false,
  serial: false,
  "smart-card": false,
  "speaker-selection": false,
  "storage-access": false,
  "system-wake-lock": false,
  "top-level-storage-access": false,
  unknown: false,
  usb: false,
  vr: false,
  "web-app-installation": false,
  "web-printing": false,
  "window-management": false,
};

const PERMISSIONS = Object.keys(MAIN_FRAME) as BrowserPermission[];

/** Each permission with its decision, so a failure names the permission. */
const decisions = (isMainFrame: boolean) =>
  PERMISSIONS.map((permission) => [
    permission,
    browserPermissionGranted(permission, { isMainFrame }),
  ]);

describe("browserPermissionGranted", () => {
  test("decides every permission for a page's own frame", () => {
    expect(decisions(true)).toEqual(PERMISSIONS.map((p) => [p, MAIN_FRAME[p]]));
  });

  test("embedded frames get the same, except links to other apps", () => {
    expect(decisions(false)).toEqual(
      PERMISSIONS.map((p) => [p, p === "openExternal" ? false : MAIN_FRAME[p]]),
    );
  });

  test("refuses a permission name a newer Electron adds", () => {
    const added = "some-new-permission" as BrowserPermission;
    expect(browserPermissionGranted(added, { isMainFrame: true })).toBe(false);
  });
});

describe("installBrowserPermissions", () => {
  const { check, request } = installedHandlers();

  test("checks report the policy", () => {
    expect(check(null, "notifications", "https://example.com/", { isMainFrame: true })).toBe(false);
    expect(check(null, "fullscreen", "https://example.com/", { isMainFrame: false })).toBe(true);
  });

  test("requests are answered with the policy, for the frame that asked", () => {
    const webContents = {} as Parameters<typeof request>[0];
    const page = { isMainFrame: true, requestingUrl: "https://example.com/" };
    const ad = { isMainFrame: false, requestingUrl: "https://ads.example/" };
    const callback = mock((_granted: boolean) => {});
    request(webContents, "geolocation", callback, page);
    request(webContents, "clipboard-sanitized-write", callback, page);
    request(webContents, "openExternal", callback, page);
    request(webContents, "openExternal", callback, ad);
    expect(callback.mock.calls).toEqual([[false], [true], [true], [false]]);
  });

  test("the camera and microphone are decided by the media module", () => {
    const webContents = {} as Parameters<typeof request>[0];
    const details = { isMainFrame: true, mediaType: "video" as const };
    expect(check(webContents, "media", "https://meet.example/", details)).toBe(true);
    expect(mediaCheck).toHaveBeenCalledWith(webContents, "https://meet.example/", "video");
    const callback = mock((_granted: boolean) => {});
    const media = { isMainFrame: true, requestingUrl: "https://meet.example/", mediaTypes: [] };
    request(webContents, "media", callback, media);
    expect(mediaRequest).toHaveBeenCalledWith(webContents, media, callback);
    expect(callback).not.toHaveBeenCalled();
  });
});
