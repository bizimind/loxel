import { describe, expect, test } from "bun:test";

import type { PermissionCheckHandlerHandlerDetails } from "electron";

import { localFontsCheckHandler } from "./local-fonts-permission";

const APP = "http://127.0.0.1:4000";

function check(
  handler: ReturnType<typeof localFontsCheckHandler>,
  permission: Parameters<typeof handler>[1],
  origin: string,
  details: Partial<PermissionCheckHandlerHandlerDetails> = {},
): boolean {
  return handler(null, permission, origin, { isMainFrame: true, ...details });
}

describe("localFontsCheckHandler", () => {
  const appWindow = localFontsCheckHandler((origin) => new URL(origin).origin === APP);
  const browserPanels = localFontsCheckHandler(() => false);

  test("lets the app's own origin list fonts", () => {
    expect(check(appWindow, "local-fonts", `${APP}/`)).toBe(true);
    // As Electron reports the app's main frame.
    expect(check(appWindow, "local-fonts", `${APP}/`, { embeddingOrigin: `${APP}/` })).toBe(true);
  });

  test("refuses other origins and cross-origin frames inside the app", () => {
    expect(check(appWindow, "local-fonts", "https://example.com")).toBe(false);
    // A frame of another origin in the app, and the app framed by another origin.
    const framed = { isMainFrame: false, embeddingOrigin: `${APP}/` };
    expect(check(appWindow, "local-fonts", "https://example.com/", framed)).toBe(false);
    const framing = { isMainFrame: false, embeddingOrigin: "https://example.com/" };
    expect(check(appWindow, "local-fonts", `${APP}/`, framing)).toBe(false);
  });

  test("browser panels never list fonts", () => {
    expect(check(browserPanels, "local-fonts", `${APP}/`)).toBe(false);
    expect(check(browserPanels, "local-fonts", "https://example.com")).toBe(false);
  });

  test("answers other permissions as Electron does without a check handler", () => {
    expect(check(browserPanels, "clipboard-sanitized-write", "https://example.com")).toBe(true);
    expect(check(appWindow, "deprecated-sync-clipboard-read", `${APP}/`)).toBe(false);
  });
});
