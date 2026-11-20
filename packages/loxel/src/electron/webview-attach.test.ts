import { describe, expect, mock, test } from "bun:test";

import type { WebPreferences } from "electron";

void mock.module("electron", () => ({ BrowserWindow: {}, ipcMain: { on: () => {} } }));

const { BROWSER_PARTITION } = await import("./browser-partition");
const { secureWebviewAttach } = await import("./webview-attach");

/** Everything an element (or a compromised window renderer) could ask a webview for. */
const asked = (): WebPreferences => ({
  partition: "persist:other",
  preload: "/tmp/evil.js",
  nodeIntegration: true,
  nodeIntegrationInWorker: true,
  contextIsolation: false,
  sandbox: false,
  webSecurity: false,
  allowRunningInsecureContent: true,
  webviewTag: true,
  experimentalFeatures: true,
  enableBlinkFeatures: "SomeFeature",
  plugins: true,
  navigateOnDragDrop: true,
});

describe("secureWebviewAttach", () => {
  test("forces the browser partition, Loxel's sandboxed preload and secure preferences", () => {
    const webPreferences = asked();
    expect(secureWebviewAttach(webPreferences, { src: "about:blank" })).toBe(true);
    expect(webPreferences).toMatchObject({
      partition: BROWSER_PARTITION,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      experimentalFeatures: false,
      plugins: false,
      navigateOnDragDrop: false,
    });
    expect(webPreferences.preload).toEndWith("/webview-preload.cjs");
    expect(webPreferences).not.toHaveProperty("enableBlinkFeatures");
    expect(webPreferences.disableBlinkFeatures).toBe("CameraAndMicrophoneElements");
  });

  test("attaches webviews that start blank or on a web page only", () => {
    const attaches = (src: string | undefined) => secureWebviewAttach(asked(), { src });
    expect(attaches("about:blank")).toBe(true);
    expect(attaches("https://example.com/")).toBe(true);
    expect(attaches("http://localhost:5173/")).toBe(true);
    expect(attaches("view-source:https://example.com/")).toBe(true);
    for (const src of [
      "file:///etc/passwd",
      "data:text/html,<p>hi</p>",
      "javascript:alert(1)",
      "view-source:file:///etc/passwd",
      "about:srcdoc",
      "chrome://gpu",
      "",
      undefined,
    ]) {
      expect(attaches(src)).toBe(false);
    }
  });
});
