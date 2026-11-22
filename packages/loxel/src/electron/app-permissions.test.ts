import { describe, expect, test } from "bun:test";

import type { PermissionCheckHandlerHandlerDetails, Session } from "electron";

import { installAppPermissions } from "./app-permissions";

type CheckHandler = NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;
type RequestHandler = NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>;
type Permission = Parameters<CheckHandler>[1];

const APP = "http://127.0.0.1:4000";

function install(): { check: CheckHandler; request: RequestHandler } {
  let check: CheckHandler | null = null;
  let request: RequestHandler | null = null;
  installAppPermissions(
    {
      setPermissionCheckHandler: (handler) => {
        check = handler;
      },
      setPermissionRequestHandler: (handler) => {
        request = handler;
      },
    },
    (url) => URL.parse(url)?.origin === APP,
  );
  if (!check || !request) throw new Error("both handlers must be installed");
  return { check, request };
}

const { check, request } = install();

function checked(
  permission: Permission,
  origin: string,
  details: Partial<PermissionCheckHandlerHandlerDetails> = {},
): boolean {
  return check(null, permission, origin, { isMainFrame: true, ...details });
}

function requested(permission: Permission, requestingUrl: string, isMainFrame = true): boolean {
  let granted: boolean | undefined;
  request(
    // The handler doesn't read the webContents.
    null as unknown as Parameters<RequestHandler>[0],
    permission,
    (answer) => {
      granted = answer;
    },
    { requestingUrl, isMainFrame },
  );
  if (granted === undefined) throw new Error("the request must be answered at once");
  return granted;
}

const APP_PAGE: Permission[] = [
  "local-fonts",
  "clipboard-sanitized-write",
  "clipboard-read",
  "fullscreen",
  "fileSystem",
];
const REFUSED: Permission[] = [
  "openExternal",
  "media",
  "geolocation",
  "notifications",
  "midi",
  "pointerLock",
  "deprecated-sync-clipboard-read",
];

describe("installAppPermissions", () => {
  test("gives the app's page the permissions it uses", () => {
    for (const permission of APP_PAGE) {
      expect(checked(permission, `${APP}/`)).toBe(true);
      // As Electron reports the app's main frame.
      expect(checked(permission, `${APP}/`, { embeddingOrigin: `${APP}/` })).toBe(true);
      expect(requested(permission, `${APP}/?window=1`)).toBe(true);
    }
  });

  test("refuses the app's page every other permission", () => {
    for (const permission of REFUSED) {
      expect(checked(permission, `${APP}/`, { embeddingOrigin: `${APP}/` })).toBe(false);
      expect(requested(permission, `${APP}/`)).toBe(false);
    }
  });

  test("refuses other origins and frames of other origins inside the app", () => {
    for (const permission of APP_PAGE) {
      expect(checked(permission, "https://example.com")).toBe(false);
      const framed = { isMainFrame: false, embeddingOrigin: `${APP}/` };
      expect(checked(permission, "https://example.com/", framed)).toBe(false);
      expect(requested(permission, "https://example.com/", false)).toBe(false);
      expect(requested(permission, "https://example.com/")).toBe(false);
    }
    expect(requested("openExternal", "about:srcdoc", false)).toBe(false);
  });

  test("refuses frames at the app's origin that aren't its page", () => {
    // A media frame is at the app's URL, with the app's origin or an opaque one.
    const framed = { isMainFrame: false, embeddingOrigin: `${APP}/` };
    // The app framed by another origin.
    const framing = { isMainFrame: false, embeddingOrigin: "https://example.com/" };
    for (const permission of APP_PAGE) {
      expect(requested(permission, `${APP}/api/media-frame`, false)).toBe(false);
      if (permission === "fileSystem") continue;
      expect(checked(permission, `${APP}/`, framed)).toBe(false);
      expect(checked(permission, `${APP}/`, framing)).toBe(false);
    }
  });

  test("checks `fileSystem` by origin, as Electron checks a grant with no frame", () => {
    expect(checked("fileSystem", `${APP}/`, { isMainFrame: false })).toBe(true);
    expect(checked("fileSystem", "https://example.com/", { isMainFrame: false })).toBe(false);
    // The request that grants it names its frame.
    expect(requested("fileSystem", `${APP}/api/media-frame`, false)).toBe(false);
  });
});
