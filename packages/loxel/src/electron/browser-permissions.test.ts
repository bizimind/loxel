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
/** What the module for links to other apps was handed, standing in for `browser-external-apps.ts`. */
const openExternal = mock((..._args: unknown[]) => {});
const askers = { media: { check: mediaCheck, request: mediaRequest }, openExternal };

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
    askers,
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
  keyboardLock: false,
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
  openExternal: false,
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
    browserPermissionGranted(permission, { isMainFrame, inBrowserPanel: true }),
  ]);

describe("browserPermissionGranted", () => {
  test("decides every permission for a page's own frame", () => {
    expect(decisions(true)).toEqual(PERMISSIONS.map((p) => [p, MAIN_FRAME[p]]));
  });

  test("embedded frames get the same", () => {
    expect(decisions(false)).toEqual(PERMISSIONS.map((p) => [p, MAIN_FRAME[p]]));
  });

  test("popup windows get neither fullscreen nor pointer lock, having no panel to name the site", () => {
    const popup = { isMainFrame: true, inBrowserPanel: false };
    expect(browserPermissionGranted("fullscreen", popup)).toBe(false);
    expect(browserPermissionGranted("pointerLock", popup)).toBe(false);
    expect(browserPermissionGranted("clipboard-sanitized-write", popup)).toBe(true);
  });

  test("refuses a permission name a newer Electron adds", () => {
    const added = "some-new-permission" as BrowserPermission;
    expect(browserPermissionGranted(added, { isMainFrame: true, inBrowserPanel: true })).toBe(
      false,
    );
  });
});

describe("installBrowserPermissions", () => {
  const { check, request } = installedHandlers();

  test("checks report the policy", () => {
    const panel = { getType: () => "webview" } as Parameters<typeof check>[0];
    expect(check(panel, "notifications", "https://example.com/", { isMainFrame: true })).toBe(
      false,
    );
    expect(check(panel, "fullscreen", "https://example.com/", { isMainFrame: false })).toBe(true);
    expect(check(null, "fullscreen", "https://example.com/", { isMainFrame: false })).toBe(false);
  });

  test("requests are answered with the policy, for the frame that asked", () => {
    const webContents = { getType: () => "webview" } as Parameters<typeof request>[0];
    const page = { isMainFrame: true, requestingUrl: "https://example.com/" };
    const callback = mock((_granted: boolean) => {});
    request(webContents, "geolocation", callback, page);
    request(webContents, "clipboard-sanitized-write", callback, page);
    expect(callback.mock.calls).toEqual([[false], [true]]);
  });

  test("links to other apps are decided by their module, and their grants reported first", () => {
    const events: string[] = [];
    let handler: RequestHandler = null;
    installBrowserPermissions(
      {
        setPermissionCheckHandler: () => {},
        setPermissionRequestHandler: (installed) => {
          handler = installed;
        },
      },
      askers,
      (_webContents, permission) => events.push(`granted ${permission}`),
    );
    if (!handler) throw new Error("installBrowserPermissions set no request handler");
    const webContents = { getType: () => "webview" } as Parameters<typeof request>[0];
    const link = {
      isMainFrame: true,
      requestingUrl: "https://zoom.example/",
      externalURL: "zoommtg://zoom.example/join",
    };
    (handler as NonNullable<RequestHandler>)(
      webContents,
      "openExternal",
      (granted) => {
        events.push(`answered ${granted}`);
      },
      link,
    );
    expect(openExternal).toHaveBeenCalledWith(webContents, link, expect.any(Function));
    expect(events).toEqual([]);
    const answer = openExternal.mock.calls.at(-1)![2] as (granted: boolean) => void;
    answer(true);
    expect(events).toEqual(["granted openExternal", "answered true"]);
  });

  test("the camera and microphone are decided by the media module", () => {
    const webContents = { getType: () => "webview" } as Parameters<typeof request>[0];
    const details = { isMainFrame: true, mediaType: "video" as const };
    expect(check(webContents, "media", "https://meet.example/", details)).toBe(true);
    expect(mediaCheck).toHaveBeenCalledWith(webContents, "https://meet.example/", "video");
    const callback = mock((_granted: boolean) => {});
    const media = { isMainFrame: true, requestingUrl: "https://meet.example/", mediaTypes: [] };
    request(webContents, "media", callback, media);
    expect(mediaRequest).toHaveBeenCalledWith(webContents, media, expect.any(Function));
    expect(callback).not.toHaveBeenCalled();
    // The media module's answer reaches the page through the same callback.
    const answer = mediaRequest.mock.calls[0]![2] as (granted: boolean) => void;
    answer(true);
    expect(callback).toHaveBeenCalledWith(true);
    // A `<usermedia>` element's request names no media types, and goes there too.
    const element = { isMainFrame: true, requestingUrl: "https://meet.example/" };
    request(webContents, "media", callback, element);
    expect(mediaRequest).toHaveBeenLastCalledWith(webContents, element, expect.any(Function));
  });

  test("grants are reported, with the frame that asked, before they take effect", () => {
    const events: string[] = [];
    let request: RequestHandler = null;
    installBrowserPermissions(
      {
        setPermissionCheckHandler: () => {},
        setPermissionRequestHandler: (handler) => {
          request = handler;
        },
      },
      askers,
      (_webContents, permission, requestingUrl) => events.push(`${permission} ${requestingUrl}`),
    );
    if (!request) throw new Error("installBrowserPermissions set no request handler");
    const handler: NonNullable<RequestHandler> = request;
    const webContents = { getType: () => "webview" } as Parameters<typeof handler>[0];
    const frame = { isMainFrame: false, requestingUrl: "https://video.example/embed" };
    const callback = (granted: boolean) => events.push(`answered ${granted}`);
    handler(webContents, "fullscreen", callback, frame);
    handler(webContents, "geolocation", callback, frame);
    expect(events).toEqual([
      "fullscreen https://video.example/embed",
      "answered true",
      "answered false",
    ]);
    // A camera grant, answered later by the media module, is reported before it too.
    const media = { isMainFrame: true, requestingUrl: "https://meet.example/", mediaTypes: [] };
    handler(webContents, "media", callback, media);
    const answer = mediaRequest.mock.calls.at(-1)![2] as (granted: boolean) => void;
    answer(true);
    expect(events.slice(3)).toEqual(["media https://meet.example/", "answered true"]);
  });
});
