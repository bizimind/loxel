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

/** A request from a frame showing `requestingUrl` in a window showing `pageUrl`. */
function requested(
  permission: Permission,
  requestingUrl: string,
  { isMainFrame = true, pageUrl = `${APP}/` } = {},
): boolean {
  let granted: boolean | undefined;
  request(
    // The handler reads only the page's URL.
    { getURL: () => pageUrl } as unknown as Parameters<RequestHandler>[0],
    permission,
    (answer) => {
      granted = answer;
    },
    { requestingUrl, isMainFrame },
  );
  if (granted === undefined) throw new Error("the request must be answered at once");
  return granted;
}

const PAGE_ONLY: Permission[] = ["local-fonts", "clipboard-read", "fileSystem"];
const ALL_FRAMES: Permission[] = ["clipboard-sanitized-write", "fullscreen"];
const REFUSED: Permission[] = [
  "openExternal",
  "media",
  "geolocation",
  "notifications",
  "midi",
  "pointerLock",
  "automatic-fullscreen",
  "deprecated-sync-clipboard-read",
];

/** A frame of another origin inside the app's page. */
const EMBED = "https://example.com/";

describe("installAppPermissions", () => {
  test("gives the app's page the permissions it uses", () => {
    for (const permission of [...PAGE_ONLY, ...ALL_FRAMES]) {
      // As Electron reports the app's main frame.
      expect(checked(permission, `${APP}/`, { embeddingOrigin: `${APP}/` })).toBe(true);
      expect(requested(permission, `${APP}/?window=1`)).toBe(true);
    }
  });

  test("refuses the app's page and its frames every other permission", () => {
    for (const permission of REFUSED) {
      expect(checked(permission, `${APP}/`, { embeddingOrigin: `${APP}/` })).toBe(false);
      expect(requested(permission, `${APP}/`)).toBe(false);
      const framed = { isMainFrame: false, embeddingOrigin: `${APP}/` };
      expect(checked(permission, EMBED, framed)).toBe(false);
      expect(requested(permission, EMBED, { isMainFrame: false })).toBe(false);
    }
    expect(requested("openExternal", "about:srcdoc", { isMainFrame: false })).toBe(false);
  });

  test("keeps the page's own permissions from frames inside it, even at its URL", () => {
    const framed = { isMainFrame: false, embeddingOrigin: `${APP}/` };
    for (const permission of PAGE_ONLY) {
      expect(requested(permission, EMBED, { isMainFrame: false })).toBe(false);
      // A media frame is at the app's URL, with the app's origin or an opaque one.
      expect(requested(permission, `${APP}/api/media-frame`, { isMainFrame: false })).toBe(false);
      expect(checked(permission, EMBED, framed)).toBe(false);
      if (permission === "fileSystem") continue;
      expect(checked(permission, `${APP}/`, framed)).toBe(false);
    }
  });

  test("gives frames inside the app's page the copy and fullscreen buttons browsers give", () => {
    const framed = { isMainFrame: false, embeddingOrigin: `${APP}/` };
    for (const permission of ALL_FRAMES) {
      expect(checked(permission, EMBED, framed)).toBe(true);
      expect(requested(permission, EMBED, { isMainFrame: false })).toBe(true);
    }
  });

  test("refuses everything to pages other than the app's", () => {
    for (const permission of [...PAGE_ONLY, ...ALL_FRAMES]) {
      expect(checked(permission, EMBED, { embeddingOrigin: EMBED })).toBe(false);
      expect(requested(permission, EMBED, { pageUrl: EMBED })).toBe(false);
      // The app framed by another origin.
      const framing = { isMainFrame: false, embeddingOrigin: EMBED };
      if (permission !== "fileSystem") expect(checked(permission, `${APP}/`, framing)).toBe(false);
      expect(requested(permission, `${APP}/`, { isMainFrame: false, pageUrl: EMBED })).toBe(false);
    }
  });

  test("checks `fileSystem` by origin, as Electron checks a grant with no frame", () => {
    expect(checked("fileSystem", `${APP}/`, { isMainFrame: false })).toBe(true);
    expect(checked("fileSystem", EMBED, { isMainFrame: false })).toBe(false);
  });
});
